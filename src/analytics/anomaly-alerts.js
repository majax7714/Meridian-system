// Anomaly Alerts — Layer 3 of the analytics system
// Lightweight intraday pattern detection. Runs every N cycles during trading.
// Returns an array of alert objects that automation.js logs to console.
// Does NOT block trades — surfaces information for awareness.

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '../../data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

// ─── Alert Checks ─────────────────────────────────────────────────────────────

/**
 * Check for session-specific win rate degradation today.
 * Alert if a session has ≥5 trades and WR ≤ 35%.
 */
function checkSessionWR(todayTrades) {
  const alerts = [];
  const bySession = {};
  for (const t of todayTrades) {
    const s = t.session || 'UNKNOWN';
    if (!bySession[s]) bySession[s] = { total: 0, wins: 0, pnl: 0 };
    bySession[s].total++;
    if (t.outcome === 'win') bySession[s].wins++;
    bySession[s].pnl += (t.profit_loss || 0);
  }
  for (const [session, stats] of Object.entries(bySession)) {
    if (stats.total >= 5) {
      const wr = stats.wins / stats.total;
      if (wr <= 0.35) {
        alerts.push({
          severity: 'warning',
          type: 'SESSION_WR_DEGRADATION',
          message: `${session}: ${stats.wins}W/${stats.total - stats.wins}L (${(wr * 100).toFixed(0)}% WR, $${stats.pnl.toFixed(2)}) — session is bleeding`,
        });
      }
    }
  }
  return alerts;
}

/**
 * Check for layer inflation on recent losers.
 * Alert if a layer's avg score on the last 5 losers is significantly higher
 * than on the last 5 winners — means the layer is adding false confidence.
 */
function checkLayerInflation(todayTrades) {
  const alerts = [];
  const recentWins  = todayTrades.filter(t => t.outcome === 'win').slice(-5);
  const recentLosses = todayTrades.filter(t => t.outcome === 'loss').slice(-5);

  if (recentWins.length < 3 || recentLosses.length < 3) return alerts;

  const layers = [
    ['TICK', 'score_tick'],
    ['MACRO', 'score_macro'],
    ['FUTURES', 'score_futures'],
    ['MICRO', 'score_micro'],
    ['EXECUTION', 'score_execution'],
    ['CROSS_ASSET', 'score_cross_asset'],
  ];

  for (const [name, field] of layers) {
    const avgOnWins  = recentWins.reduce((s, t) => s + (parseFloat(t[field]) || 0), 0) / recentWins.length;
    const avgOnLosses = recentLosses.reduce((s, t) => s + (parseFloat(t[field]) || 0), 0) / recentLosses.length;

    // Alert if layer scores higher on losers by ≥5 points
    if (avgOnLosses > avgOnWins + 5) {
      alerts.push({
        severity: 'warning',
        type: 'LAYER_INFLATION',
        message: `${name} layer: avg ${avgOnLosses.toFixed(1)} on last ${recentLosses.length} losers vs ${avgOnWins.toFixed(1)} on last ${recentWins.length} winners — inflating confidence on bad trades`,
      });
    }
  }
  return alerts;
}

/**
 * Check for stop distance anomalies on recent trades.
 * Alert if avg stop distance on last 5 trades exceeds 15 ticks.
 */
function checkStopAnomalies(todayTrades) {
  const alerts = [];
  const recent = todayTrades.slice(-5);
  if (recent.length < 3) return alerts;

  const stopTicks = recent
    .filter(t => t.entry && t.stop_loss)
    .map(t => Math.round(Math.abs(t.entry - t.stop_loss) / 0.25));

  if (stopTicks.length === 0) return alerts;
  const avgStop = stopTicks.reduce((s, v) => s + v, 0) / stopTicks.length;

  if (avgStop > 15) {
    alerts.push({
      severity: 'warning',
      type: 'WIDE_STOPS',
      message: `Avg stop on last ${stopTicks.length} trades: ${avgStop.toFixed(1)} ticks — check tick-perfect stop cap`,
    });
  }
  return alerts;
}

