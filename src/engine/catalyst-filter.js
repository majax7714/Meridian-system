// Catalyst Filter v2 — Multi-class Weighted Event Taxonomy + FinBERT
// Fetches weekly economic calendar from faireconomy.media (free, no key required).
// Cache TTL: 4 hours.
//
// v2 architecture:
//   - Event taxonomy: 12 categories with individual pre/post windows + decay half-lives
//   - FinBERT TRC2 tone → equity direction via per-category translation rule
//   - Surprise factor from actual vs forecast (amplifies post-event penalty)
//   - Confidence penalty decays exponentially (not hard binary block)
//   - Per-layer score adjustments fed to ScalpingIntelligence
//
// Direction rules:
//   DIRECT         — FinBERT positive → BULLISH, negative → BEARISH  (jobs, growth, consumer)
//   INVERSE        — FinBERT positive → BEARISH, negative → BULLISH  (inflation data)
//   HAWKISH_INVERSE — Fed events: hawkish tone (positive/confident) → BEARISH ES
//   NEUTRAL        — No directional inference (treasury auctions, minute releases)

'use strict';

const { execSync } = require('child_process');
const db = require('../storage/db');

const CACHE_KEY    = 'economicCalendar';
const CACHE_TTL    = 4 * 60 * 60 * 1000;
const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// ─── Event Taxonomy ───────────────────────────────────────────────────────────
// preWindow / postWindow in minutes. decayHalf = half-life of penalty decay.
// maxPenalty = confidence points subtracted at t=0 post-event (decays to 0).
// layerWeights applied proportionally to current penalty ratio (penalty / maxPenalty).

const TAXONOMY = [
  {
    category:      'FED_DECISION',
    patterns:      [/federal open market|fomc rate|fed funds rate|interest rate decision/i],
    preWindow:     60,
    postWindow:    90,
    decayHalf:     120,
    maxPenalty:    30,
    directionRule: 'HAWKISH_INVERSE',
    layerWeights:  { MACRO: -8, TICK: -15, FUTURES: -5, MICRO: -5 }
  },
  {
    category:      'FED_SPEAKER',
    patterns:      [/fed chair|chair powell|fed governor|fomc member|federal reserve speak|yellen|waller|kugler|bowman|barr|jefferson/i],
    preWindow:     30,
    postWindow:    45,
    decayHalf:     60,
    maxPenalty:    15,
    directionRule: 'HAWKISH_INVERSE',
    layerWeights:  { MACRO: -5, TICK: -8, FUTURES: -3, MICRO: -3 }
  },
  {
    category:      'INFLATION_TIER1',
    patterns:      [/consumer price index|(?<!\w)cpi(?!\w)|core cpi|personal consumption expenditure|(?<!\w)pce(?!\w)|core pce/i],
    preWindow:     30,
    postWindow:    60,
    decayHalf:     60,
    maxPenalty:    25,
    directionRule: 'INVERSE',   // hot inflation = bearish ES despite positive journalism tone
    layerWeights:  { MACRO: -8, TICK: -12, FUTURES: -5, MICRO: -3 }
  },
  {
    category:      'INFLATION_TIER2',
    patterns:      [/producer price|(?<!\w)ppi(?!\w)|import price|export price/i],
    preWindow:     20,
    postWindow:    30,
    decayHalf:     30,
    maxPenalty:    12,
    directionRule: 'INVERSE',
    layerWeights:  { MACRO: -5, TICK: -8, FUTURES: -3, MICRO: -2 }
  },
  {
    category:      'EMPLOYMENT_TIER2',
    patterns:      [/adp (?:employment|non.?farm)|initial jobless|continuing claims|(?<!\w)jolts(?!\w)/i],
    preWindow:     20,
    postWindow:    25,
    decayHalf:     25,
    maxPenalty:    10,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -3, TICK: -8, FUTURES: -2, MICRO: -2 }
  },
  {
    category:      'EMPLOYMENT_TIER1',
    patterns:      [/non.?farm (?:payroll|employment change)|(?<!\w)nfp(?!\w)|unemployment rate/i],
    preWindow:     30,
    postWindow:    45,
    decayHalf:     45,
    maxPenalty:    22,
    directionRule: 'DIRECT',    // strong jobs = risk-on = bullish ES
    layerWeights:  { MACRO: -6, TICK: -12, FUTURES: -4, MICRO: -3 }
  },
  {
    category:      'GROWTH',
    patterns:      [/gross domestic product|(?<!\w)gdp(?!\w)|retail sales|industrial production|durable goods/i],
    preWindow:     20,
    postWindow:    30,
    decayHalf:     30,
    maxPenalty:    15,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -5, TICK: -8, FUTURES: -3, MICRO: -2 }
  },
  {
    category:      'MANUFACTURING',
    patterns:      [/ism manufacturing|manufacturing pmi|chicago pmi|empire state/i],
    preWindow:     15,
    postWindow:    20,
    decayHalf:     20,
    maxPenalty:    8,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -3, TICK: -5, FUTURES: -2, MICRO: -1 }
  },
  {
    category:      'SERVICES',
    patterns:      [/ism services|services pmi|composite pmi/i],
    preWindow:     15,
    postWindow:    20,
    decayHalf:     20,
    maxPenalty:    8,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -3, TICK: -5, FUTURES: -2, MICRO: -1 }
  },
  {
    category:      'CONSUMER',
    patterns:      [/consumer confidence|consumer sentiment|michigan sentiment/i],
    preWindow:     15,
    postWindow:    20,
    decayHalf:     20,
    maxPenalty:    6,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -2, TICK: -4, FUTURES: -1, MICRO: -1 }
  },
  {
    category:      'HOUSING',
    patterns:      [/existing home|new home sales|building permits|housing starts/i],
    preWindow:     10,
    postWindow:    15,
    decayHalf:     15,
    maxPenalty:    5,
    directionRule: 'DIRECT',
    layerWeights:  { MACRO: -2, TICK: -3, FUTURES: -1, MICRO: -1 }
  },
  {
    category:      'TREASURY',
    patterns:      [/treasury auction|bond auction|t-bill|t-note|t-bond auction/i],
    preWindow:     10,
    postWindow:    15,
    decayHalf:     15,
    maxPenalty:    5,
    directionRule: 'NEUTRAL',
    layerWeights:  { MACRO: -2, TICK: -3, FUTURES: -3, MICRO: -1 }
  }
];

