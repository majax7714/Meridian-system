// ============================================================================
// BACKTESTING ENGINE v18.1.0
// ============================================================================
// Replays MICRO + CROSS_ASSET + synthetic TICK scoring against historical data.
//   1. Validate signal quality by score bucket
//   2. Calibrate cross-asset and tick signal weights
//   3. Recommend threshold adjustments
//
// Usage:
//   node src/backtesting/backtest.js
//   node src/backtesting/backtest.js --bars=2000 --interval=5m
//
// Score components replayed:
//   MICRO:       5m trend strength (0-12) + 15m alignment (0/8) + volume (0/5) + VWAP (0/3/4)
//   CROSS_ASSET: NQ alignment (-4 to +8) + risk sentiment (-5 to +6)
//   TICK (synth): bar order flow alignment (0/+6) + 3-bar momentum (0/+4) + delta divergence (0/-3)
//   Total range: approx -12 to +53 pts
//
// Trade simulation per setup:
//   Entry  = bar close
//   Stop   = vol-proportional (computeRealizedVol × SCALP_DIVISOR)
//   Target = 2× stop  →  2:1 R:R
//   Scan   = next 60 bars to see which level hits first
// ============================================================================

const topstepx   = require('../api/topstepx');
const CrossAsset = require('../engine/cross-asset');
const RealizedVol = require('../engine/realized-volatility');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args    = Object.fromEntries(process.argv.slice(2).map(a => a.replace('--','').split('=')));
const BARS    = parseInt(args.bars    || '2000', 10);
const INTERVAL = args.interval || '5m';
const TICK_VALUE = 1.25;   // MES $1.25 per tick
const TICK_SIZE  = 0.25;

// ─── Inline micro scoring helpers ─────────────────────────────────────────────
// (mirrors scalping-intelligence.js logic, self-contained for the backtester)

function trendStrength(bars, lookback) {
  if (!bars || bars.length < lookback) return { direction: 'NEUTRAL', strength: 0 };
  const latest = bars[0];
  const oldest = bars[lookback - 1];
  const movePct = ((latest.close - oldest.close) / oldest.close) * 100;
  let consecutive = 0;
  for (let i = 0; i < lookback - 1; i++) {
    const dir = bars[i].close > bars[i + 1].close ? 'UP' : 'DOWN';
    if (dir === (movePct > 0 ? 'UP' : 'DOWN')) consecutive++;
  }
  const strength = Math.min(Math.abs(movePct) * 20, 60) + (consecutive / (lookback - 1)) * 40;
  const direction = Math.abs(movePct) < 0.05 ? 'NEUTRAL' : movePct > 0 ? 'BULLISH' : 'BEARISH';
  return { direction, strength };
}

function vwapSignal(bars) {
  if (!bars || bars.length < 12) return 'NEUTRAL';
  let sumPV = 0, sumV = 0;
  for (let i = 0; i < 12; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    sumPV += tp * bars[i].volume;
    sumV  += bars[i].volume;
  }
  if (sumV === 0) return 'NEUTRAL';
  const vwap  = sumPV / sumV;
  let sumSqD = 0;
  for (let i = 0; i < 12; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    sumSqD += Math.pow(tp - vwap, 2) * bars[i].volume;
  }
  const std  = Math.sqrt(sumSqD / sumV);
  const z    = std > 0 ? (bars[0].close - vwap) / std : 0;
  const pct  = ((bars[0].close - vwap) / vwap) * 100;
  if (Math.abs(z) > 2)        return 'FADE_TO_VWAP';
  if (Math.abs(pct) > 0.1)    return 'TREND_BIAS';
  return 'NEUTRAL';
}

function volumeRatio(bars) {
  if (!bars || bars.length < 24) return 1.0;
  const recent = bars.slice(0, 12).reduce((s, b) => s + b.volume, 0) / 12;
  const prior  = bars.slice(12, 24).reduce((s, b) => s + b.volume, 0) / 12;
  return prior > 0 ? recent / prior : 1.0;
}

// ─── Synthetic TICK layer ─────────────────────────────────────────────────────

