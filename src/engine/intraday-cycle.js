// Intraday Session Cycle Engine
// Classifies the current market session phase (CT time) and provides
// confidence threshold adjustments and volume expectations per phase.
//
// MES/ES trading hours: 8:30 AM – 2:45 PM CT (Sunday–Friday)
// Prime scalp windows: MIDMORNING (9:30–11:00) and CLOSE_RUSH (13:00–14:45)

// ─── Session Phase Definitions ────────────────────────────────────────────────

const PHASES = {
  PRE_MARKET:   'PRE_MARKET',   // before 8:30 CT
  OPEN_RUSH:    'OPEN_RUSH',    // 8:30–9:30 CT  — volatile, wide spreads
  MIDMORNING:   'MIDMORNING',   // 9:30–11:00 CT — prime scalp window
  MIDDAY_CHOP:  'MIDDAY_CHOP',  // 11:00–13:00 CT — low vol, choppy
  CLOSE_RUSH:   'CLOSE_RUSH',   // 13:00–14:45 CT — second prime window
  AFTER_HOURS:  'AFTER_HOURS'   // after 14:45 CT  — skip trading (3:45 PM ET low volume)
};

// Confidence threshold adjustment per phase (added to the base 55 threshold)
// Higher = harder to trade in that phase
const THRESHOLD_ADJUSTMENTS = {
  PRE_MARKET:  99,  // effectively blocked (added to 55 → 154, never reached)
  OPEN_RUSH:   10,  // +10: require stronger signal during volatile open
  MIDMORNING:  0,   // no adjustment: prime window
  MIDDAY_CHOP: 15,  // +15: much harder to get signal approved in chop
  CLOSE_RUSH:  0,   // no adjustment: prime window
  AFTER_HOURS: 99   // effectively blocked
};

// Expected relative volume level (1.0 = normal; used for vol score normalization)
const VOLUME_EXPECTATIONS = {
  PRE_MARKET:  0.3,
  OPEN_RUSH:   2.5,
  MIDMORNING:  1.3,
  MIDDAY_CHOP: 0.6,
  CLOSE_RUSH:  1.8,
  AFTER_HOURS: 0.2
};

// ─── Phase Detection ──────────────────────────────────────────────────────────

/**
 * Get the current session phase based on CT (Central Time) clock.
 * @param {Date} [now] - Optional override for testing
 * @returns {string} One of the PHASES values
 */
function getSessionPhase(now) {
  const date = now || new Date();

  // Convert to Central Time (UTC-6 standard, UTC-5 daylight)
  // We use a fixed offset check based on US DST rules for accuracy
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  const isDST  = isDaylightSaving(date);
  const ctOffset = isDST ? -5 * 3600 * 1000 : -6 * 3600 * 1000;
  const ctDate = new Date(utcMs + ctOffset);

  const dow = ctDate.getDay(); // 0=Sun, 6=Sat
  const h = ctDate.getHours();
  const m = ctDate.getMinutes();
  const totalMin = h * 60 + m;

  // Weekend gate — MES/ES Globex is closed Saturday all day and Sunday before 17:00 CT.
  // Return AFTER_HOURS so the automation cycle skips trading entirely.
  if (dow === 6) return PHASES.AFTER_HOURS; // Saturday
  if (dow === 0 && totalMin < 17 * 60) return PHASES.AFTER_HOURS; // Sunday before 5 PM CT

  // Phase boundaries (in minutes since midnight CT) — weekdays only
  const T_OPEN       = 8 * 60 + 30;   // 08:30
  const T_MIDMORNING = 9 * 60 + 30;   // 09:30
  const T_MIDDAY     = 11 * 60;       // 11:00
  const T_CLOSE      = 13 * 60;       // 13:00
  const T_AFTER      = 14 * 60 + 45;  // 14:45 CT = 3:45 PM ET — cut off before low-volume close

  if (totalMin < T_OPEN)       return PHASES.PRE_MARKET;
  if (totalMin < T_MIDMORNING) return PHASES.OPEN_RUSH;
  if (totalMin < T_MIDDAY)     return PHASES.MIDMORNING;
  if (totalMin < T_CLOSE)      return PHASES.MIDDAY_CHOP;
  if (totalMin < T_AFTER)      return PHASES.CLOSE_RUSH;
  return PHASES.AFTER_HOURS;
}

/**
 * Determine if current date observes US Daylight Saving Time.
 * DST: second Sunday of March → first Sunday of November
 */
function isDaylightSaving(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

// ─── Threshold & Volume Helpers ───────────────────────────────────────────────

/**
 * Get the confidence threshold adjustment for the given phase.
 * Add this to the base shouldScalp threshold (55).
 * @param {string} phase
 * @returns {number}
 */
function getCycleMultiplier(phase) {
  return THRESHOLD_ADJUSTMENTS[phase] ?? 99;
}

/**
 * Get the expected relative volume for the given phase.
 * Used to normalize volume readings (actual / expectation).
 * @param {string} phase
 * @returns {number}
 */
function getVolumeExpectation(phase) {
  return VOLUME_EXPECTATIONS[phase] ?? 1.0;
}

/**
 * Returns full cycle context object for use in automation.js
 * @param {Date}   [now]
 * @param {object} [adaptiveAdjustments] - Per-phase ±N adjustments from historical win-rate
 * @returns {{ phase, thresholdAdjustment, volumeExpectation, tradingAllowed, adaptiveAdj }}
 */
function getCycleContext(now, adaptiveAdjustments = {}) {
  const phase   = getSessionPhase(now);
  const baseAdj = getCycleMultiplier(phase);

  // Apply adaptive calibration — blocked phases (99) are never adjusted
  const rawAdaptive    = adaptiveAdjustments[phase] ?? 0;
  const adaptiveAdj    = baseAdj === 99 ? 0 : Math.max(-10, Math.min(10, rawAdaptive));
  const thresholdAdjustment = baseAdj + adaptiveAdj;

  return {
    phase,
    thresholdAdjustment,
    volumeExpectation: getVolumeExpectation(phase),
    tradingAllowed: phase !== PHASES.PRE_MARKET && phase !== PHASES.AFTER_HOURS,
    adaptiveAdj
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  PHASES,
  getSessionPhase,
  getCycleMultiplier,
  getVolumeExpectation,
  getCycleContext
};