// Fallback for unrecognized High-impact events
const UNKNOWN_TAXONOMY = {
  category:      'UNKNOWN_HIGH',
  preWindow:     30,
  postWindow:    30,
  decayHalf:     30,
  maxPenalty:    15,
  directionRule: 'NEUTRAL',
  layerWeights:  { MACRO: -5, TICK: -8, FUTURES: -3, MICRO: -2 }
};

// ─── Classify event by title ──────────────────────────────────────────────────

function classifyEvent(title) {
  if (!title) return UNKNOWN_TAXONOMY;
  for (const entry of TAXONOMY) {
    for (const pattern of entry.patterns) {
      if (pattern.test(title)) return entry;
    }
  }
  return UNKNOWN_TAXONOMY;
}

// ─── Surprise factor ──────────────────────────────────────────────────────────

/**
 * Normalized surprise factor in [-1, 1].
 * Positive = beat (actual > forecast), negative = miss.
 * Used to amplify penalty when a release significantly surprises the market.
 */
function computeSurpriseFactor(actual, forecast, previous) {
  const ref = forecast ?? previous;
  if (actual == null || ref == null) return 0;
  const numActual = parseFloat(actual);
  const numRef    = parseFloat(ref);
  if (isNaN(numActual) || isNaN(numRef) || numRef === 0) return 0;
  return Math.max(-1, Math.min(1, (numActual - numRef) / Math.abs(numRef)));
}

// ─── Exponential penalty decay ────────────────────────────────────────────────

/**
 * Penalty decays with half-life = taxonomy.decayHalf minutes.
 * Large surprises (|factor| → 1) extend effective duration by up to 50%.
 */
function computeDecayedPenalty(msAfter, taxonomy, surprise) {
  const minutesAfter     = msAfter / 60000;
  const surpriseMultiplier = 1 + Math.abs(surprise) * 0.5;   // 1.0 – 1.5×
  const t                = minutesAfter / taxonomy.decayHalf;
  const decayed          = taxonomy.maxPenalty * Math.exp(-0.693 * t) * surpriseMultiplier;
  return Math.max(0, Math.min(taxonomy.maxPenalty * 1.5, decayed));
}

// ─── Direction bias translation ───────────────────────────────────────────────

