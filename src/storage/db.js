// JSON file-based storage — replaces Chrome extension storage + IndexedDB
// Uses flat JSON files: data/settings.json, data/summaries.json, data/trades.json
// Zero native dependencies, perfectly adequate for our data volumes.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

// Ensure data/ directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  settings:     path.join(DATA_DIR, 'settings.json'),
  summaries:    path.join(DATA_DIR, 'summaries.json'),
  trades:       path.join(DATA_DIR, 'trades.json'),
  nearMisses:   path.join(DATA_DIR, 'near-misses.json'),
  passedScalps: path.join(DATA_DIR, 'passed-scalps.json')
};

// ─── File helpers ─────────────────────────────────────────────────────────────

function readJSON(file, defaultVal) {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultVal;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Settings (replaces chrome.storage.local) ─────────────────────────────────

function getSetting(key) {
  const store = readJSON(FILES.settings, {});
  return store[key] !== undefined ? store[key] : null;
}

function setSetting(key, value) {
  const store = readJSON(FILES.settings, {});
  store[key] = value;
  writeJSON(FILES.settings, store);
}

function deleteSetting(key) {
  const store = readJSON(FILES.settings, {});
  delete store[key];
  writeJSON(FILES.settings, store);
}

// ─── Summaries (replaces IndexedDB getCachedSummaries) ───────────────────────

// Same TTLs as original content.js IndexedDB implementation
const SUMMARY_TTL = {
  daily:   1 * 60 * 60 * 1000,   // 1 hour
  recent:  5 * 60 * 1000,         // 5 minutes
  weekly:  null,                   // never expire
  monthly: null                    // never expire
};

function getLatestSummary(type) {
  const store = readJSON(FILES.summaries, {});
  return store[type] || null;  // { content, created_at }
}

function saveSummary(type, content) {
  const store = readJSON(FILES.summaries, {});
  store[type] = { content, created_at: Date.now() };
  writeJSON(FILES.summaries, store);
}

function getCachedSummaries() {
  const now = Date.now();
  const result = {};

  for (const type of ['monthly', 'weekly', 'daily', 'recent']) {
    const entry = getLatestSummary(type);
    if (!entry) { result[type] = null; continue; }

    const ttl = SUMMARY_TTL[type];
    const expired = ttl ? (now - entry.created_at) > ttl : false;
    result[type] = expired ? null : entry.content;
  }

  return result;
}

// ─── Trades (replaces IndexedDB trades + abandoned stores) ───────────────────

function saveTrade(trade) {
  const trades = readJSON(FILES.trades, []);
  trades.push({
    id:                     trades.length + 1,
    created_at:             Date.now(),
    timestamp:              trade.timestamp          || Date.now(),

    // Core trade identity
    direction:              trade.direction          || null,
    path:                   trade.path               || null,   // 'A' or 'B'
    grade:                  trade.grade              || null,
    confidence:             trade.confidence         || null,

    // Entry / exit prices
    entry:                  trade.entry              || null,
    stop_loss:              trade.stopLoss           || null,
    take_profit:            trade.takeProfit         || null,
    exit_price:             trade.exitPrice          || null,
    exit_reason:            trade.exitReason         || null,   // 'SL'|'TP'|'TIME'|'TRAIL'|'BREAKEVEN_STOP'
    profit_loss:            trade.profitLoss         || null,
    outcome:                trade.outcome            || null,
    duration_seconds:       trade.durationSeconds    || null,

    // Execution quality
    entry_type:             trade.entryType          || null,   // 'TICK_PERFECT' | 'APPROXIMATE'
    tick_confidence:        trade.tickConfidence     ?? null,
    max_favorable_excursion: trade.maxFavorableExcursion ?? null,
    max_adverse_excursion:  trade.maxAdverseExcursion   ?? null,
    break_even_triggered:   trade.breakEvenTriggered ?? false,
    trail_stop_triggered:   trade.trailStopTriggered ?? false,

    // Session context
    session:                trade.session            || null,
    session_bar_delta:      trade.sessionBarDelta    ?? null,
    session_bar_count:      trade.sessionBarCount    ?? null,
    hold_time_max:          trade.holdTimeMax        || null,

    // Volatility
    sigma:                  trade.sigma              ?? null,
    vol_regime:             trade.volRegime          || null,
    rviv_ratio:             trade.rvivRatio          ?? null,
    rviv_regime:            trade.rvivRegime         || null,   // TRENDING|RANGING|NEUTRAL
    rviv_regime_raw:        trade.rvivRegimeRaw      || null,

    // VIX / macro
    vix:                    trade.vix                ?? null,
    vix_3m:                 trade.vix3m              ?? null,
    vix_structure:          trade.vixStructure       || null,
    vix_trend:              trade.vixTrend           || null,
    macro_regime:           trade.macroRegime        || null,
    cot_signal:             trade.cotSignal          || null,
    cot_percentile:         trade.cotPercentile      ?? null,

    // Futures
    basis_signal:           trade.basisSignal        || null,
    price_discovery_role:   trade.priceDiscoveryRole || null,
    delta_imbalance:        trade.deltaImbalance     || null,

    // Cross-asset
    nq_divergence:          trade.nqDivergence       || null,
    risk_sentiment:         trade.riskSentiment      || null,
    risk_sentiment_score:   trade.riskSentimentScore ?? null,

    // VWAP
    vwap_signal:            trade.vwapSignal         || null,
    vwap_bias:              trade.vwapBias           || null,
    vwap_z_score:           trade.vwapZScore         ?? null,
    using_session_vwap:     trade.usingSessionVwap   ?? null,

    // Direction signals
    signal_votes:           trade.signalVotes ? JSON.stringify(trade.signalVotes) : null,
    bullish_count:          trade.bullishCount       ?? null,
    bearish_count:          trade.bearishCount       ?? null,
    convergence_ratio:      trade.convergenceRatio   ?? null,
    total_signals:          trade.totalSignals       ?? null,

    // Top scoring breakdown items (JSON)
    top_factors:            trade.topFactors ? JSON.stringify(trade.topFactors) : null,

    // Per-layer scores
    score_macro:            trade.scoreMacro         ?? null,
    score_futures:          trade.scoreFutures       ?? null,
    score_micro:            trade.scoreMicro         ?? null,
    score_tick:             trade.scoreTick          ?? null,
    score_execution:        trade.scoreExecution     ?? null,
    score_cross_asset:      trade.scoreCrossAsset    ?? null,
  });
  writeJSON(FILES.trades, trades);
}

function getRecentTrades(n = 20) {
  const trades = readJSON(FILES.trades, []);
  return trades.slice(-n).reverse();
}

function getDailyStats() {
  const trades = readJSON(FILES.trades, []);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();

  return trades
    .filter(t => (t.created_at || 0) >= cutoff)
    .reduce((acc, t) => {
      acc.total++;
      if (t.outcome === 'win')  { acc.wins++;   acc.pnl += (t.profit_loss || 0); }
      if (t.outcome === 'loss') { acc.losses++;  acc.pnl += (t.profit_loss || 0); }
      return acc;
    }, { total: 0, wins: 0, losses: 0, pnl: 0 });
}

/**
 * Compute win rate broken down by session phase.
 * Only counts trades where session was recorded.
 * Returns { PHASE: { wins, losses, total, winRate, pnl, avgPnL } }
 */
function getWinRateByPhase() {
  const trades = readJSON(FILES.trades, []);
  const phases = {};

  for (const t of trades) {
    if (!t.session || !t.outcome) continue;
    if (!phases[t.session]) phases[t.session] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { phases[t.session].wins++;   phases[t.session].pnl += pnl; }
    if (t.outcome === 'loss') { phases[t.session].losses++; phases[t.session].pnl += pnl; }
  }

  const result = {};
  for (const [phase, s] of Object.entries(phases)) {
    const total = s.wins + s.losses;
    result[phase] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: total > 0 ? (s.wins / total * 100).toFixed(1) + '%' : 'N/A',
      avgPnL:  total > 0 ? '$' + (s.pnl / total).toFixed(2) : '$0.00'
    };
  }

  return result;
}

