// Signal Scorecard — Layer 2 of the analytics system
// Maintains a rolling performance record for each direction signal and confidence
// layer. Computes dynamic weight multipliers (clamped 0.5–1.5) that
// scalping-intelligence.js reads at cycle time to self-adjust.
//
// Updated after every trade via updateScorecard(trade).
// Read at cycle time via getWeightMultipliers().
// Persisted to data/scorecard.json.

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '../../data');
const TRADES_FILE   = path.join(DATA_DIR, 'trades.json');
const SCORECARD_FILE = path.join(DATA_DIR, 'scorecard.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum trades before a weight multiplier is applied (prevents premature adjustment)
const MIN_TRADES_FOR_WEIGHT = 30;

// Weight multiplier bounds
const WEIGHT_FLOOR = 0.5;
const WEIGHT_CEIL  = 1.5;

// Rolling window sizes
const WINDOWS = { short: 50, medium: 200 };

// Known layer score fields in trade records
const LAYER_FIELDS = {
  macro:       'score_macro',
  futures:     'score_futures',
  micro:       'score_micro',
  tick:        'score_tick',
  execution:   'score_execution',
  cross_asset: 'score_cross_asset',
};

// ─── Core Computations ───────────────────────────────────────────────────────

/**
 * Compute per-signal accuracy over a window of trades.
 * Returns { signalName: { total, votedWithDir, correct, accuracy, winRateWhenWith } }
 */
function computeSignalAccuracy(trades) {
  const acc = {};

  for (const t of trades) {
    let votes;
    try { votes = typeof t.signal_votes === 'string' ? JSON.parse(t.signal_votes) : t.signal_votes; }
    catch { continue; }
    if (!Array.isArray(votes)) continue;

    const tradeDir = (t.direction || '').toUpperCase();
    const isWin = t.outcome === 'win';

    for (const sig of votes) {
      const name = sig.name || 'unknown';
      const vote = (sig.vote || '').toUpperCase();
      if (!acc[name]) acc[name] = { total: 0, votedWithDir: 0, correct: 0 };
      const sa = acc[name];
      sa.total++;

      const votedWith = vote === tradeDir ||
        (tradeDir === 'LONG' && vote === 'BULLISH') ||
        (tradeDir === 'SHORT' && vote === 'BEARISH');

      if (votedWith) {
        sa.votedWithDir++;
        if (isWin) sa.correct++;
      }
    }
  }

  // Finalize
  for (const name of Object.keys(acc)) {
    const sa = acc[name];
    sa.accuracy = sa.votedWithDir > 0 ? sa.correct / sa.votedWithDir : 0.5;
  }
  return acc;
}

/**
 * Compute per-layer correlation: does a higher layer score predict wins?
 * Uses point-biserial correlation (simplified): compare avg layer score on wins vs losses.
 * Returns { layerName: { avgWin, avgLoss, delta, correlation, n } }
 */
function computeLayerCorrelation(trades) {
  const result = {};

  for (const [layer, field] of Object.entries(LAYER_FIELDS)) {
    const scored = trades.filter(t => t[field] != null && t[field] !== 0);
    if (scored.length < 10) {
      result[layer] = { avgWin: 0, avgLoss: 0, delta: 0, correlation: 0, n: scored.length };
      continue;
    }

    const wins  = scored.filter(t => t.outcome === 'win');
    const losses = scored.filter(t => t.outcome === 'loss');
    const avgWin  = wins.length  ? wins.reduce((s, t) => s + (parseFloat(t[field]) || 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + (parseFloat(t[field]) || 0), 0) / losses.length : 0;

    // Simple correlation proxy: (avgWin - avgLoss) / max score observed
    // Positive = layer predicts wins, negative = layer predicts losses
    const maxScore = Math.max(...scored.map(t => Math.abs(parseFloat(t[field]) || 0)), 1);
    const delta = avgWin - avgLoss;
    const correlation = delta / maxScore;

    result[layer] = {
      avgWin:  +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      delta:   +delta.toFixed(2),
      correlation: +correlation.toFixed(3),
      n: scored.length,
    };
  }

  return result;
}

/**
 * Compute conditional performance: accuracy of signal given regime/session context.
 * Returns { 'signalName×context': { accuracy, n } }
 */
function computeConditionalPerformance(trades) {
  const cond = {};

  for (const t of trades) {
    let votes;
    try { votes = typeof t.signal_votes === 'string' ? JSON.parse(t.signal_votes) : t.signal_votes; }
    catch { continue; }
    if (!Array.isArray(votes)) continue;

    const tradeDir = (t.direction || '').toUpperCase();
    const isWin = t.outcome === 'win';
    const regime = t.rviv_regime || 'NEUTRAL';
    const session = t.session || 'UNKNOWN';

    for (const sig of votes) {
      const name = sig.name || 'unknown';
      const vote = (sig.vote || '').toUpperCase();
      const votedWith = vote === tradeDir ||
        (tradeDir === 'LONG' && vote === 'BULLISH') ||
        (tradeDir === 'SHORT' && vote === 'BEARISH');

      if (!votedWith) continue; // only track when signal agreed with trade direction

      for (const ctx of [`${name}×${regime}`, `${name}×${session}`]) {
        if (!cond[ctx]) cond[ctx] = { correct: 0, total: 0 };
        cond[ctx].total++;
        if (isWin) cond[ctx].correct++;
      }
    }
  }

  for (const key of Object.keys(cond)) {
    const c = cond[key];
    c.accuracy = c.total > 0 ? +(c.correct / c.total).toFixed(3) : 0.5;
  }
  return cond;
}

// ─── Weight Multiplier Computation ───────────────────────────────────────────

/**
 * Derive weight multipliers from layer correlations and signal accuracies.
 *
 * Layer weights: based on correlation direction and strength.
 *   correlation > 0 → weight > 1.0 (layer predicts wins, amplify)
 *   correlation < 0 → weight < 1.0 (layer predicts losses, dampen)
 *   Clamped to [WEIGHT_FLOOR, WEIGHT_CEIL]
 *
 * Signal weights: based on accuracy relative to baseline (50%).
 *   accuracy > 55% → weight > 1.0
 *   accuracy < 45% → weight < 1.0
 */
function deriveWeightMultipliers(layerCorr, signalAcc, totalTrades) {
  const layerWeights = {};
  const signalWeights = {};

  if (totalTrades < MIN_TRADES_FOR_WEIGHT) {
    // Not enough data — return all 1.0 (no adjustment)
    for (const layer of Object.keys(LAYER_FIELDS)) layerWeights[layer] = 1.0;
    return { layerWeights, signalWeights, sufficient: false, totalTrades };
  }

  // Layer weights from correlation
  for (const [layer, stats] of Object.entries(layerCorr)) {
    if (stats.n < MIN_TRADES_FOR_WEIGHT) {
      layerWeights[layer] = 1.0;
      continue;
    }

    // Map correlation [-1, 1] → weight [FLOOR, CEIL]
    // correlation 0 → 1.0, correlation +1 → CEIL, correlation -1 → FLOOR
    const raw = 1.0 + stats.correlation;
    layerWeights[layer] = +Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, raw)).toFixed(2);
  }

  // Signal weights from accuracy
  for (const [name, stats] of Object.entries(signalAcc)) {
    if (stats.total < MIN_TRADES_FOR_WEIGHT) continue;
    // accuracy 0.5 → weight 1.0, accuracy 0.7 → 1.4, accuracy 0.3 → 0.6
    const raw = stats.accuracy * 2; // maps [0,1] → [0,2], centered at 1.0 for 0.5
    signalWeights[name] = +Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, raw)).toFixed(2);
  }

  return { layerWeights, signalWeights, sufficient: true, totalTrades };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Recompute the full scorecard from trade history and persist it.
 * Called after every trade by automation.js.
 */
