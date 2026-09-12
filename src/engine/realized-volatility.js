// Realized Volatility Engine
// Computes σ (standard deviation of log returns) from bar history
// Used to: classify vol regime, compute vol-proportional stop/target distances

// ─── Core σ Computation ───────────────────────────────────────────────────────

/**
 * Compute realized volatility (σ) as std dev of log returns over N bars.
 * Returns a per-bar σ (not annualized) suitable for intraday stop placement.
 * @param {Array} bars  - Array of bar objects with .close field, newest first
 * @param {number} lookback - Number of bars to use (default 20 = ~100 min on 5m bars)
 * @returns {number} σ as a decimal (e.g. 0.0045 = 0.45%)
 */
function computeRealizedVol(bars, lookback = 20) {
  if (!bars || bars.length < lookback + 1) {
    // Not enough data — return a safe default (medium volatility)
    return 0.005;
  }

  const slice = bars.slice(0, lookback + 1); // newest first
  const logReturns = [];

  for (let i = 0; i < lookback; i++) {
    const curr = slice[i].close;
    const prev = slice[i + 1].close;
    if (!curr || !prev || prev === 0) continue;
    logReturns.push(Math.log(curr / prev));
  }

  if (logReturns.length < 5) return 0.005;

  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance);
}

// ─── Vol Regime Classification ────────────────────────────────────────────────

/**
 * Classify the volatility regime from σ.
 * Thresholds tuned for MES/ES 5-minute bars.
 * @param {number} sigma
 * @returns {'LOW'|'MEDIUM'|'HIGH'|'SPIKE'}
 */
function classifyVolRegime(sigma) {
  if (sigma < 0.0015) return 'LOW';
  if (sigma < 0.004)  return 'MEDIUM';
  if (sigma < 0.008)  return 'HIGH';
  return 'SPIKE';
}

// ─── Expected Move ────────────────────────────────────────────────────────────

/**
 * Compute expected intraday price move in points.
 * Uses σ × price × √barsPerSession as a rough 1-day expected range.
 * @param {number} sigma          - Per-bar realized vol
 * @param {number} currentPrice   - Current MES price (e.g. 5000)
 * @param {number} barsPerSession - 5m bars in a trading session (~78 = 6.5 hrs)
 * @returns {number} Expected move in points
 */
function computeExpectedMove(sigma, currentPrice, barsPerSession = 78) {
  return sigma * currentPrice * Math.sqrt(barsPerSession);
}

// ─── Vol-Proportional Stops ───────────────────────────────────────────────────

/**
 * Compute stop and target distances (in ticks) proportional to σ, sized for scalping.
 *
 * Scalping stops are a fraction of the full 1-bar expected range.
 * We use σ × price / tickSize / SCALP_DIVISOR to get a practical scalping stop:
 *   - LOW vol  (σ<0.0015): ~2-3 ticks stop
 *   - MEDIUM   (σ 0.0015-0.004): ~3-5 ticks
 *   - HIGH     (σ 0.004-0.008): ~5-8 ticks
 *   - SPIKE    (σ>0.008): capped at 10 ticks
 *
 * The SCALP_DIVISOR = 8 converts from full-bar σ to sub-bar scalp sizing.
 * target = 2× stop (maintains 2:1 R:R)
 *
 * @param {number} sigma      - Per-bar realized vol (e.g. 0.003)
 * @param {number} price      - Current price (e.g. 5000)
 * @param {number} tickSize   - Tick size in points (MES = 0.25)
 * @returns {{ stopTicks: number, targetTicks: number }}
 */
function volProportionalStops(sigma, price, tickSize = 0.25) {
  const SCALP_DIVISOR = 8;  // Converts 1-bar σ to scalping stop size
  const rawStopPoints = (sigma * price) / SCALP_DIVISOR;
  const rawStopTicks  = rawStopPoints / tickSize;

  // Clamp between 4 ticks (TopstepX minimum bracket distance) and 10 ticks (max scalping stop)
  const stopTicks   = Math.max(4, Math.min(10, Math.round(rawStopTicks)));
  const targetTicks = stopTicks * 2;

  return { stopTicks, targetTicks };
}

// ─── VWAP Displacement Check ──────────────────────────────────────────────────

/**
 * Determine if price is displaced from VWAP by more than 1σ (in price terms).
 * Used by Path B (VWAP mean reversion) to confirm entry signal.
 *
 * @param {number} currentPrice
 * @param {number} vwap
 * @param {number} sigma       - Per-bar vol
 * @param {number} price       - Same as currentPrice (for scaling)
 * @returns {{ displaced: boolean, sigmas: number, direction: 'LONG'|'SHORT' }}
 *          direction = direction of the FADE trade (opposite of displacement)
 */
function vwapDisplacementCheck(currentPrice, vwap, sigma) {
  // Scale by VWAP (not currentPrice) so σ is measured relative to the anchor,
  // not the displaced price — avoids systematically underestimating displacement.
  const sigmaPoints = sigma * vwap;
  const displacement = currentPrice - vwap;
  const sigmas = Math.abs(displacement) / sigmaPoints;

  return {
    displaced: sigmas >= 1.0,
    sigmas: parseFloat(sigmas.toFixed(2)),
    // If price is above VWAP, fade = go SHORT (sell into the high); vice versa
    direction: displacement > 0 ? 'SHORT' : 'LONG'
  };
}

// ─── RV/IV Ratio ──────────────────────────────────────────────────────────────

/**
 * Compare realized volatility to implied volatility (VIX) to classify
 * the market's current character: TRENDING (RV > IV) vs RANGING (RV < IV).
 *
 * @param {number} sigma - Per-5m-bar realized vol from computeRealizedVol()
 * @param {number} vix   - Live VIX value (percent, e.g. 15.0)
 * @returns {{ ratio: number, regime: 'TRENDING'|'RANGING'|'NEUTRAL', dailyRV: number|null, dailyIV: number|null }}
 */
function computeRVIVRatio(sigma, vix) {
  if (!sigma || !vix || vix <= 0) return { ratio: 1.0, regime: 'NEUTRAL', dailyRV: null, dailyIV: null };

  const BARS_PER_SESSION = 78;   // 5m bars in 6.5hr session
  const TRADING_DAYS = 252;

  const dailyRV = sigma * Math.sqrt(BARS_PER_SESSION); // scale per-bar σ to daily
  const dailyIV = (vix / 100) / Math.sqrt(TRADING_DAYS); // VIX annualized → daily

  const ratio = dailyRV / dailyIV;

  const regime = ratio > 1.3 ? 'TRENDING' :  // market moving more than priced → momentum works
                 ratio < 0.8 ? 'RANGING'  :  // market calm → mean reversion works
                               'NEUTRAL';    // Threshold raised from 0.7 → 0.8 per Carr & Wu (2008):
                                             // VIX structurally exceeds RV by ~3-5 vol pts, so RANGING
                                             // fired too rarely at 0.7 in normal (non-stressed) markets.

  return { ratio: parseFloat(ratio.toFixed(3)), regime, dailyRV, dailyIV };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  computeRealizedVol,
  classifyVolRegime,
  computeExpectedMove,
  volProportionalStops,
  vwapDisplacementCheck,
  computeRVIVRatio
};