/**
 * Approximate TICK layer score from 5m bar data.
 * Fills the gap between backtest scores and live scores where 1s bars/quote buffer
 * would normally contribute 0–30 pts. This synthetic version adds 0–10 pts.
 *
 * Rules:
 *   +6  bar close vs open aligns with trade direction (order flow proxy)
 *   +4  3 consecutive bars agree in direction (momentum proxy)
 *   -3  bar close opposes direction with >0.15% move (delta divergence proxy)
 */
function syntheticTickScore(bars5m, direction) {
  if (!bars5m || bars5m.length < 3) return 0;

  let score = 0;

  // Order flow proxy: current bar's close vs open
  const bar0 = bars5m[0];
  const barMovePct = bar0.open > 0 ? (bar0.close - bar0.open) / bar0.open * 100 : 0;
  const barBullish = barMovePct > 0;

  if (Math.abs(barMovePct) > 0.15) {
    if ((barBullish && direction === 'LONG') || (!barBullish && direction === 'SHORT')) {
      score += 6; // order flow aligns
    } else if (Math.abs(barMovePct) > 0.3) {
      score -= 3; // strong delta divergence
    }
  }

  // Momentum proxy: 3 consecutive bars moving in same direction (newest-first)
  const momUp   = bars5m[0].close > bars5m[1].close && bars5m[1].close > bars5m[2].close;
  const momDown = bars5m[0].close < bars5m[1].close && bars5m[1].close < bars5m[2].close;
  if ((momUp && direction === 'LONG') || (momDown && direction === 'SHORT')) {
    score += 4;
  }

  return score;
}

// ─── Cross-asset bar alignment ─────────────────────────────────────────────────

/**
 * From a Yahoo oldest-first bars array, extract up to `count` bars ending at
 * or just before `targetTs` (epoch ms), returned newest-first.
 * Handles market-hour gaps (Yahoo futures bars match market hours).
 */
function alignedBars(barsOldestFirst, targetTs, count) {
  // Find the index of the bar closest to targetTs (without exceeding it)
  let idx = -1;
  for (let i = 0; i < barsOldestFirst.length; i++) {
    if (barsOldestFirst[i].ts <= targetTs) idx = i;
    else break;
  }
  if (idx < 0) return [];
  const slice = barsOldestFirst.slice(Math.max(0, idx - count + 1), idx + 1);
  return slice.reverse(); // newest-first
}

// ─── Trade outcome simulation ─────────────────────────────────────────────────

/**
 * Simulate outcome for a trade entered at esBars[i] (oldest-first).
 * Scans next `horizon` bars to see if stop or target is hit first.
 * Returns { outcome: 'WIN'|'LOSS'|'TIMEOUT', pnl, stopTicks, targetTicks }
 */
function simulateOutcome(esBarsOF, i, direction, sigma, horizon = 60) {
  const currentPrice = esBarsOF[i].close;
  const stops = RealizedVol.volProportionalStops(sigma, currentPrice, TICK_SIZE);
  const { stopTicks, targetTicks } = stops;

  const stopPts   = stopTicks   * TICK_SIZE;
  const targetPts = targetTicks * TICK_SIZE;

  const stopPrice   = direction === 'LONG' ? currentPrice - stopPts  : currentPrice + stopPts;
  const targetPrice = direction === 'LONG' ? currentPrice + targetPts : currentPrice - targetPts;

  for (let j = i + 1; j < Math.min(i + horizon + 1, esBarsOF.length); j++) {
    const bar = esBarsOF[j];
    if (direction === 'LONG') {
      if (bar.low  <= stopPrice)   return { outcome: 'LOSS',    pnl: -(stopTicks   * TICK_VALUE), stopTicks, targetTicks };
      if (bar.high >= targetPrice) return { outcome: 'WIN',     pnl:  (targetTicks * TICK_VALUE), stopTicks, targetTicks };
    } else {
      if (bar.high >= stopPrice)   return { outcome: 'LOSS',    pnl: -(stopTicks   * TICK_VALUE), stopTicks, targetTicks };
      if (bar.low  <= targetPrice) return { outcome: 'WIN',     pnl:  (targetTicks * TICK_VALUE), stopTicks, targetTicks };
    }
  }
  return { outcome: 'TIMEOUT', pnl: 0, stopTicks, targetTicks };
}

// ─── Score → bucket ────────────────────────────────────────────────────────────