function updateScorecard() {
  const allTrades = readJSON(TRADES_FILE, []);
  const n = allTrades.length;

  // Compute over multiple windows
  const windowResults = {};
  for (const [label, size] of Object.entries(WINDOWS)) {
    const slice = allTrades.slice(-size);
    windowResults[label] = {
      trades: slice.length,
      signalAccuracy: computeSignalAccuracy(slice),
      layerCorrelation: computeLayerCorrelation(slice),
      conditionalPerformance: computeConditionalPerformance(slice),
    };
  }

  // All-time
  windowResults.allTime = {
    trades: n,
    signalAccuracy: computeSignalAccuracy(allTrades),
    layerCorrelation: computeLayerCorrelation(allTrades),
    conditionalPerformance: computeConditionalPerformance(allTrades),
  };

  // Derive active weight multipliers from the medium window (200 trades)
  // Falls back to all-time if medium window doesn't have enough data
  const primaryWindow = windowResults.medium.trades >= MIN_TRADES_FOR_WEIGHT
    ? windowResults.medium
    : windowResults.allTime;

  const weights = deriveWeightMultipliers(
    primaryWindow.layerCorrelation,
    primaryWindow.signalAccuracy,
    primaryWindow.trades
  );

  const scorecard = {
    updated_at: new Date().toISOString(),
    totalTrades: n,
    windows: windowResults,
    activeWeights: weights,
  };

  writeJSON(SCORECARD_FILE, scorecard);
  return scorecard;
}

/**
 * Get the current weight multipliers for use in scalping-intelligence.js.
 * Returns { layerWeights: { tick: 0.7, ... }, signalWeights: { ... }, sufficient: bool }
 * If no scorecard exists, returns all 1.0 weights.
 */
function getWeightMultipliers() {
  const scorecard = readJSON(SCORECARD_FILE, null);
  if (!scorecard || !scorecard.activeWeights) {
    const defaults = {};
    for (const layer of Object.keys(LAYER_FIELDS)) defaults[layer] = 1.0;
    return { layerWeights: defaults, signalWeights: {}, sufficient: false, totalTrades: 0 };
  }
  return scorecard.activeWeights;
}

/**
 * Get the full scorecard for inspection.
 */
function getScorecard() {
  return readJSON(SCORECARD_FILE, null);
}

module.exports = {
  updateScorecard,
  getWeightMultipliers,
  getScorecard,
  // Exposed for testing
  computeSignalAccuracy,
  computeLayerCorrelation,
  computeConditionalPerformance,
};