/**
 * Convert FinBERT journalism-tone sentiment → equity price direction.
 *
 *  DIRECT:          positive → BULLISH   (jobs, growth, consumer confidence)
 *  INVERSE:         positive → BEARISH   (inflation: hot print is journalist-positive but ES-bearish)
 *  HAWKISH_INVERSE: positive → BEARISH   (Fed hawkish language sounds confident but tightens ES)
 *  NEUTRAL:         always   → NEUTRAL
 *
 * @param {object} finbert  - Full FinBERT result: { sentiment, confidence, positive, negative, neutral }
 * @param {string} directionRule
 * @returns {{ bias: string, weight: number }}
 *   bias:   'BULLISH' | 'BEARISH' | 'NEUTRAL'
 *   weight: 0–1 confidence in the directional call.
 *           Computed as confidence × (1 − neutralProb) so that outputs where
 *           the model is predominantly uncertain (high neutral probability) are
 *           discounted, even when a directional class wins by a slim margin.
 *           Callers scale bonus points with this weight rather than applying a
 *           fixed reward regardless of how sure FinBERT actually was.
 */
function resolveDirectionBias(finbert, directionRule) {
  if (directionRule === 'NEUTRAL') return { bias: 'NEUTRAL', weight: 0 };

  const { sentiment, confidence, neutral: neutralProb } = finbert;

  // If FinBERT's dominant class is neutral, no directional inference is warranted
  if (sentiment === 'neutral') return { bias: 'NEUTRAL', weight: 0 };

  // weight = probability of the winning label, discounted by how uncertain the
  // model is overall (high neutral probability means "not really sure").
  const weight = parseFloat((confidence * (1 - neutralProb)).toFixed(3));

  if (directionRule === 'DIRECT') {
    if (sentiment === 'positive') return { bias: 'BULLISH', weight };
    if (sentiment === 'negative') return { bias: 'BEARISH', weight };
  }
  if (directionRule === 'INVERSE' || directionRule === 'HAWKISH_INVERSE') {
    if (sentiment === 'positive') return { bias: 'BEARISH', weight };
    if (sentiment === 'negative') return { bias: 'BULLISH', weight };
  }
  return { bias: 'NEUTRAL', weight: 0 };
}

// ─── FinBERT — cached per event title ────────────────────────────────────────

const _finbertCache = new Map();

async function getEventSentiment(title) {
  if (_finbertCache.has(title)) return _finbertCache.get(title);
  try {
    const { classify } = require('./finbert');
    const result = await classify(title);
    _finbertCache.set(title, result);
    return result;
  } catch {
    // Model not available — neutral fallback (no ONNX yet, or cold path)
    const neutral = { sentiment: 'neutral', confidence: 0, positive: 0.33, negative: 0.33, neutral: 0.34 };
    _finbertCache.set(title, neutral);
    return neutral;
  }
}

// ─── Calendar fetch & cache ───────────────────────────────────────────────────

async function fetchCalendar() {
  const cached = db.getSetting(CACHE_KEY);
  if (cached) {
    const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
    if (parsed.fetchedAt && (Date.now() - parsed.fetchedAt) < CACHE_TTL) {
      return parsed.events || [];
    }
  }
  try {
    const body   = execSync(`curl -s --max-time 10 "${CALENDAR_URL}"`, { encoding: 'utf8' });
    const events = JSON.parse(body);
    if (!Array.isArray(events)) throw new Error('Unexpected calendar format');
    db.setSetting(CACHE_KEY, JSON.stringify({ events, fetchedAt: Date.now() }));
    return events;
  } catch (err) {
    console.warn('[Catalyst] Calendar fetch failed:', err.message);
    return [];
  }
}

// ─── Main gate ────────────────────────────────────────────────────────────────

/**
 * Check catalyst status for the current moment.
 *
 * Returns:
 *  {
 *    blocked:        boolean        — true only in pre-event hard window
 *    penalty:        number         — confidence pts to subtract (0 when clear)
 *    directionBias:  string         — 'BULLISH'|'BEARISH'|'NEUTRAL'|'UNKNOWN'
 *    reason:         string         — human-readable summary
 *    layerPenalties: object         — { MACRO, TICK, FUTURES, MICRO } proportional score reductions
 *    finbert:        object|null    — raw FinBERT output for post-event events
 *    surprise:       number|null    — [-1,1] normalized actual vs forecast
 *    nextEvent:      object|null    — next upcoming High event within lookaheadMinutes
 *  }
 */
