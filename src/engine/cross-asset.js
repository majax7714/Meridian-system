// ============================================================================
// CROSS-ASSET CORRELATION ENGINE v18.0.0
// ============================================================================
// Cross-group signals for ES/MES scalping:
//   NQ=F   — Nasdaq-100 futures    (equity structure, tech vs broad)
//   GC=F   — Gold futures          (risk-off / safe-haven flow)
//   BTC-USD — Bitcoin              (speculative risk appetite)
//   CL=F   — Crude Oil futures     (macro/inflation signal)
//
// Academic basis:
//   - Equity index co-movement: Barberis et al. (2005) index inclusion effects
//   - Gold as safe haven: Baur & Lucey (2010)
//   - Crypto-equity co-movement: Bouri et al. (2020)
//   - Oil-equity link: Hamilton (2009), Kilian & Park (2009)
// ============================================================================

const { execSync } = require('child_process');
const db = require('../storage/db');

console.log('[CrossAsset] Loading cross-asset.js v18.0.0...');

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_BARS  = 5  * 60 * 1000;  // 5 min — intraday bars
const CACHE_TTL_PRICE = 5  * 60 * 1000;  // 5 min — spot prices

// Yahoo Finance symbols
const SYMBOLS = {
  nq:   'NQ%3DF',    // NQ=F  (URL-encoded)
  gold: 'GC%3DF',    // GC=F
  btc:  'BTC-USD',
  oil:  'CL%3DF'     // CL=F
};

// ─── Yahoo Finance Helpers ─────────────────────────────────────────────────

/**
 * Fetch intraday 5m bars from Yahoo Finance.
 * Returns array of { time, open, high, low, close, volume }, newest first.
 * 5-minute cache to avoid hammering Yahoo.
 */