/**
 * Check for overtrading rate.
 * Alert if more than 12 trades in the last 60 minutes.
 */
function checkOvertradingRate(todayTrades) {
  const alerts = [];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentHour = todayTrades.filter(t => (t.timestamp || t.created_at) >= oneHourAgo);

  if (recentHour.length > 12) {
    const wr = recentHour.filter(t => t.outcome === 'win').length / recentHour.length;
    alerts.push({
      severity: recentHour.length > 18 ? 'critical' : 'warning',
      type: 'OVERTRADING',
      message: `${recentHour.length} trades in last 60min (${(wr * 100).toFixed(0)}% WR) — high frequency, verify edge is present`,
    });
  }
  return alerts;
}

/**
 * Check for consecutive loss streak currently in progress.
 * Alert at 3+ consecutive losses (beyond the circuit breaker trigger)
 * because it may indicate a regime shift within the session.
 */
function checkLossStreak(todayTrades) {
  const alerts = [];
  if (todayTrades.length < 3) return alerts;

  let streak = 0;
  for (let i = todayTrades.length - 1; i >= 0; i--) {
    if (todayTrades[i].outcome === 'loss') streak++;
    else break;
  }

  if (streak >= 3) {
    // Check if the losses share a common dimension (same session, same direction)
    const streakTrades = todayTrades.slice(-streak);
    const sessions = [...new Set(streakTrades.map(t => t.session))];
    const directions = [...new Set(streakTrades.map(t => t.direction))];

    let detail = '';
    if (sessions.length === 1) detail += ` all in ${sessions[0]}`;
    if (directions.length === 1) detail += ` all ${directions[0]}`;

    alerts.push({
      severity: streak >= 5 ? 'critical' : 'warning',
      type: 'LOSS_STREAK',
      message: `${streak} consecutive losses${detail} — circuit breaker should be active`,
    });
  }
  return alerts;
}

/**
 * Check for regime×session combination that has historically poor performance.
 * Uses today's data only (no external lookback).
 */
function checkToxicCombination(todayTrades) {
  const alerts = [];
  const combos = {};
  for (const t of todayTrades) {
    const key = `${t.session || 'UNK'}×${t.rviv_regime || 'NEUTRAL'}`;
    if (!combos[key]) combos[key] = { total: 0, wins: 0, pnl: 0 };
    combos[key].total++;
    if (t.outcome === 'win') combos[key].wins++;
    combos[key].pnl += (t.profit_loss || 0);
  }

  for (const [combo, stats] of Object.entries(combos)) {
    if (stats.total >= 5 && stats.pnl < -20) {
      const wr = ((stats.wins / stats.total) * 100).toFixed(0);
      alerts.push({
        severity: 'warning',
        type: 'TOXIC_COMBINATION',
        message: `${combo}: ${stats.total} trades, ${wr}% WR, $${stats.pnl.toFixed(2)} — consider gating this combination`,
      });
    }
  }
  return alerts;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run all anomaly checks on today's trades.
 * @returns {{ alerts: Array<{severity, type, message}>, checked_at: string }}
 */
function checkAnomalies() {
  const allTrades = readJSON(TRADES_FILE, []);

  // Filter to today
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();
  const todayTrades = allTrades.filter(t => (t.timestamp || t.created_at) >= cutoff);

  if (todayTrades.length < 3) {
    return { alerts: [], checked_at: new Date().toISOString(), tradesToday: todayTrades.length };
  }

  const alerts = [
    ...checkSessionWR(todayTrades),
    ...checkLayerInflation(todayTrades),
    ...checkStopAnomalies(todayTrades),
    ...checkOvertradingRate(todayTrades),
    ...checkLossStreak(todayTrades),
    ...checkToxicCombination(todayTrades),
  ];

  return {
    alerts,
    checked_at: new Date().toISOString(),
    tradesToday: todayTrades.length,
  };
}

module.exports = {
  checkAnomalies,
};