/**
 * Compute per-phase threshold adjustments from historical win-rate data.
 * Requires at least minTrades trades per phase before applying any adjustment.
 * Returns { PHASE: ±5 } — positive = raise threshold (harder), negative = lower it.
 * Maximum adjustment is ±10 (capped in getCycleContext).
 *
 * @param {number} minTrades - Minimum trades required before adjusting a phase (default 50)
 * @returns {{ [phase: string]: number }}
 */
function getAdaptivePhaseAdjustments(minTrades = 50) {
  const phaseStats = getWinRateByPhase();
  const adjustments = {};

  for (const [phase, stats] of Object.entries(phaseStats)) {
    if (stats.total < minTrades) continue;       // not enough data yet
    const wr = stats.wins / stats.total;
    if (wr < 0.45)      adjustments[phase] = 5;  // poor phase: require stronger signal
    else if (wr > 0.60) adjustments[phase] = -5; // strong phase: allow slightly easier entry
    // 45–60% range: no adjustment
  }

  return adjustments;
}

/**
 * Win rate broken down by RV/IV regime (TRENDING | RANGING | NEUTRAL).
 * Requires at least minTrades per regime before including it in results.
 *
 * @param {number} minTrades
 * @returns {{ [regime: string]: { wins, losses, total, winRate, pnl, avgPnL } }}
 */
