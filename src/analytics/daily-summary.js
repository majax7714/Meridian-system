// Daily Summary Generator — Layer 1 of the analytics system
// Produces data/daily/YYYY-MM-DD.json with pre-computed aggregates.
// Run on startup for previous day, or on-demand via generateDailySummary(dateStr).

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '../../data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true });

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

function dateStr(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function bucket(val, boundaries) {
  // boundaries = [[label, min, max], ...] — returns first matching label
  for (const [label, min, max] of boundaries) {
    if (val >= min && val < max) return label;
  }
  return 'other';
}

function pct(n, d) { return d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '0.0%'; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Generate a daily summary for the given date string (YYYY-MM-DD).
 * Reads all trades, filters to that date, computes aggregates, writes to file.
 * @param {string} targetDate - e.g. '2026-02-24'
 * @param {object} [opts] - { force: true to overwrite existing }
 * @returns {object|null} The summary object, or null if no trades for that date
 */
function generateDailySummary(targetDate, opts = {}) {
  const outFile = path.join(DAILY_DIR, `${targetDate}.json`);
  if (!opts.force && fs.existsSync(outFile)) {
    return readJSON(outFile, null);
  }

  const allTrades = readJSON(TRADES_FILE, []);
  const trades = allTrades.filter(t => dateStr(t.timestamp || t.created_at) === targetDate);

  if (trades.length === 0) return null;

  const wins  = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');

  // ── Overall stats ─────────────────────────────────────────────────────────
  const overall = {
    date:       targetDate,
    totalTrades: trades.length,
    wins:       wins.length,
    losses:     losses.length,
    winRate:    pct(wins.length, trades.length),
    netPnL:     trades.reduce((s, t) => s + (t.profit_loss || 0), 0),
    avgPnL:     avg(trades.map(t => t.profit_loss || 0)),
    avgConfidence: avg(trades.map(t => parseFloat(t.confidence) || 0)),
    avgHoldTime:   avg(trades.filter(t => t.duration_seconds).map(t => t.duration_seconds)),
  };

  // ── Factor Performance Matrix ─────────────────────────────────────────────
  // Cross-tabulate key dimensions
  const matrix = {};

  function addToMatrix(dimName, key, trade) {
    if (!matrix[dimName]) matrix[dimName] = {};
    if (!matrix[dimName][key]) matrix[dimName][key] = { trades: 0, wins: 0, pnl: 0 };
    const b = matrix[dimName][key];
    b.trades++;
    if (trade.outcome === 'win') b.wins++;
    b.pnl += (trade.profit_loss || 0);
  }

  const confBands = [
    ['45-55', 45, 55], ['55-60', 55, 60], ['60-65', 60, 65],
    ['65-70', 65, 70], ['70-75', 70, 75], ['75-80', 75, 80], ['80+', 80, 200]
  ];

  const stopBuckets = [
    ['1-3', 1, 4], ['4-6', 4, 7], ['7-10', 7, 11], ['11-15', 11, 16], ['16+', 16, 999]
  ];

  for (const t of trades) {
    const conf = parseFloat(t.confidence) || 0;
    const session = t.session || 'UNKNOWN';
    const regime  = t.rviv_regime || 'NEUTRAL';
    const dir     = t.direction || 'UNKNOWN';
    const tPath   = t.path || 'UNKNOWN';
    const entryType = t.entry_type || 'UNKNOWN';
    const exitReason = t.exit_reason || 'UNKNOWN';

    // Session × Regime
    addToMatrix('session_x_regime', `${session}×${regime}`, t);
    // Session alone
    addToMatrix('session', session, t);
    // Regime alone
    addToMatrix('regime', regime, t);
    // Path × Confidence band
    const cBand = bucket(conf, confBands);
    addToMatrix('path_x_confidence', `${tPath}×${cBand}`, t);
    // Confidence band alone
    addToMatrix('confidence_band', cBand, t);
    // Direction × Session
    addToMatrix('direction_x_session', `${dir}×${session}`, t);
    // Direction alone
    addToMatrix('direction', dir, t);
    // Entry type
    addToMatrix('entry_type', entryType, t);
    // Exit reason
    addToMatrix('exit_reason', exitReason, t);
    // Path alone
    addToMatrix('path', tPath, t);

    // Stop distance bucket
    if (t.entry && t.stop_loss) {
      const stopTicks = Math.round(Math.abs(t.entry - t.stop_loss) / 0.25);
      const sBucket = bucket(stopTicks, stopBuckets);
      addToMatrix('stop_bucket', sBucket, t);
      addToMatrix('stop_bucket_x_entry_type', `${sBucket}×${entryType}`, t);
    }
  }

  // Finalize matrix: add winRate to each cell
  for (const dim of Object.keys(matrix)) {
    for (const key of Object.keys(matrix[dim])) {
      const cell = matrix[dim][key];
      cell.winRate = pct(cell.wins, cell.trades);
      cell.avgPnL = cell.trades > 0 ? +(cell.pnl / cell.trades).toFixed(2) : 0;
      cell.pnl = +cell.pnl.toFixed(2);
    }
  }

  // ── Per-signal accuracy ───────────────────────────────────────────────────
  const signalAccuracy = {};

  for (const t of trades) {
    let votes;
    try { votes = typeof t.signal_votes === 'string' ? JSON.parse(t.signal_votes) : t.signal_votes; }
    catch { continue; }
    if (!Array.isArray(votes)) continue;

    const tradeDir = (t.direction || '').toUpperCase();
    const isWin = t.outcome === 'win';

    for (const sig of votes) {
      const name = sig.name || sig.signal || 'unknown';
      const vote = (sig.vote || '').toUpperCase();
      if (!signalAccuracy[name]) signalAccuracy[name] = { total: 0, correct: 0, wins: 0, losses: 0, votedWithDir: 0 };
      const sa = signalAccuracy[name];
      sa.total++;

      // "Correct" = signal voted in the direction that won, or NEUTRAL and we won
      const votedWithDirection = vote === tradeDir ||
        (tradeDir === 'LONG' && vote === 'BULLISH') ||
        (tradeDir === 'SHORT' && vote === 'BEARISH');

      if (votedWithDirection) sa.votedWithDir++;
      if (isWin) { sa.wins++; if (votedWithDirection) sa.correct++; }
      else { sa.losses++; }
    }
  }

  for (const name of Object.keys(signalAccuracy)) {
    const sa = signalAccuracy[name];
    sa.accuracy = sa.votedWithDir > 0 ? pct(sa.correct, sa.votedWithDir) : 'N/A';
    sa.winRateWhenVotedWith = sa.votedWithDir > 0 ? pct(sa.correct, sa.votedWithDir) : 'N/A';
    sa.prevalence = pct(sa.votedWithDir, sa.total);
  }

  // ── Per-layer contribution ────────────────────────────────────────────────
  const layers = ['macro', 'futures', 'micro', 'tick', 'execution', 'cross_asset'];
  const layerContribution = {};

  for (const layer of layers) {
    const field = `score_${layer}`;
    const winScores  = wins.map(t => parseFloat(t[field]) || 0);
    const lossScores = losses.map(t => parseFloat(t[field]) || 0);
    layerContribution[layer] = {
      avgOnWins:   +avg(winScores).toFixed(2),
      avgOnLosses: +avg(lossScores).toFixed(2),
      delta:       +(avg(winScores) - avg(lossScores)).toFixed(2),
      maxOnWins:   winScores.length ? +Math.max(...winScores).toFixed(1) : 0,
      maxOnLosses: lossScores.length ? +Math.max(...lossScores).toFixed(1) : 0,
    };
  }

  // ── MFE/MAE summary ──────────────────────────────────────────────────────
  const losersWithMFE = losses.filter(t => (t.max_favorable_excursion || 0) > 0);
  const mfeMaeSummary = {
    losersWithPositiveMFE: losersWithMFE.length,
    losersWithPositiveMFEPct: pct(losersWithMFE.length, losses.length),
    avgLoserMFE: +avg(losersWithMFE.map(t => t.max_favorable_excursion)).toFixed(3),
    avgLoserMAE: +avg(losses.map(t => Math.abs(t.max_adverse_excursion || 0))).toFixed(3),
    avgWinnerMAE: +avg(wins.map(t => Math.abs(t.max_adverse_excursion || 0))).toFixed(3),
  };

  // ── Best/worst segments ───────────────────────────────────────────────────
  // Find the best and worst 3 cells across all matrix dimensions
  const allCells = [];
  for (const dim of Object.keys(matrix)) {
    for (const key of Object.keys(matrix[dim])) {
      const cell = matrix[dim][key];
      if (cell.trades >= 3) {
        allCells.push({ dimension: dim, key, ...cell });
      }
    }
  }
  allCells.sort((a, b) => b.pnl - a.pnl);
  const bestSegments = allCells.slice(0, 5);
  const worstSegments = allCells.slice(-5).reverse();

  // ── Assemble summary ─────────────────────────────────────────────────────
  const summary = {
    generated_at: new Date().toISOString(),
    overall,
    matrix,
    signalAccuracy,
    layerContribution,
    mfeMaeSummary,
    bestSegments,
    worstSegments,
  };

  writeJSON(outFile, summary);
  console.log(`[DailySummary] Generated ${outFile} (${trades.length} trades)`);
  return summary;
}

/**
 * Generate summary for previous trading day if not already generated.
 * Called on startup.
 */
function generatePreviousDaySummary() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yd = yesterday.toISOString().slice(0, 10);
  return generateDailySummary(yd);
}

/**
 * List all available daily summary files.
 * @returns {string[]} Array of date strings with available summaries
 */
function listDailySummaries() {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort();
}

/**
 * Load a specific daily summary.
 * @param {string} targetDate - YYYY-MM-DD
 * @returns {object|null}
 */
function loadDailySummary(targetDate) {
  const file = path.join(DAILY_DIR, `${targetDate}.json`);
  return readJSON(file, null);
}

module.exports = {
  generateDailySummary,
  generatePreviousDaySummary,
  listDailySummaries,
  loadDailySummary,
};