function scoreBucket(score) {
  if (score < 0)   return '< 0';
  if (score < 5)   return '0–5';
  if (score < 10)  return '5–10';
  if (score < 15)  return '10–15';
  if (score < 20)  return '15–20';
  if (score < 25)  return '20–25';
  if (score < 30)  return '25–30';
  if (score < 35)  return '30–35';
  if (score < 40)  return '35–40';
  if (score < 45)  return '40–45';
  if (score < 55)  return '45–55';
  return '55+';
}

// ─── Table printer ────────────────────────────────────────────────────────────

function printCalibrationTable(results) {
  const BUCKET_ORDER = ['< 0', '0–5', '5–10', '10–15', '15–20', '20–25', '25–30', '30–35', '35–40', '40–45', '45–55', '55+'];

  const cols = {
    bucket:   14,
    trades:    7,
    wins:      6,
    losses:    7,
    timeouts:  9,
    winRate:   9,
    avgPnL:   10,
    totalPnL:  11,
    rec:       16
  };

  const header =
    'Score Bucket'.padEnd(cols.bucket) +
    'Trades'.padStart(cols.trades) +
    'Wins'.padStart(cols.wins) +
    'Losses'.padStart(cols.losses) +
    'Timeouts'.padStart(cols.timeouts) +
    'Win Rate'.padStart(cols.winRate) +
    'Avg P&L'.padStart(cols.avgPnL) +
    'Total P&L'.padStart(cols.totalPnL) +
    'Recommendation'.padStart(cols.rec);

  const divider = '─'.repeat(header.length);

  console.log('\n' + divider);
  console.log(header);
  console.log(divider);

  for (const bucket of BUCKET_ORDER) {
    const r = results[bucket];
    if (!r || r.trades === 0) continue;

    const winRate  = r.wins / r.trades;
    const avgPnL   = r.totalPnL / r.trades;
    const rec      = winRate >= 0.55 && r.trades >= 10 ? '✅ TRADE'  :
                     winRate >= 0.50 && r.trades >= 10 ? '⚠ MARGINAL' : '❌ SKIP';

    console.log(
      bucket.padEnd(cols.bucket) +
      String(r.trades).padStart(cols.trades) +
      String(r.wins).padStart(cols.wins) +
      String(r.losses).padStart(cols.losses) +
      String(r.timeouts).padStart(cols.timeouts) +
      (winRate * 100).toFixed(1).padStart(cols.winRate - 1) + '%' +
      ('$' + avgPnL.toFixed(2)).padStart(cols.avgPnL) +
      ('$' + r.totalPnL.toFixed(2)).padStart(cols.totalPnL) +
      rec.padStart(cols.rec)
    );
  }

  console.log(divider);
}