function getWinRateByRegime(minTrades = 30) {
  const trades = readJSON(FILES.trades, []);
  const regimes = {};

  for (const t of trades) {
    if (!t.rviv_regime || !t.outcome) continue;
    if (!regimes[t.rviv_regime]) regimes[t.rviv_regime] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { regimes[t.rviv_regime].wins++;   regimes[t.rviv_regime].pnl += pnl; }
    if (t.outcome === 'loss') { regimes[t.rviv_regime].losses++; regimes[t.rviv_regime].pnl += pnl; }
  }

  const result = {};
  for (const [regime, s] of Object.entries(regimes)) {
    const total = s.wins + s.losses;
    if (total < minTrades) continue;
    result[regime] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: (s.wins / total * 100).toFixed(1) + '%',
      avgPnL:  '$' + (s.pnl / total).toFixed(2)
    };
  }

  return result;
}

/**
 * Win rate broken down by trade path ('A' = momentum, 'B' = VWAP reversion).
 * Requires at least minTrades per path before including it in results.
 *
 * @param {number} minTrades
 * @returns {{ [path: string]: { wins, losses, total, winRate, pnl, avgPnL } }}
 */
function getWinRateByPath(minTrades = 20) {
  const trades = readJSON(FILES.trades, []);
  const paths = {};

  for (const t of trades) {
    if (!t.path || !t.outcome) continue;
    if (!paths[t.path]) paths[t.path] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { paths[t.path].wins++;   paths[t.path].pnl += pnl; }
    if (t.outcome === 'loss') { paths[t.path].losses++; paths[t.path].pnl += pnl; }
  }

  const result = {};
  for (const [path, s] of Object.entries(paths)) {
    const total = s.wins + s.losses;
    if (total < minTrades) continue;
    result[path] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: (s.wins / total * 100).toFixed(1) + '%',
      avgPnL:  '$' + (s.pnl / total).toFixed(2)
    };
  }

  return result;
}

/**
 * Win rate broken down by confidence bucket.
 * Buckets: '<50', '50-60', '60-70', '70-80', '80+'
 *
 * @returns {{ [bucket: string]: { wins, losses, total, winRate, pnl, avgPnL } }}
 */