function fetchYahooBars(symbol, cacheKey, count = 60) {
  const cKey = `${cacheKey}_bars`;
  const tKey = `${cacheKey}_bars_ts`;
  const cached    = db.getSetting(cKey);
  const cachedTs  = db.getSetting(tKey);

  if (cached && cachedTs && (Date.now() - cachedTs) < CACHE_TTL_BARS) {
    const bars = typeof cached === 'string' ? JSON.parse(cached) : cached;
    return bars.slice(0, count);
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`;
    const cmd = `curl -s -L -H 'User-Agent: Mozilla/5.0' '${url}'`;
    const raw  = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    const data = JSON.parse(raw);
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const times   = result.timestamp            || [];
    const q       = result.indicators?.quote?.[0] || {};
    const closes  = q.close   || [];
    const opens   = q.open    || [];
    const highs   = q.high    || [];
    const lows    = q.low     || [];
    const volumes = q.volume  || [];

    const bars = [];
    for (let i = 0; i < times.length; i++) {
      if (closes[i] == null) continue;
      bars.push({
        time:   new Date(times[i] * 1000).toISOString(),
        open:   opens[i]   ?? closes[i],
        high:   highs[i]   ?? closes[i],
        low:    lows[i]    ?? closes[i],
        close:  closes[i],
        volume: volumes[i] ?? 0
      });
    }

    // Reverse to newest-first (matches TopstepX convention)
    bars.reverse();

    db.setSetting(cKey, JSON.stringify(bars.slice(0, 120)));
    db.setSetting(tKey, Date.now());
    console.log(`[CrossAsset] ✅ ${cacheKey.toUpperCase()} bars fetched: ${bars.length}`);
    return bars.slice(0, count);

  } catch (err) {
    console.warn(`[CrossAsset] ${cacheKey} bars fetch failed (using cached):`, err.message);
    if (cached) {
      const bars = typeof cached === 'string' ? JSON.parse(cached) : cached;
      return bars.slice(0, count);
    }
    return [];
  }
}

/**
 * Fetch historical bars from Yahoo Finance for a longer date range.
 * Used by backtesting. interval: '5m'|'1h'|'1d'. range: '5d'|'1mo'|'60d'|'3mo'.
 * Returns oldest-first for backtest replay.
 */
function fetchYahooHistorical(symbol, cacheKey, interval, range) {
  const cKey = `${cacheKey}_hist_${interval}_${range}`;
  const tKey = `${cKey}_ts`;
  const cached   = db.getSetting(cKey);
  const cachedTs = db.getSetting(tKey);
  const HIST_TTL = 60 * 60 * 1000; // 1hr cache for historical data

  if (cached && cachedTs && (Date.now() - cachedTs) < HIST_TTL) {
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const cmd = `curl -s -L -H 'User-Agent: Mozilla/5.0' '${url}'`;
    const raw  = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(raw);
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const times   = result.timestamp               || [];
    const q       = result.indicators?.quote?.[0]  || [];
    const closes  = q.close   || [];
    const opens   = q.open    || [];
    const highs   = q.high    || [];
    const lows    = q.low     || [];
    const volumes = q.volume  || [];

    const bars = [];
    for (let i = 0; i < times.length; i++) {
      if (closes[i] == null) continue;
      bars.push({
        time:   new Date(times[i] * 1000).toISOString(),
        ts:     times[i] * 1000,   // epoch ms for alignment
        open:   opens[i]   ?? closes[i],
        high:   highs[i]   ?? closes[i],
        low:    lows[i]    ?? closes[i],
        close:  closes[i],
        volume: volumes[i] ?? 0
      });
    }
    // Yahoo returns oldest-first — keep that order for backtest replay

    db.setSetting(cKey, JSON.stringify(bars));
    db.setSetting(tKey, Date.now());
    console.log(`[CrossAsset] ✅ ${cacheKey} historical (${interval}/${range}): ${bars.length} bars`);
    return bars;

  } catch (err) {
    console.warn(`[CrossAsset] ${cacheKey} historical fetch failed:`, err.message);
    return cached ? (typeof cached === 'string' ? JSON.parse(cached) : cached) : [];
  }
}

// ─── Signal Computation ───────────────────────────────────────────────────────

/**
 * Session return from a bars array (newest-first).
 * Compares current close to oldest open in the dataset.
 */
function sessionReturn(bars) {
  if (!bars || bars.length < 2) return 0;
  const current = bars[0].close;
  const base    = bars[bars.length - 1].open ?? bars[bars.length - 1].close;
  return base > 0 ? ((current - base) / base) * 100 : 0;
}

/**
 * N-bar percent change (momentum over the last N bars).
 */
function nBarReturn(bars, n = 12) {
  if (!bars || bars.length <= n) return 0;
  const recent = bars[0].close;
  const prior  = bars[n].close;
  return prior > 0 ? ((recent - prior) / prior) * 100 : 0;
}

// ─── NQ–ES Divergence ────────────────────────────────────────────────────────

/**
 * Compute NQ vs ES divergence signal.
 *
 * Signals:
 *   NQ_LEADING_BULLISH   — NQ outpacing ES upside (1-hr momentum), ES likely follows
 *   NQ_LEADING_BEARISH   — NQ leading to downside
 *   RISK_ON_CONFIRMED    — Both up, same direction, aligned
 *   RISK_OFF_CONFIRMED   — Both down, same direction, aligned
 *   DIVERGING            — NQ and ES moving meaningfully in opposite directions
 *   NEUTRAL              — No clear divergence or alignment
 */
function computeNQESDivergence(esBars, nqBars) {
  if (!nqBars || nqBars.length < 5) {
    return { signal: 'NEUTRAL', alignment: 0, esReturn: 0, nqReturn: 0,
             sessionSpread: 0, momentumSpread: 0, reasoning: 'NQ data unavailable' };
  }

  const esReturn  = sessionReturn(esBars);
  const nqReturn  = sessionReturn(nqBars);
  const esMom12   = nBarReturn(esBars, 12);   // ~1-hour momentum
  const nqMom12   = nBarReturn(nqBars, 12);
  const esMom3    = nBarReturn(esBars, 3);    // ~15-min momentum
  const nqMom3    = nBarReturn(nqBars, 3);

  const sessionSpread  = nqReturn - esReturn;   // positive = NQ outperforming
  const momentumSpread = nqMom12  - esMom12;    // 1-hour relative momentum

  let signal    = 'NEUTRAL';
  let alignment = 0;   // -1 diverging, 0 neutral, +1 aligned
  let reasoning = '';

  // --- Diverging: NQ and ES moving in meaningfully opposite directions ---
  if (Math.sign(nqMom3) !== Math.sign(esMom3) && Math.abs(nqMom3) > 0.1 && Math.abs(esMom3) > 0.1) {
    signal    = 'DIVERGING';
    alignment = -1;
    reasoning = `NQ ${nqMom3.toFixed(2)}% vs ES ${esMom3.toFixed(2)}% (15-min) — sector divergence, avoid momentum`;

  // --- NQ leading ES to upside: tech outperformance often precedes broad rally ---
  } else if (nqMom12 > 0.15 && esMom12 >= 0 && momentumSpread > 0.2) {
    signal    = 'NQ_LEADING_BULLISH';
    alignment = 1;
    reasoning = `NQ +${nqMom12.toFixed(2)}% vs ES +${esMom12.toFixed(2)}% (1hr) — tech leading, bullish follow-through likely`;

  // --- NQ leading ES to downside ---
  } else if (nqMom12 < -0.15 && esMom12 <= 0 && momentumSpread < -0.2) {
    signal    = 'NQ_LEADING_BEARISH';
    alignment = 1;
    reasoning = `NQ ${nqMom12.toFixed(2)}% vs ES ${esMom12.toFixed(2)}% (1hr) — tech leading downside`;

  // --- Both aligned upward (broad risk-on) ---
  } else if (esReturn > 0.1 && nqReturn > 0.1 && Math.abs(sessionSpread) < 0.5) {
    signal    = 'RISK_ON_CONFIRMED';
    alignment = 1;
    reasoning = `ES +${esReturn.toFixed(2)}% / NQ +${nqReturn.toFixed(2)}% — broad risk-on, aligned`;

  // --- Both aligned downward (broad risk-off) ---
  } else if (esReturn < -0.1 && nqReturn < -0.1 && Math.abs(sessionSpread) < 0.5) {
    signal    = 'RISK_OFF_CONFIRMED';
    alignment = 1;
    reasoning = `ES ${esReturn.toFixed(2)}% / NQ ${nqReturn.toFixed(2)}% — broad risk-off, aligned`;

  // --- Large spread but same direction = sector rotation, not true divergence ---
  } else if (Math.abs(sessionSpread) > 0.8 && Math.sign(esReturn) === Math.sign(nqReturn)) {
    signal    = 'SECTOR_ROTATION';
    alignment = 0;
    reasoning = `NQ vs ES spread ${sessionSpread.toFixed(2)}% — rotation underway, mixed signal`;

  } else {
    reasoning = `ES ${esReturn.toFixed(2)}% / NQ ${nqReturn.toFixed(2)}% — no clear divergence`;
  }

  return {
    signal, alignment,
    esReturn:       parseFloat(esReturn.toFixed(3)),
    nqReturn:       parseFloat(nqReturn.toFixed(3)),
    sessionSpread:  parseFloat(sessionSpread.toFixed(3)),
    momentumSpread: parseFloat(momentumSpread.toFixed(3)),
    esMom12:        parseFloat(esMom12.toFixed(3)),
    nqMom12:        parseFloat(nqMom12.toFixed(3)),
    reasoning
  };
}

// ─── Risk Sentiment Composite ─────────────────────────────────────────────────

/**
 * Compute a multi-asset risk-on / risk-off composite from Gold, BTC, and Oil.
 *
 * Returns:
 *   score: integer -5 to +5 (positive = risk-on, negative = risk-off)
 *   label: STRONG_RISK_ON | MILD_RISK_ON | NEUTRAL | MILD_RISK_OFF | STRONG_RISK_OFF
 *   signals: string[] describing individual contributions
 */
function computeRiskSentiment(esBars, goldBars, btcBars, oilBars) {
  const esReturn   = nBarReturn(esBars,  12);
  const goldReturn = nBarReturn(goldBars, 12);  // Gold 1-hour momentum
  const btcReturn  = nBarReturn(btcBars,  6);   // BTC 30-min (faster signal)
  const oilReturn  = nBarReturn(oilBars,  12);  // Oil 1-hour momentum

  // Session-level for context
  const goldSession = sessionReturn(goldBars);
  const btcSession  = sessionReturn(btcBars);
  const oilSession  = sessionReturn(oilBars);

  let riskScore = 0;
  const signals = [];

  // ── Gold (safe-haven inverse indicator) ──────────────────────────────────
  // Baur & Lucey (2010): gold is a safe haven during equity stress
  if (goldReturn > 0.4 && esReturn < 0.1) {
    riskScore -= 3;
    signals.push(`Gold rising +${goldReturn.toFixed(2)}% vs weak ES → safe-haven demand, risk-OFF`);
  } else if (goldReturn > 0.2 && goldSession > 0.3) {
    riskScore -= 1;
    signals.push(`Gold strength +${goldReturn.toFixed(2)}% (1hr) → mild risk-off bias`);
  } else if (goldReturn < -0.3) {
    riskScore += 1;
    signals.push(`Gold selling off (${goldReturn.toFixed(2)}%) → risk-ON, gold hedge unwinding`);
  } else if (goldReturn > 0.2 && esReturn > 0.2) {
    // Gold AND ES both up = stagflation concern, not clean signal
    signals.push(`Gold and ES both up (inflation/stagflation concern) — mixed`);
  }

  // ── Bitcoin (speculative risk appetite) ──────────────────────────────────
  // Bouri et al. (2020): crypto co-moves with growth equity during risk-on
  if (btcReturn > 2.0) {
    riskScore += 3;
    signals.push(`BTC surge +${btcReturn.toFixed(2)}% (30-min) → strong speculative appetite`);
  } else if (btcReturn > 0.8) {
    riskScore += 2;
    signals.push(`BTC +${btcReturn.toFixed(2)}% (30-min) → risk-ON appetite`);
  } else if (btcReturn > 0.3) {
    riskScore += 1;
    signals.push(`BTC +${btcReturn.toFixed(2)}% → mild risk-on`);
  } else if (btcReturn < -2.5) {
    riskScore -= 3;
    signals.push(`BTC crash ${btcReturn.toFixed(2)}% → de-risking, risk-OFF`);
  } else if (btcReturn < -1.2) {
    riskScore -= 2;
    signals.push(`BTC ${btcReturn.toFixed(2)}% → risk-OFF signal`);
  } else if (btcReturn < -0.5) {
    riskScore -= 1;
    signals.push(`BTC ${btcReturn.toFixed(2)}% → mild risk-off`);
  }

  // ── Crude Oil (macro/inflation signal) ────────────────────────────────────
  // Hamilton (2009): oil spikes precede recessions; Kilian & Park (2009):
  // demand-driven oil rise is equity-positive; supply shocks are equity-negative
  if (oilReturn > 1.5 && esReturn < 0.2) {
    riskScore -= 2;
    signals.push(`Oil spike +${oilReturn.toFixed(2)}% without ES participation → supply shock, inflation concern`);
  } else if (oilReturn > 1.0) {
    riskScore -= 1;
    signals.push(`Oil +${oilReturn.toFixed(2)}% → inflation pressure, ES headwind`);
  } else if (oilReturn < -2.0) {
    riskScore -= 2;
    signals.push(`Oil crash ${oilReturn.toFixed(2)}% → demand weakness / risk-off`);
  } else if (oilReturn < -1.0) {
    riskScore -= 1;
    signals.push(`Oil ${oilReturn.toFixed(2)}% → demand concern`);
  } else if (oilReturn > 0.4 && esReturn > 0.2) {
    riskScore += 1;
    signals.push(`Oil and ES rising together (+${oilReturn.toFixed(2)}%) → demand-driven, healthy risk-on`);
  }

  // ── Cross-asset confirmation bonus ───────────────────────────────────────
  // All three pointing same direction = regime conviction
  const riskOnCount  = [goldReturn < -0.2, btcReturn > 0.5, oilReturn > 0.5 && esReturn > 0].filter(Boolean).length;
  const riskOffCount = [goldReturn > 0.3, btcReturn < -0.8, oilReturn < -1.0].filter(Boolean).length;

  if (riskOnCount >= 2) {
    riskScore += 1;
    signals.push(`Multi-asset risk-ON confirmation (${riskOnCount}/3 signals)`);
  }
  if (riskOffCount >= 2) {
    riskScore -= 1;
    signals.push(`Multi-asset risk-OFF confirmation (${riskOffCount}/3 signals)`);
  }

  const clamped = Math.max(-5, Math.min(5, riskScore));
  const label   = clamped >=  3 ? 'STRONG_RISK_ON'  :
                  clamped >=  1 ? 'MILD_RISK_ON'    :
                  clamped <= -3 ? 'STRONG_RISK_OFF'  :
                  clamped <= -1 ? 'MILD_RISK_OFF'    : 'NEUTRAL';

  return {
    score:       clamped,
    label,
    goldReturn:  parseFloat(goldReturn.toFixed(3)),
    btcReturn:   parseFloat(btcReturn.toFixed(3)),
    oilReturn:   parseFloat(oilReturn.toFixed(3)),
    goldSession: parseFloat(goldSession.toFixed(3)),
    btcSession:  parseFloat(btcSession.toFixed(3)),
    oilSession:  parseFloat(oilSession.toFixed(3)),
    signals
  };
}

// ─── Cross-Asset Score for Scoring Layer ─────────────────────────────────────

/**
 * Translate cross-asset context into a directional point score.
 * Called AFTER direction is determined in calculateScalpingConfidence.
 *
 * direction: 'LONG' | 'SHORT'
 * Returns { score, breakdown }
 */
function computeCrossAssetScore(nqDivergence, riskSentiment, direction) {
  if (!direction) return { score: 0, breakdown: [] };

  let score = 0;
  const breakdown = [];

  // ── NQ alignment (max +8, min -4) ────────────────────────────────────────
  const nqSig = nqDivergence.signal;
  const longFavored  = ['NQ_LEADING_BULLISH', 'RISK_ON_CONFIRMED'].includes(nqSig);
  const shortFavored = ['NQ_LEADING_BEARISH', 'RISK_OFF_CONFIRMED'].includes(nqSig);

  if (longFavored && direction === 'LONG') {
    score += 8;
    breakdown.push({ factor: 'NQ Alignment', score: 8, reasoning: nqDivergence.reasoning });
  } else if (shortFavored && direction === 'SHORT') {
    score += 8;
    breakdown.push({ factor: 'NQ Alignment', score: 8, reasoning: nqDivergence.reasoning });
  } else if (longFavored && direction === 'SHORT') {
    score -= 4;
    breakdown.push({ factor: 'NQ Conflict', score: -4, reasoning: `NQ bullish but trading SHORT — against cross-asset tide` });
  } else if (shortFavored && direction === 'LONG') {
    score -= 4;
    breakdown.push({ factor: 'NQ Conflict', score: -4, reasoning: `NQ bearish but trading LONG — against cross-asset tide` });
  } else if (nqSig === 'DIVERGING') {
    score -= 4;
    breakdown.push({ factor: 'NQ Diverging', score: -4, reasoning: nqDivergence.reasoning });
  }

  // ── Risk sentiment (max +6, min -5) ──────────────────────────────────────
  const rs = riskSentiment.score;
  if (direction === 'LONG') {
    if (rs >= 3) {
      score += 6;
      breakdown.push({ factor: 'Risk-On Confirmed', score: 6, reasoning: `${riskSentiment.label}: ${riskSentiment.signals[0] || ''}` });
    } else if (rs >= 1) {
      score += 3;
      breakdown.push({ factor: 'Mild Risk-On', score: 3, reasoning: riskSentiment.label });
    } else if (rs <= -3) {
      score -= 5;
      breakdown.push({ factor: 'Risk-Off Conflict', score: -5, reasoning: `${riskSentiment.label} — fighting macro tide on LONG` });
    } else if (rs <= -1) {
      score -= 2;
      breakdown.push({ factor: 'Mild Risk-Off', score: -2, reasoning: riskSentiment.label });
    }
  } else { // SHORT
    if (rs <= -3) {
      score += 6;
      breakdown.push({ factor: 'Risk-Off Confirmed', score: 6, reasoning: `${riskSentiment.label}: ${riskSentiment.signals[0] || ''}` });
    } else if (rs <= -1) {
      score += 3;
      breakdown.push({ factor: 'Mild Risk-Off', score: 3, reasoning: riskSentiment.label });
    } else if (rs >= 3) {
      score -= 5;
      breakdown.push({ factor: 'Risk-On Conflict', score: -5, reasoning: `${riskSentiment.label} — fighting macro tide on SHORT` });
    } else if (rs >= 1) {
      score -= 2;
      breakdown.push({ factor: 'Mild Risk-On', score: -2, reasoning: riskSentiment.label });
    }
  }

  return { score, breakdown };
}

// ─── Main Context Function ────────────────────────────────────────────────────

/**
 * Fetch and compute all cross-asset signals.
 * Called each cycle by automation.js with the current ES 5m bars.
 *
 * @param {Array} esBars - 5-minute ES bars, newest first
 * @returns {object} { nqDivergence, riskSentiment, prices, available }
 */
async function getCrossAssetContext(esBars) {
  console.log('[CrossAsset] Computing cross-asset context...');

  // Fetch bars for all four instruments in parallel
  const [nqBars, goldBars, btcBars, oilBars] = await Promise.all([
    Promise.resolve(fetchYahooBars(SYMBOLS.nq,   'nq',   60)),
    Promise.resolve(fetchYahooBars(SYMBOLS.gold,  'gold', 60)),
    Promise.resolve(fetchYahooBars(SYMBOLS.btc,   'btc',  60)),
    Promise.resolve(fetchYahooBars(SYMBOLS.oil,   'oil',  60))
  ]);

  const available = {
    nq:   nqBars.length   > 3,
    gold: goldBars.length > 3,
    btc:  btcBars.length  > 3,
    oil:  oilBars.length  > 3
  };

  const nqDivergence  = computeNQESDivergence(esBars || [], nqBars);
  const riskSentiment = computeRiskSentiment(esBars || [], goldBars, btcBars, oilBars);

  console.log('[CrossAsset] ✅', {
    NQ:       nqDivergence.signal,
    esReturn: nqDivergence.esReturn + '%',
    nqReturn: nqDivergence.nqReturn + '%',
    risk:     riskSentiment.label,
    gold:     riskSentiment.goldReturn + '%',
    btc:      riskSentiment.btcReturn  + '%',
    oil:      riskSentiment.oilReturn  + '%'
  });

  return {
    nqDivergence,
    riskSentiment,
    available,
    prices: {
      nq:   nqBars[0]?.close   || null,
      gold: goldBars[0]?.close || null,
      btc:  btcBars[0]?.close  || null,
      oil:  oilBars[0]?.close  || null
    }
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getCrossAssetContext,
  computeNQESDivergence,
  computeRiskSentiment,
  computeCrossAssetScore,
  fetchYahooBars,
  fetchYahooHistorical,
  // Exposed for backtesting
  sessionReturn,
  nBarReturn
};

console.log('[CrossAsset] ✅ Module loaded successfully');