function printSubGroupTable(label, results) {
  console.log(`\n── ${label} ──`);
  printCalibrationTable(results);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  BACKTEST ENGINE v18.1.0  —  ${BARS} × ${INTERVAL} ES bars  (MICRO + CA + TICK-synthetic)`);
  console.log(`${'='.repeat(70)}\n`);

  // ── 1. Fetch ES historical bars ─────────────────────────────────────────────
  console.log('[Backtest] Fetching ES historical bars...');
  let esBarsOF; // oldest-first
  try {
    esBarsOF = await topstepx.fetchHistoricalRange({ interval: INTERVAL, count: BARS });
  } catch (err) {
    console.error('[Backtest] Failed to fetch ES bars:', err.message);
    process.exit(1);
  }
  console.log(`[Backtest] ✅ ${esBarsOF.length} ES bars (oldest: ${esBarsOF[0]?.time?.substring(0,16)}, newest: ${esBarsOF[esBarsOF.length-1]?.time?.substring(0,16)})`);

  if (esBarsOF.length < 80) {
    console.error('[Backtest] Not enough bars for meaningful backtest (need ≥80)');
    process.exit(1);
  }

  // ── 2. Fetch Yahoo historical bars (5-day 5m for cross-asset) ──────────────
  console.log('[Backtest] Fetching cross-asset historical bars (Yahoo Finance)...');
  const SYMBOLS = { nq: 'NQ%3DF', gold: 'GC%3DF', btc: 'BTC-USD', oil: 'CL%3DF' };

  const yahooFetch = (sym, key) => {
    try {
      return Promise.resolve(CrossAsset.fetchYahooHistorical(sym, key, '5m', '5d'));
    } catch (err) {
      console.warn(`[Backtest] ${key} fetch failed:`, err.message);
      return Promise.resolve([]);
    }
  };

  const [nqOF, goldOF, btcOF, oilOF] = await Promise.all([
    yahooFetch(SYMBOLS.nq,   'nq'),
    yahooFetch(SYMBOLS.gold, 'gold'),
    yahooFetch(SYMBOLS.btc,  'btc'),
    yahooFetch(SYMBOLS.oil,  'oil'),
  ]);

  const caAvail = { nq: nqOF.length > 5, gold: goldOF.length > 5, btc: btcOF.length > 5, oil: oilOF.length > 5 };
  console.log('[Backtest] Cross-asset availability:', caAvail);

  const anyCA = Object.values(caAvail).some(Boolean);

  // ── 3. Replay loop ──────────────────────────────────────────────────────────
  const MIN_LOOKBACK = 60;  // need 60 past bars for indicators
  const WARMUP_SKIP  = 5;   // skip first 5 bars after a signal to reduce correlation

  let lastTradeBar = -1;
  const allResults      = {};  // all setups
  const microOnlyResults = {}; // setups where CA data was unavailable
  const withCAResults   = {};  // setups where CA data was available

  let processed = 0;
  let skipped = 0;

  console.log(`[Backtest] Replaying ${esBarsOF.length - MIN_LOOKBACK} bar positions...`);

  for (let i = MIN_LOOKBACK; i < esBarsOF.length - 1; i++) {
    // Space out trades to avoid over-fitting on correlated bars
    if (i - lastTradeBar < WARMUP_SKIP) { skipped++; continue; }

    const bar = esBarsOF[i];
    if (!bar.close || bar.close <= 0) continue;

    // Build newest-first windows for indicators
    const bars5m  = esBarsOF.slice(Math.max(0, i - 59), i + 1).reverse();
    const bars15m = esBarsOF.slice(Math.max(0, i - 39), i + 1).reverse();

    if (bars5m.length < 24) continue;

    // MICRO scoring
    const t5   = trendStrength(bars5m, 12);
    const t15  = trendStrength(bars15m, 8);
    const vr   = volumeRatio(bars5m);
    const vsig = vwapSignal(bars5m);

    // Determine direction from trends only
    const bull = (t5.direction === 'BULLISH' ? 1 : 0) + (t15.direction === 'BULLISH' ? 1 : 0);
    const bear = (t5.direction === 'BEARISH' ? 1 : 0) + (t15.direction === 'BEARISH' ? 1 : 0);
    if (bull === bear) continue; // no clear direction

    const direction = bull > bear ? 'LONG' : 'SHORT';

    let microScore = (t5.strength / 100) * 12;
    if (t5.direction === t15.direction) microScore += 8;
    if (vr > 1.2)                       microScore += 5;
    if (vsig === 'TREND_BIAS')          microScore += 4;
    else if (vsig === 'FADE_TO_VWAP')   microScore += 3;

    // Realized vol for stops
    const sigma = RealizedVol.computeRealizedVol(bars5m, 20);

    // Cross-asset scoring
    let caScore = 0;
    let caAvailable = false;

    if (anyCA) {
      const ts = bar.ts;
      const nqBars   = nqOF.length   > 5 ? alignedBars(nqOF,   ts, 60) : [];
      const goldBars = goldOF.length  > 5 ? alignedBars(goldOF, ts, 60) : [];
      const btcBars  = btcOF.length   > 5 ? alignedBars(btcOF,  ts, 60) : [];
      const oilBars  = oilOF.length   > 5 ? alignedBars(oilOF,  ts, 60) : [];

      if (nqBars.length > 5 || goldBars.length > 5) {
        caAvailable = true;
        const nqDiv    = CrossAsset.computeNQESDivergence(bars5m, nqBars);
        const riskSent = CrossAsset.computeRiskSentiment(bars5m, goldBars, btcBars, oilBars);
        const ca       = CrossAsset.computeCrossAssetScore(nqDiv, riskSent, direction);
        caScore = ca.score;
      }
    }

    const tickScore  = syntheticTickScore(bars5m, direction);
    const totalScore = microScore + caScore + tickScore;
    const bucket = scoreBucket(totalScore);

    // Simulate outcome
    const outcome = simulateOutcome(esBarsOF, i, direction, sigma);

    // Record in buckets
    [allResults, ...(caAvailable ? [withCAResults] : [microOnlyResults])].forEach(map => {
      if (!map[bucket]) map[bucket] = { trades: 0, wins: 0, losses: 0, timeouts: 0, totalPnL: 0 };
      map[bucket].trades++;
      if (outcome.outcome === 'WIN')     { map[bucket].wins++;     map[bucket].totalPnL += outcome.pnl; }
      if (outcome.outcome === 'LOSS')    { map[bucket].losses++;   map[bucket].totalPnL += outcome.pnl; }
      if (outcome.outcome === 'TIMEOUT') { map[bucket].timeouts++; }
    });

    processed++;
    lastTradeBar = i;
  }

  console.log(`[Backtest] ✅ Replayed ${processed} setups (${skipped} skipped for spacing)\n`);

  // ── 4. Print results ────────────────────────────────────────────────────────

  const totalTrades = Object.values(allResults).reduce((s, r) => s + r.trades, 0);
  const totalWins   = Object.values(allResults).reduce((s, r) => s + r.wins,   0);
  const totalPnL    = Object.values(allResults).reduce((s, r) => s + r.totalPnL, 0);

  console.log('═'.repeat(70));
  console.log('  ALL SETUPS — MICRO + CROSS_ASSET');
  printCalibrationTable(allResults);

  if (Object.keys(withCAResults).length > 0) {
    printSubGroupTable('WITH CROSS-ASSET DATA', withCAResults);
  }
  if (Object.keys(microOnlyResults).length > 0) {
    printSubGroupTable('MICRO ONLY (no CA data)', microOnlyResults);
  }

  // ── 5. Summary & recommendations ────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total setups:      ${totalTrades}`);
  console.log(`  Total wins:        ${totalWins}  (${totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : '0.0'}%)`);
  console.log(`  Total P&L:         $${totalPnL.toFixed(2)}`);
  console.log(`  Bars analysed:     ${esBarsOF.length}`);

  // Optimal threshold: find the score cutoff where win rate crosses 55%
  const BUCKET_ORDER = ['< 0', '0–5', '5–10', '10–15', '15–20', '20–25', '25–30', '30–35', '35–40', '40–45', '45–55', '55+'];
  let cumulTrades = 0, cumulWins = 0, cumulPnL = 0;
  let recommendedThreshold = null;
  console.log('\n  Cumulative stats above threshold:');
  console.log('  ' + 'Threshold'.padEnd(12) + 'Trades'.padEnd(9) + 'WinRate'.padEnd(10) + 'CumPnL');

  for (let bi = BUCKET_ORDER.length - 1; bi >= 0; bi--) {
    const b = BUCKET_ORDER[bi];
    const r = allResults[b];
    if (!r) continue;
    cumulTrades += r.trades;
    cumulWins   += r.wins;
    cumulPnL    += r.totalPnL;
    if (cumulTrades < 5) continue;
    const wr = cumulWins / cumulTrades;
    console.log(`  ≥ ${b.padEnd(9)} ${String(cumulTrades).padEnd(9)} ${(wr * 100).toFixed(1).padEnd(9)}% $${cumulPnL.toFixed(2)}`);
    if (wr >= 0.55 && recommendedThreshold === null) {
      recommendedThreshold = b;
    }
  }

  if (recommendedThreshold) {
    console.log(`\n  ✅ RECOMMENDED THRESHOLD: score ≥ ${recommendedThreshold}`);
    console.log(`     (First bucket where cumulative win rate ≥ 55%)`);
  } else {
    console.log('\n  ⚠  No bucket reached 55% win rate — consider reviewing signal logic or fetching more data');
  }

  console.log('\n  Note: This backtest covers MICRO + CROSS_ASSET layers only (~43 pts max).');
  console.log('  Full live system adds MACRO (~15 pts), FUTURES (~25 pts), TICK (~30 pts),');
  console.log('  and EXECUTION (~18 pts). Live scores will be higher — adjust thresholds accordingly.');
  console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
  console.error('[Backtest] Fatal error:', err);
  process.exit(1);
});