function getWinRateByConfidenceBucket() {
  const trades = readJSON(FILES.trades, []);
  const buckets = { '<50': {wins:0,losses:0,pnl:0}, '50-60': {wins:0,losses:0,pnl:0},
                    '60-70': {wins:0,losses:0,pnl:0}, '70-80': {wins:0,losses:0,pnl:0},
                    '80+': {wins:0,losses:0,pnl:0} };

  for (const t of trades) {
    if (t.confidence == null || !t.outcome) continue;
    const c = parseFloat(t.confidence);
    const bucket = c < 50  ? '<50'   :
                   c < 60  ? '50-60' :
                   c < 70  ? '60-70' :
                   c < 80  ? '70-80' : '80+';
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { buckets[bucket].wins++;   buckets[bucket].pnl += pnl; }
    if (t.outcome === 'loss') { buckets[bucket].losses++; buckets[bucket].pnl += pnl; }
  }

  const result = {};
  for (const [bucket, s] of Object.entries(buckets)) {
    const total = s.wins + s.losses;
    result[bucket] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: total > 0 ? (s.wins / total * 100).toFixed(1) + '%' : 'N/A',
      avgPnL:  total > 0 ? '$' + (s.pnl / total).toFixed(2) : '$0.00'
    };
  }

  return result;
}

/**
 * Compute threshold adjustments per RV/IV regime from historical win-rate data.
 * Requires at least minTrades per regime before applying any adjustment.
 * Returns { TRENDING: ±N, RANGING: ±N } — positive = raise barrier (harder), negative = lower.
 *
 * @param {number} minTrades
 * @returns {{ TRENDING?: number, RANGING?: number }}
 */
function getAdaptiveRegimeAdjustments(minTrades = 30) {
  const regimeStats = getWinRateByRegime(minTrades);
  const adjustments = {};

  for (const [regime, stats] of Object.entries(regimeStats)) {
    if (regime === 'NEUTRAL') continue;  // only adjust directional regimes
    const wr = stats.wins / stats.total;
    if (wr < 0.40)      adjustments[regime] = 3;   // poor regime: raise barrier
    else if (wr > 0.60) adjustments[regime] = -3;  // strong regime: lower barrier
    // 40-60%: no adjustment
  }

  return adjustments;
}

/**
 * Per-signal reliability: win rate and avg P&L for each named signal.
 * Only works when signal_votes contains objects with { name, vote|signal }.
 * Trades with plain-string signal_votes are skipped.
 * Returns array sorted by tradesActive descending.
 *
 * @returns {Array<{ name, tradesActive, wins, losses, winRate, avgPnL, totalPnL }>}
 */
function getSignalReliability() {
  const trades = readJSON(FILES.trades, []);
  const signalStats = {};

  for (const t of trades) {
    if (!t.signal_votes || !t.outcome) continue;
    let votes;
    try { votes = JSON.parse(t.signal_votes); } catch { continue; }
    if (!Array.isArray(votes)) continue;

    const won = t.outcome === 'win';
    const pnl = t.profit_loss || 0;

    for (const v of votes) {
      // Only handle named signal objects { name, vote } or { name, signal }
      if (!v || typeof v !== 'object' || !v.name) continue;
      const name = v.name;
      if (!signalStats[name]) signalStats[name] = { wins: 0, losses: 0, pnl: 0 };
      if (won)  signalStats[name].wins++;
      else      signalStats[name].losses++;
      signalStats[name].pnl += pnl;
    }
  }

  return Object.entries(signalStats)
    .map(([name, s]) => {
      const total = s.wins + s.losses;
      return {
        name,
        tradesActive: total,
        wins:         s.wins,
        losses:       s.losses,
        winRate:      total > 0 ? (s.wins / total * 100).toFixed(1) + '%' : 'N/A',
        avgPnL:       total > 0 ? parseFloat((s.pnl / total).toFixed(2)) : 0,
        totalPnL:     parseFloat(s.pnl.toFixed(2))
      };
    })
    .sort((a, b) => b.tradesActive - a.tradesActive);
}

// ─── False-Negative Analysis ──────────────────────────────────────────────────

/**
 * Profile the near-miss ring buffer (cycles that came within 10 pts of threshold).
 * No minTrades requirement — all near-misses are useful calibration signal.
 *
 * @returns {{ total, avgGap, avgConfidence, bySession, byRegime, byGapBucket }}
 */