async function isCatalystWindow(lookaheadMinutes = 30) {
  const events = await fetchCalendar();
  const now    = Date.now();
  const ahead  = lookaheadMinutes * 60 * 1000;

  let worstBlocked = null;   // pre-window hard block
  let worstPenalty = null;   // post-window decayed penalty
  let nextEvent    = null;   // for logging/display

  for (const event of events) {
    if (!event.date || event.impact !== 'High') continue;
    const eventMs = new Date(event.date).getTime();
    if (isNaN(eventMs)) continue;

    const msBefore = eventMs - now;
    const msAfter  = now - eventMs;
    const taxonomy = classifyEvent(event.title);
    const preMs    = taxonomy.preWindow  * 60000;
    const postMs   = taxonomy.postWindow * 60000;

    // Track next upcoming event for status display
    if (msBefore > 0 && msBefore <= ahead) {
      if (!nextEvent || msBefore < nextEvent._msBefore) {
        nextEvent = { ...event, taxonomy, _msBefore: msBefore };
      }
    }

    // ── Pre-event: hard block ──────────────────────────────────────────────
    if (msBefore >= 0 && msBefore <= preMs) {
      const minLeft = Math.ceil(msBefore / 60000);
      if (!worstBlocked || taxonomy.maxPenalty > worstBlocked._severity) {
        worstBlocked = {
          blocked:        true,
          penalty:        taxonomy.maxPenalty,
          directionBias:  'UNKNOWN',
          directionWeight: 0,
          reason:         `[${taxonomy.category}] ${event.title} in ${minLeft}m (${event.country})`,
          layerPenalties: { ...taxonomy.layerWeights },
          finbert:        null,
          surprise:       null,
          nextEvent,
          _severity:      taxonomy.maxPenalty
        };
      }
    }

    // ── Post-event: decayed penalty ────────────────────────────────────────
    if (msAfter >= 0 && msAfter <= postMs) {
      const surprise = computeSurpriseFactor(event.actual, event.forecast, event.previous);
      const penalty  = computeDecayedPenalty(msAfter, taxonomy, surprise);

      if (penalty > (worstPenalty?._rawPenalty ?? 0)) {
        const finbert      = await getEventSentiment(event.title);
        const { bias: directionBias, weight: directionWeight } = resolveDirectionBias(finbert, taxonomy.directionRule);
        const minAgo       = Math.floor(msAfter / 60000);
        const penaltyInt   = Math.round(penalty);
        const ratio        = penalty / taxonomy.maxPenalty;

        worstPenalty = {
          blocked:        false,
          penalty:        penaltyInt,
          directionBias,
          directionWeight,
          reason:         `[${taxonomy.category}] ${event.title} ${minAgo}m ago → ${directionBias} (−${penaltyInt}pts, surprise=${surprise >= 0 ? '+' : ''}${surprise.toFixed(2)}, fbWeight=${directionWeight.toFixed(2)})`,
          layerPenalties: Object.fromEntries(
            Object.entries(taxonomy.layerWeights).map(([k, v]) => [k, Math.round(v * ratio)])
          ),
          finbert,
          surprise:      parseFloat(surprise.toFixed(3)),
          nextEvent,
          _rawPenalty:   penalty
        };
      }
    }
  }

  if (worstBlocked) return worstBlocked;
  if (worstPenalty) {
    const { _rawPenalty, ...clean } = worstPenalty;
    return { ...clean, nextEvent };
  }

  return {
    blocked:         false,
    penalty:         0,
    directionBias:   'NEUTRAL',
    directionWeight: 0,
    reason:          '',
    layerPenalties:  {},
    finbert:         null,
    surprise:        null,
    nextEvent
  };
}

// ─── Next event query (kept for external callers) ─────────────────────────────

async function getNextEvent() {
  const events = await fetchCalendar();
  const now    = Date.now();
  const upcoming = events
    .filter(e => e.impact === 'High' && new Date(e.date).getTime() > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!upcoming[0]) return null;
  return { ...upcoming[0], taxonomy: classifyEvent(upcoming[0].title) };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchCalendar,
  isCatalystWindow,
  getNextEvent,
  classifyEvent,
  computeSurpriseFactor,
  resolveDirectionBias,
  TAXONOMY
};