function getNearMissProfile() {
  const misses = readJSON(FILES.nearMisses, []);
  const empty = {
    total: 0, avgGap: 0, avgConfidence: 0,
    bySession: {}, byRegime: {}, byGapBucket: { '0-3': 0, '3-5': 0, '5-10': 0 }
  };
  if (misses.length === 0) return empty;

  let totalGap = 0, totalConf = 0, confCount = 0;
  const bySession = {}, byRegime = {};
  const byGapBucket = { '0-3': 0, '3-5': 0, '5-10': 0 };

  for (const m of misses) {
    const gap  = parseFloat(m.gap) || 0;
    const conf = parseFloat(m.confidence) || 0;
    const sess = m.session     || 'UNKNOWN';
    const reg  = m.rvivRegime  || 'UNKNOWN';

    totalGap += gap;
    if (m.confidence != null) { totalConf += conf; confCount++; }

    // bySession
    if (!bySession[sess]) bySession[sess] = { count: 0, totalGap: 0, totalConf: 0, confCount: 0 };
    bySession[sess].count++;
    bySession[sess].totalGap += gap;
    if (m.confidence != null) { bySession[sess].totalConf += conf; bySession[sess].confCount++; }

    // byRegime
    if (!byRegime[reg]) byRegime[reg] = { count: 0, totalGap: 0 };
    byRegime[reg].count++;
    byRegime[reg].totalGap += gap;

    // byGapBucket
    const bucket = gap <= 3 ? '0-3' : gap <= 5 ? '3-5' : '5-10';
    byGapBucket[bucket]++;
  }

  const n = misses.length;
  return {
    total:          n,
    avgGap:         parseFloat((totalGap / n).toFixed(2)),
    avgConfidence:  confCount > 0 ? parseFloat((totalConf / confCount).toFixed(1)) : 0,
    bySession:      Object.fromEntries(
      Object.entries(bySession).map(([phase, s]) => [phase, {
        count:         s.count,
        avgGap:        parseFloat((s.totalGap / s.count).toFixed(2)),
        avgConfidence: s.confCount > 0 ? parseFloat((s.totalConf / s.confCount).toFixed(1)) : 0
      }])
    ),
    byRegime:       Object.fromEntries(
      Object.entries(byRegime).map(([regime, s]) => [regime, {
        count:  s.count,
        avgGap: parseFloat((s.totalGap / s.count).toFixed(2))
      }])
    ),
    byGapBucket
  };
}

/**
 * Profile the passed-scalp ring buffer (setups that cleared confidence but were blocked).
 *
 * @returns {{ total, avgConfidence, byReason, byGrade, confidenceBuckets }}
 */
function getPassedScalpProfile() {
  const scalps = readJSON(FILES.passedScalps, []);
  const emptyBuckets = { '<50': 0, '50-60': 0, '60-70': 0, '70-80': 0, '80+': 0 };
  const empty = {
    total: 0, avgConfidence: 0,
    byReason: {}, byGrade: {},
    confidenceBuckets: { ...emptyBuckets }
  };
  if (scalps.length === 0) return empty;

  let totalConf = 0, confCount = 0;
  const byReason = {}, byGrade = {};
  const confidenceBuckets = { ...emptyBuckets };

  for (const s of scalps) {
    const reason = s.reason || 'UNKNOWN';
    const grade  = s.grade  || 'UNKNOWN';

    if (!byReason[reason]) byReason[reason] = { count: 0 };
    byReason[reason].count++;

    if (!byGrade[grade]) byGrade[grade] = { count: 0 };
    byGrade[grade].count++;

    if (s.confidence != null) {
      const c = parseFloat(s.confidence);
      totalConf += c;
      confCount++;
      const bucket = c < 50 ? '<50' : c < 60 ? '50-60' : c < 70 ? '60-70' : c < 80 ? '70-80' : '80+';
      confidenceBuckets[bucket]++;
    }
  }

  return {
    total:             scalps.length,
    avgConfidence:     confCount > 0 ? parseFloat((totalConf / confCount).toFixed(1)) : 0,
    byReason,
    byGrade,
    confidenceBuckets
  };
}

/**
 * Estimate what fraction of near-misses likely would have been winners,
 * by joining near-miss context (session + rvivRegime) to historical trade win rates.
 *
 * camelCase→snake_case bridge: near-misses use m.rvivRegime; trades use t.rviv_regime.
 *
 * @param {number} minTrades - Minimum trades per context before using its win rate (default 5)
 * @returns {{ estimatedFalseNegativeRate, totalNearMisses, estimatedWinnersCount,
 *             contextBreakdown, hasEnoughData }}
 */
function getFalseNegativeRate(minTrades = 5) {
  const misses = readJSON(FILES.nearMisses, []);
  const trades = readJSON(FILES.trades, []);

  // Build trade win-rate index keyed by "session|rviv_regime"
  const tradeIndex = {};
  for (const t of trades) {
    if (!t.session || !t.rviv_regime || !t.outcome) continue;
    const key = `${t.session}|${t.rviv_regime}`;
    if (!tradeIndex[key]) tradeIndex[key] = { wins: 0, total: 0 };
    tradeIndex[key].total++;
    if (t.outcome === 'win') tradeIndex[key].wins++;
  }

  // Group near-misses by context; key uses camelCase rvivRegime from near-misses.json
  const missGroups = {};
  for (const m of misses) {
    const sess = m.session    || 'UNKNOWN';
    const reg  = m.rvivRegime || 'UNKNOWN';
    const key  = `${sess}|${reg}`;
    if (!missGroups[key]) missGroups[key] = { session: sess, regime: reg, count: 0 };
    missGroups[key].count++;
  }

  let estimatedWinners = 0;
  let matchedNearMisses = 0;
  const contextBreakdown = [];

  for (const [key, group] of Object.entries(missGroups)) {
    const tradeKey = key; // session|rvivRegime maps to session|rviv_regime via same values
    const tradeStats = tradeIndex[tradeKey];
    const hasData = tradeStats && tradeStats.total >= minTrades;
    const tradeWinRate = hasData ? tradeStats.wins / tradeStats.total : null;
    const estimatedEdge = hasData ? parseFloat((group.count * tradeWinRate).toFixed(1)) : 0;

    if (hasData) {
      estimatedWinners += group.count * tradeWinRate;
      matchedNearMisses += group.count;
    }

    contextBreakdown.push({
      session:       group.session,
      regime:        group.regime,
      nearMisses:    group.count,
      tradeWinRate:  tradeWinRate !== null ? parseFloat((tradeWinRate * 100).toFixed(1)) : null,
      estimatedEdge
    });
  }

  contextBreakdown.sort((a, b) => b.nearMisses - a.nearMisses);

  const total = misses.length;
  const rate  = total > 0 ? parseFloat((estimatedWinners / total * 100).toFixed(1)) : 0;

  return {
    estimatedFalseNegativeRate: rate,
    totalNearMisses:            total,
    estimatedWinnersCount:      parseFloat(estimatedWinners.toFixed(1)),
    contextBreakdown,
    hasEnoughData:              total > 0 && matchedNearMisses >= total * 0.5
  };
}

// ─── Active Trade Persistence (crash recovery) ────────────────────────────────

function saveActiveTrade(trade) {
  setSetting('activeTrade', JSON.stringify(trade));
}

function getActiveTrade() {
  const raw = getSetting('activeTrade');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function clearActiveTrade() {
  deleteSetting('activeTrade');
}

// ─── Near-Miss Logging ────────────────────────────────────────────────────────

function saveNearMiss(entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(FILES.nearMisses, 'utf8')); } catch {}
  arr.push({ ...entry, timestamp: Date.now() });
  if (arr.length > 500) arr = arr.slice(arr.length - 500);
  fs.writeFileSync(FILES.nearMisses, JSON.stringify(arr, null, 2));
}

function getRecentNearMisses(n = 100) {
  if (n <= 0) return [];
  try { return JSON.parse(fs.readFileSync(FILES.nearMisses, 'utf8')).slice(-n); } catch { return []; }
}

// ─── Passed Scalp Logging ─────────────────────────────────────────────────────

function savePassedScalp(entry) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(FILES.passedScalps, 'utf8')); } catch {}
  arr.push({ ...entry, timestamp: Date.now() });
  if (arr.length > 200) arr = arr.slice(arr.length - 200);
  fs.writeFileSync(FILES.passedScalps, JSON.stringify(arr, null, 2));
}

function getRecentPassedScalps(n = 50) {
  if (n <= 0) return [];
  try { return JSON.parse(fs.readFileSync(FILES.passedScalps, 'utf8')).slice(-n); } catch { return []; }
}

// ─── Analytics: exit reason + entry type ─────────────────────────────────────

/**
 * Win rate broken down by exit reason ('SL', 'TP', 'TIME', 'TRAIL', 'BREAKEVEN_STOP').
 * Lower minTrades (10) since each exit type has fewer samples.
 *
 * @param {number} minTrades
 * @returns {{ [reason: string]: { wins, losses, total, winRate, pnl, avgPnL } }}
 */
function getWinRateByExitReason(minTrades = 10) {
  const trades = readJSON(FILES.trades, []);
  const reasons = {};

  for (const t of trades) {
    if (!t.exit_reason || !t.outcome) continue;
    if (!reasons[t.exit_reason]) reasons[t.exit_reason] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { reasons[t.exit_reason].wins++;   reasons[t.exit_reason].pnl += pnl; }
    if (t.outcome === 'loss') { reasons[t.exit_reason].losses++; reasons[t.exit_reason].pnl += pnl; }
  }

  const result = {};
  for (const [reason, s] of Object.entries(reasons)) {
    const total = s.wins + s.losses;
    if (total < minTrades) continue;
    result[reason] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: (s.wins / total * 100).toFixed(1) + '%',
      avgPnL:  '$' + (s.pnl / total).toFixed(2)
    };
  }

  return result;
}

/**
 * Win rate broken down by entry type ('TICK_PERFECT', 'APPROXIMATE').
 * Validates whether tick-perfect entry selection improves win rate.
 *
 * @param {number} minTrades
 * @returns {{ [entryType: string]: { wins, losses, total, winRate, pnl, avgPnL } }}
 */
function getWinRateByEntryType(minTrades = 15) {
  const trades = readJSON(FILES.trades, []);
  const types = {};

  for (const t of trades) {
    if (!t.entry_type || !t.outcome) continue;
    if (!types[t.entry_type]) types[t.entry_type] = { wins: 0, losses: 0, pnl: 0 };
    const pnl = t.profit_loss || 0;
    if (t.outcome === 'win')  { types[t.entry_type].wins++;   types[t.entry_type].pnl += pnl; }
    if (t.outcome === 'loss') { types[t.entry_type].losses++; types[t.entry_type].pnl += pnl; }
  }

  const result = {};
  for (const [entryType, s] of Object.entries(types)) {
    const total = s.wins + s.losses;
    if (total < minTrades) continue;
    result[entryType] = {
      wins:    s.wins,
      losses:  s.losses,
      total,
      pnl:     parseFloat(s.pnl.toFixed(2)),
      winRate: (s.wins / total * 100).toFixed(1) + '%',
      avgPnL:  '$' + (s.pnl / total).toFixed(2)
    };
  }

  return result;
}

module.exports = {
  getSetting,
  setSetting,
  deleteSetting,
  getLatestSummary,
  saveSummary,
  getCachedSummaries,
  saveTrade,
  getRecentTrades,
  getDailyStats,
  getWinRateByPhase,
  getAdaptivePhaseAdjustments,
  getWinRateByRegime,
  getWinRateByPath,
  getWinRateByConfidenceBucket,
  getAdaptiveRegimeAdjustments,
  getSignalReliability,
  getNearMissProfile,
  getPassedScalpProfile,
  getFalseNegativeRate,
  saveActiveTrade,
  getActiveTrade,
  clearActiveTrade,
  saveNearMiss,
  getRecentNearMisses,
  savePassedScalp,
  getRecentPassedScalps,
  getWinRateByExitReason,
  getWinRateByEntryType
};
