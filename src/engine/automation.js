// ============================================================================
// AUTOMATION SYSTEM v18.6.0 - SCALPING INTELLIGENCE ENGINE
// ============================================================================
// Integrates:
// - Macro Context (passive flows, regime, calendar)
// - Futures Mechanics (basis, delta, price discovery)
// - Micro Regime (5min/15min trends, VWAP, volume)
// - Scalping Intelligence (convergence-based confidence scoring)
// 
// Runs every 10 seconds. No Claude for decisions. Full academic rigor.
// ============================================================================

// Node.js module dependencies (replace all chrome.* and window.* refs)
const MacroContext         = require('./macro-context');
const FuturesMechanics    = require('./futures-mechanics');
const ScalpingIntelligence = require('./scalping-intelligence');
const CrossAsset           = require('./cross-asset');
const TickPrecision        = require('./tick-precision');
const CatalystFilter       = require('./catalyst-filter');
const RealizedVol          = require('./realized-volatility');
const IntraydayCycle       = require('./intraday-cycle');
const QuoteStream          = require('../api/quote-stream');
const topstepx             = require('../api/topstepx');
const db                   = require('../storage/db');
const config               = require('../../config');
const DailySummary         = require('../analytics/daily-summary');
const SignalScorecard      = require('../analytics/signal-scorecard');
const AnomalyAlerts        = require('../analytics/anomaly-alerts');

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let cycleRunning = false;

const automationState = {
  status: 'STOPPED', // 'RUNNING' | 'STOPPED'
  
  // Current order tracking
  hasOpenOrder: false,
  currentOrderId: null,
  currentOrder: null, // { direction, price, stop, target, reasoning, confidence, timestamp }
  orderPlacedTime: null,
  
  // Active trade tracking
  inActiveTrade: false,
  currentTrade: null, // { entry, entryTime, direction, contracts: 1 }
  
  // Context cache (updated at different frequencies)
  macroContext: null,          // Updated every 1-4 hours
  macroContextTimestamp: null,
  
  futuresContext: null,        // Updated every 10 seconds
  microRegime: null,           // Computed every 10 seconds
  
  // Scalping metrics
  scalpingMetrics: {
    dailyTrades: 0,
    dailyWins: 0,
    dailyLosses: 0,
    dailyPnL: 0,
    lastResetDate: new Date().toDateString(),
    consecutiveLosses: 0,
    streakPauseUntil:  null
  },
  
  // Intervals
  mainLoopInterval: null,
  fillMonitorInterval: null,
  positionMonitorInterval: null,
  macroUpdateInterval: null,

  // RV/IV smoothing: last 5 regime readings; only shift active regime when ≥3 agree
  rvivHistory: [],

  // Adaptive phase calibration: loaded from trade history at each day reset
  adaptivePhaseAdjustments: {},

  // Rich trade context captured at entry; cleared after logScalpResult
  tradeContext: null,

  // Context snapshot from current cycle; read by executeScalp to populate tradeContext
  cycleSnapshot: null,

  // Regime-based threshold adjustments: { TRENDING: ±N, RANGING: ±N } loaded at day reset
  adaptiveRegimeAdjustments: {},

  // Re-entry cooldown: timestamp of last trade exit (null = never traded)
  lastTradeExitTime: null,

  // Which path triggered executeScalp in this cycle ('A' | 'B')
  pendingPath: null,

  // Cross-asset stale cache: used as fallback when Yahoo Finance times out
  lastCrossAssetContext: null,
  lastCrossAssetTs:      null,

  // Cumulative intraday tick delta: running Lee-Ready net since session open
  // Accumulated from quote buffer across cycles; reset each new trading day
  cumulativeDelta: {
    netDelta:     0,
    lastQuoteTs:  null,  // timestamp of last processed quote (deduplication cursor)
    sessionDate:  null   // date string — reset trigger
  },

  // Analytics: cycle counter for periodic anomaly checks
  cycleCount: 0,

  // Analytics: scorecard weight multipliers (loaded at startup, refreshed after trades)
  scorecardWeights: null
};

// ============================================================================
// IMPLEMENTATION CONSTRAINTS
// ============================================================================

const CONSTRAINTS = {
  // Order format constraints
  orderFormat: {
    direction: 'long|short',  // LOWERCASE
    price: 'Number',
    stopLoss: 'Number',
    takeProfit: 'Number',
    size: 1
  },
  
  // Available intervals
  availableIntervals: ['15m', '5m', '1m', '1s'],

  // Data availability
  bars: {
    '15m': 40,  // Can fetch 40 bars
    '5m': 60    // Can fetch 60 bars
  },

  // Timing
  loopFrequency: 10000,  // 10 seconds (main loop)
  macroUpdateFrequency: 3600000,  // 1 hour
};

// ============================================================================
// HELPER FUNCTIONS (Existing - Keep for compatibility)
// ============================================================================

async function getSessionToken() {
  return topstepx.getSessionToken();
}

async function detectCurrentContract() {
  const contractId = db.getSetting('selectedContractId') || config.trading.defaultContractId;
  const contractName = db.getSetting('selectedContractName') || config.trading.defaultContractName;
  return {
    id: contractId,
    name: contractName,
    tickSize: config.trading.tickSize
  };
}

async function fetchBars() {
  const response = await topstepx.fetchBars([
    { interval: '15m', count: 40 },
    { interval: '5m',  count: 60 },
    { interval: '1m',  count: 120 },
    { interval: '1s',  count: 300 }
  ]);

  if (!response || !response.success) {
    console.error('[Automation] Failed to fetch bars:', response?.error);
    return null;
  }

  return {
    '15m': response.bars15m || [],
    '5m':  response.bars5m  || [],
    '1m':  response.bars1m  || [],
    '1s':  response.bars1s  || []
  };
}

/**
 * Count net buy/sell 5m bars since 8:30 CT session open.
 * Positive = buyers dominant; negative = sellers dominant.
 * Handles DST automatically.
 */
function computeSessionBarDelta(bars5m) {
  const now = new Date();
  const isDST = now.getMonth() >= 2 && now.getMonth() <= 10; // approx Mar–Nov
  const ctOffset = isDST ? 5 : 6;
  const ctNow = new Date(now.getTime() - ctOffset * 3600000);
  const sessionOpen = new Date(ctNow);
  sessionOpen.setHours(8, 30, 0, 0);
  const sessionOpenMs = sessionOpen.getTime() + ctOffset * 3600000; // back to UTC ms

  const sessionBars = bars5m.filter(b => b.time >= sessionOpenMs);
  const delta = sessionBars.reduce(
    (sum, b) => sum + (b.close > b.open ? 1 : b.close < b.open ? -1 : 0),
    0
  );
  return { sessionBarDelta: delta, sessionBarCount: sessionBars.length };
}

function calculatePnL(entry, exit, direction, contracts) {
  const tickSize = 0.25;
  const tickValue = 1.25; // MES
  const commission = config.trading.commissionPerContract || 0;

  const priceMove = direction === 'LONG' ?
    exit - entry :
    entry - exit;

  const ticks = priceMove / tickSize;
  return (ticks * tickValue * contracts) - (commission * contracts);
}

// ============================================================================
// MACRO CONTEXT MANAGEMENT
// ============================================================================

/**
 * Update macro context (reads from auto-generated daily summary)
 * Uses getCachedSummaries from db.js for daily summary context.
 */
async function updateMacroContext() {
  console.log('[Automation] Updating macro context...');
  
  try {
    // Check if we need to update
    const now = Date.now();
    const hoursSinceUpdate = automationState.macroContextTimestamp ? 
      (now - automationState.macroContextTimestamp) / (1000 * 60 * 60) : 999;
    
    if (hoursSinceUpdate < 1 && automationState.macroContext) {
      console.log('[Automation] Macro context still fresh, skipping update');
      return automationState.macroContext;
    }
    
    // Get cached summaries from SQLite
    let dailySummary = null;
    try {
      const summaries = db.getCachedSummaries();
      if (summaries && summaries.daily) {
        dailySummary = summaries.daily;
        console.log('[Automation] Daily summary loaded from cache');
      }
    } catch (error) {
      console.warn('[Automation] Error loading cached summaries:', error.message);
    }
    
    // Get bars for context
    const bars = await fetchBars();
    if (!bars) {
      console.error('[Automation] Cannot update macro context - no bars');
      return null;
    }
    
    // Get macro context (reads from dailySummary or falls back to bar analysis)
    const macroContext = await MacroContext.getMacroContext(
      bars['5m'],
      bars['15m'],
      dailySummary
    );
    
    automationState.macroContext = macroContext;
    automationState.macroContextTimestamp = now;
    
    console.log('[Automation] ✅ Macro context updated:', {
      regime: macroContext.regime.type,
      confidence: macroContext.regime.confidence,
      flowPressure: macroContext.regime.flowPressure
    });
    
    return macroContext;
    
  } catch (error) {
    console.error('[Automation] Error updating macro context:', error);
    return automationState.macroContext; // Return cached
  }
}

/**
 * Start periodic macro updates
 */
function startMacroUpdates() {
  // Update immediately
  updateMacroContext();
  
  // Then update every hour
  automationState.macroUpdateInterval = setInterval(
    updateMacroContext,
    CONSTRAINTS.macroUpdateFrequency
  );
}

// ============================================================================
// QUOTE STREAM HEALTH
// ============================================================================

/**
 * Ensure the SignalR quote stream is connected.
 * Called at the start of each cycle — reconnects silently if dropped.
 */
async function maintainQuoteStream() {
  if (QuoteStream.isConnected()) return; // healthy

  console.log('[Automation] QuoteStream disconnected — attempting reconnect...');
  try {
    const token      = await topstepx.getSessionToken();
    const contractId = db.getSetting('selectedContractId') || config.trading.defaultContractId;
    if (token) {
      await QuoteStream.reconnect(contractId, token);
    } else {
      console.warn('[Automation] No token for QuoteStream reconnect');
    }
  } catch (err) {
    console.warn('[Automation] QuoteStream reconnect failed (non-fatal):', err.message);
  }
}

// ============================================================================
// CUMULATIVE INTRADAY DELTA
// ============================================================================

/**
 * Accumulate net buy/sell tick count from the quote buffer since session open.
 * Called every cycle; deduplicates via timestamp cursor so each quote is counted once.
 * Resets automatically on a new trading day.
 *
 * Uses Lee-Ready rule: last >= ask → buy tick; last <= bid → sell tick; else neutral.
 * Signal thresholds: ≥+50 = BULLISH bias; ≤-50 = BEARISH bias.
 *
 * @param {Array<{bid,ask,last,timestamp}>} quoteBuffer - newest-first from QuoteStream
 */
function updateCumulativeDelta(quoteBuffer) {
  if (!quoteBuffer || quoteBuffer.length === 0) return;

  const cd = automationState.cumulativeDelta;
  const todayStr = new Date().toDateString();

  // Reset on new calendar day (session reset)
  if (cd.sessionDate !== todayStr) {
    cd.netDelta    = 0;
    cd.lastQuoteTs = null;
    cd.sessionDate = todayStr;
    console.log('[Automation] Cumulative delta reset for new session');
  }

  // Only process quotes newer than the last cursor (deduplication)
  const cutoff = cd.lastQuoteTs ?? 0;
  // quoteBuffer is newest-first; find all quotes newer than cutoff
  const newQuotes = quoteBuffer.filter(q => q.timestamp > cutoff);
  if (newQuotes.length === 0) return;

  for (const q of newQuotes) {
    if (!q.last || q.last <= 0) continue;
    if (q.last >= q.ask)      cd.netDelta++;
    else if (q.last <= q.bid) cd.netDelta--;
    // mid-spread fills are neutral — no count
  }

  // Advance cursor to the newest quote we processed (index 0 = newest in newest-first array)
  cd.lastQuoteTs = newQuotes[0].timestamp;
}

// ============================================================================
// MAIN SCALPING LOOP
// ============================================================================

/**
 * Main automation cycle - runs every 10 seconds
 */
async function runScalpingCycle() {
  if (cycleRunning) {
    console.warn('[Automation] ⚠️ Previous cycle still running — skipping tick');
    return;
  }
  cycleRunning = true;
  try {
  automationState.cycleCount++;
  console.log('[Automation] === Scalping Cycle Start ===');

  try {
    // 0a. Reset daily metrics if new day
    resetDailyMetricsIfNeeded();

    // 0b. Ensure SignalR quote stream is live (reconnects if token expired or connection dropped)
    await maintainQuoteStream();

    // 0c. Anomaly alerts — run every 5 cycles (50s) to surface intraday patterns
    if (automationState.cycleCount % 5 === 0) {
      try {
        const anomalyResult = AnomalyAlerts.checkAnomalies();
        for (const alert of anomalyResult.alerts) {
          const icon = alert.severity === 'critical' ? '🚨' : '⚠️';
          console.log(`[Analytics] ${icon} ${alert.type}: ${alert.message}`);
        }
      } catch (err) {
        console.warn('[Analytics] Anomaly check failed (non-fatal):', err.message);
      }
    }

    // 1. CATALYST GATE — hard block pre-event; decayed penalty post-event
    const catalystCheck = await CatalystFilter.isCatalystWindow(30);
    if (catalystCheck.blocked) {
      console.log(`[Automation] 🚫 CATALYST GATE: ${catalystCheck.reason}`);
      return;
    }
    if (catalystCheck.penalty > 0) {
      console.log(`[Automation] ⚠️  POST-EVENT: ${catalystCheck.reason}`);
    }
    if (catalystCheck.nextEvent) {
      const minAway = Math.ceil(catalystCheck.nextEvent._msBefore / 60000);
      console.log(`[Automation] 📅 Next: [${catalystCheck.nextEvent.taxonomy.category}] ${catalystCheck.nextEvent.title} in ${minAway}m`);
    }

    // 2. SESSION PHASE GATE — skip if outside trading hours
    const cycleContext = IntraydayCycle.getCycleContext(undefined, automationState.adaptivePhaseAdjustments);
    if (!cycleContext.tradingAllowed) {
      console.log(`[Automation] ⏸ Session phase ${cycleContext.phase} — trading paused`);
      return;
    }

    // 3. Fetch bar data
    const bars = await fetchBars();
    if (!bars || !bars['5m'] || bars['5m'].length === 0) {
      console.warn('[Automation] No bar data available');
      return;
    }

    // 4. Compute realized volatility context from 5m bars
    const sigma    = RealizedVol.computeRealizedVol(bars['5m'], 20);
    const volRegime = RealizedVol.classifyVolRegime(sigma);
    const volContext = { sigma, regime: volRegime };

    // 5. Live quote + quote buffer from SignalR (may be null/empty — callers handle gracefully)
    const liveQuote   = QuoteStream.getLatestQuote();
    const quoteAge    = QuoteStream.getQuoteAge();
    const quoteBuffer = QuoteStream.getQuoteBuffer();
    if (liveQuote) {
      console.log(`[Automation] Live quote: bid=${liveQuote.bid} ask=${liveQuote.ask} spread=${liveQuote.spread} | buffer: ${quoteBuffer.length} quotes`);
    } else {
      const ageStr = quoteAge === Infinity ? 'never received' : `${Math.round(quoteAge / 1000)}s old`;
      console.warn(`[Automation] No live quote (${ageStr}) — connected=${QuoteStream.isConnected()}`);
    }

    // Accumulate cumulative intraday delta from new quotes (Lee-Ready classification)
    updateCumulativeDelta(quoteBuffer);
    const cumDelta = automationState.cumulativeDelta.netDelta;
    if (Math.abs(cumDelta) >= 50) {
      console.log(`[Automation] Cumulative delta: ${cumDelta > 0 ? '+' : ''}${cumDelta} (${cumDelta >= 50 ? 'BULLISH' : 'BEARISH'} pressure since open)`);
    }

    // 6. Get macro context (cached, updated hourly; now includes COT)
    let macroContext = automationState.macroContext;
    if (!macroContext) {
      console.log('[Automation] No macro context, initializing...');
      macroContext = await updateMacroContext();
    }

    if (!macroContext) {
      console.error('[Automation] Cannot proceed without macro context');
      return;
    }

    // 7. Get futures context (computed fresh every cycle)
    const futuresContext = await FuturesMechanics.getFuturesContext(
      bars['5m'],
      macroContext
    );

    if (!futuresContext) {
      console.error('[Automation] Cannot proceed without futures context');
      return;
    }

    automationState.futuresContext = futuresContext;

    // 7b. Cross-asset context: NQ, Gold (GC), BTC, Oil (CL) — non-fatal if any fetch fails
    let crossAssetContext = null;
    try {
      crossAssetContext = await CrossAsset.getCrossAssetContext(bars['5m']);
      automationState.lastCrossAssetContext = crossAssetContext;
      automationState.lastCrossAssetTs      = Date.now();
    } catch (err) {
      console.warn('[Automation] CrossAsset context failed (non-fatal):', err.message);
      if (automationState.lastCrossAssetContext) {
        const ageMin = Math.round((Date.now() - automationState.lastCrossAssetTs) / 60000);
        console.warn(`[Automation] Using stale cross-asset context (${ageMin}m old)`);
        crossAssetContext = automationState.lastCrossAssetContext;
      }
    }

    // Session bar delta — net directional bias from 5m bars since 8:30 CT open
    // Computed before confidence call so it is included in the scoring pass
    const { sessionBarDelta, sessionBarCount } = computeSessionBarDelta(bars['5m']);
    if (Math.abs(sessionBarDelta) >= 3) {
      console.log(`[Automation] Session bar delta: ${sessionBarDelta > 0 ? '+' : ''}${sessionBarDelta} (${sessionBarCount} bars since open)`);
    }

    // 8. Calculate scalping confidence (integrates all layers + hybrid context)
    const confidence = await ScalpingIntelligence.calculateScalpingConfidence(
      macroContext,
      futuresContext,
      bars['5m'],
      bars['15m'],
      bars['1m'],
      bars['1s'],
      { volContext, liveQuote, cycleContext, crossAssetContext, quoteBuffer, sessionBarDelta, cumulativeDelta: automationState.cumulativeDelta.netDelta, catalystContext: catalystCheck, scorecardWeights: automationState.scorecardWeights }  // hybrid context
    );

    console.log('[Automation] Scalping Confidence:', {
      score:      confidence.confidence,
      grade:      confidence.grade,
      direction:  confidence.direction,
      shouldScalp: confidence.shouldScalp,
      volRegime,
      phase:      cycleContext.phase
    });

    // 9. RV/IV regime: compare realized vol to implied vol (VIX) to identify market character
    const vix = macroContext.macroData?.vix ?? db.getSetting('vixPrice') ?? null;
    const rvivResult = vix ? RealizedVol.computeRVIVRatio(sigma, vix) : { regime: 'NEUTRAL', ratio: 1.0 };

    // Smooth RV/IV regime: only change active regime when ≥3 of last 5 readings agree
    // Prevents threshold whiplash from momentary VIX spikes
    automationState.rvivHistory.push(rvivResult.regime);
    if (automationState.rvivHistory.length > 5) automationState.rvivHistory.shift();
    const rvivCounts = { TRENDING: 0, RANGING: 0, NEUTRAL: 0 };
    for (const r of automationState.rvivHistory) rvivCounts[r] = (rvivCounts[r] || 0) + 1;
    const topRegime = Object.entries(rvivCounts).sort((a, b) => b[1] - a[1])[0];
    const smoothedRegime = topRegime[1] >= 3 ? topRegime[0] : 'NEUTRAL';
    const rvivSmoothed = { ...rvivResult, regime: smoothedRegime };

    console.log(`[Automation] RV/IV: ${rvivResult.ratio ?? 'N/A'} raw=${rvivResult.regime} smoothed=${smoothedRegime} (${automationState.rvivHistory.length}/5 readings)`);

    // 10. Capture cycle snapshot — read by executeScalp to populate tradeContext
    automationState.cycleSnapshot = {
      rvivResult, rvivSmoothed, volContext, macroContext,
      futuresContext, crossAssetContext, confidence,
      sessionBarDelta, sessionBarCount,
      cumulativeDelta: automationState.cumulativeDelta.netDelta
    };

    // 11. Display status
    displayScalpingContext(macroContext, futuresContext, confidence, cycleContext, volContext, crossAssetContext);

    // ──────────────────────────────────────────────────────────────────────
    // TRADING DECISION — TWO PATHS
    // ──────────────────────────────────────────────────────────────────────

    if (automationState.hasOpenOrder) {
      console.log('[Automation] Order pending, waiting for fill');
      return;
    }
    if (automationState.inActiveTrade) {
      console.log('[Automation] In active trade, managing position');
      return;
    }

    // Re-entry cooldown: enforce minimum 30s between consecutive trades to prevent
    // rapid-fire re-entry after a quick stop-out (root cause of the T21-T23 sequence).
    const REENTRY_COOLDOWN_MS = 30_000;
    if (automationState.lastTradeExitTime &&
        Date.now() - automationState.lastTradeExitTime < REENTRY_COOLDOWN_MS) {
      const waitSecs = Math.ceil((REENTRY_COOLDOWN_MS - (Date.now() - automationState.lastTradeExitTime)) / 1000);
      console.log(`[Automation] Re-entry cooldown — ${waitSecs}s remaining`);
      return;
    }

    // Daily limits gate
    const m = automationState.scalpingMetrics;
    if (m.dailyTrades >= config.trading.maxDailyTrades) {
      console.log(`[Automation] 🛑 Daily trade limit reached (${m.dailyTrades}/${config.trading.maxDailyTrades}) — paused until tomorrow`);
      return;
    }
    if (m.dailyPnL <= -config.trading.maxDailyLoss) {
      console.log(`[Automation] 🛑 Daily loss limit reached ($${m.dailyPnL.toFixed(2)} / -$${config.trading.maxDailyLoss}) — paused until tomorrow`);
      return;
    }

    if (automationState.scalpingMetrics.streakPauseUntil &&
        Date.now() < automationState.scalpingMetrics.streakPauseUntil) {
      const minsLeft = Math.ceil((automationState.scalpingMetrics.streakPauseUntil - Date.now()) / 60000);
      console.log(`[Automation] Streak pause active — ${minsLeft}m remaining`);
      return;
    }

    // Dynamic base threshold — scale down when TICK layer data is absent
    // Full 1s bars: 55 | Quote buffer only: 52 | No TICK at all: 48
    const tickBarsAvailable  = bars['1s'] && bars['1s'].length >= 60;
    const quoteBufferUsable  = quoteBuffer.length >= 10;
    const scaledBaseThreshold = tickBarsAvailable ? 55 : quoteBufferUsable ? 52 : 48;

    // Adaptive regime adjustments (loaded at day reset, static within day)
    // Bounded ±6 total: base ±3 from RV/IV character, adaptive adds/subtracts at most 3 on top
    const regAdj = automationState.adaptiveRegimeAdjustments;
    const rvivAdjA = rvivSmoothed.regime === 'TRENDING' ? (-3 + (regAdj.TRENDING ?? 0)) :
                     rvivSmoothed.regime === 'RANGING'  ? ( 3 + (regAdj.RANGING  ?? 0)) : 0;
    const rvivAdjB = rvivSmoothed.regime === 'RANGING'  ? (-3 + (regAdj.RANGING  ?? 0)) :
                     rvivSmoothed.regime === 'TRENDING' ? ( 3 + (regAdj.TRENDING ?? 0)) : 0;

    // Catalyst penalties are now applied inside ScalpingIntelligence as per-layer
    // confidence reductions (via catalystContext in hybridCtx), so thresholds stay clean.

    // CLOSE_RUSH × RANGING gate: this specific combination is a value destroyer
    // (34.8% WR, -$34.62 in day-2 data). Ranging afternoon = pure chop with no
    // directional follow-through. Add +12 threshold penalty to both paths.
    const closeRangingPenalty = (cycleContext.phase === 'CLOSE_RUSH' && rvivSmoothed.regime === 'RANGING') ? 12 : 0;
    if (closeRangingPenalty) console.log(`[Automation] ⚠️  CLOSE_RUSH×RANGING penalty: +${closeRangingPenalty} threshold`);

    const pathABase = scaledBaseThreshold + rvivAdjA + closeRangingPenalty;
    const pathBBase = (tickBarsAvailable ? 45 : quoteBufferUsable ? 43 : 40) + rvivAdjB + closeRangingPenalty;

    // Delta contra-signal penalty: -3 confidence when order-flow imbalance opposes
    // trade direction. Counter-delta trades in live data: 1W/2L, -$19.38 vs aligned
    // 15W/7L, +$75. Minimal penalty — doesn't block strong setups, trims marginal ones.
    const deltaSignal      = futuresContext.deltaImbalance?.signal || '';
    const deltaContra      = confidence.direction &&
      ((confidence.direction === 'LONG'  && deltaSignal.includes('BEARISH')) ||
       (confidence.direction === 'SHORT' && deltaSignal.includes('BULLISH')));
    const deltaContraPenalty = deltaContra ? 3 : 0;

    // Effective confidence for threshold comparisons (does not alter stored score or logs)
    const effectiveConf    = parseFloat(confidence.confidence) - deltaContraPenalty;

    // PATH A — Momentum scalp: confidence ≥ base threshold + session adjustment
    const adjustedThreshold = pathABase + cycleContext.thresholdAdjustment;
    const pathAValid = effectiveConf >= adjustedThreshold && confidence.direction !== null;

    const tickSrc  = tickBarsAvailable ? 'TICK-bars' : quoteBufferUsable ? 'quote-buffer' : 'no-tick';
    const phaseAdj = cycleContext.thresholdAdjustment;
    const adaptStr = cycleContext.adaptiveAdj !== 0 ? ` adapt${cycleContext.adaptiveAdj > 0 ? '+' : ''}${cycleContext.adaptiveAdj}` : '';
    const catStr   = catalystCheck.penalty > 0 ? ` cat[${catalystCheck.directionBias}]` : '';
    const deltaStr = deltaContra ? ` delta-contra(-3)` : '';
    console.log(`[Automation] Threshold: ${adjustedThreshold} (base ${scaledBaseThreshold} — ${tickSrc} + phase ${phaseAdj >= 0 ? '+' : ''}${phaseAdj}${adaptStr} + RV/IV ${rvivSmoothed.regime}/${rvivAdjA > 0 ? '+' : ''}${rvivAdjA}${catStr}${deltaStr}) | eff=${effectiveConf.toFixed(1)}`);

    if (pathAValid) {
      // ── Path A quality warnings (soft — logged for analysis, not blocking) ─
      // These conditions correlate with lower win rates historically but are
      // intentionally non-blocking during the data-collection phase so we can
      // build enough trade history to set thresholds with statistical confidence.
      const convPct = ((confidence.convergenceRatioRaw ?? 0) * 100).toFixed(0);
      if (macroContext.regime.type === 'ACTIVE_DOMINATED') {
        console.log(`[Automation] ⚠️  Path A CAUTION: ACTIVE_DOMINATED regime (conf=${confidence.confidence})`);
      }
      if (rvivSmoothed.regime === 'RANGING') {
        console.log(`[Automation] ⚠️  Path A CAUTION: RANGING rviv regime (conf=${confidence.confidence})`);
      }
      // Hard floor: only block genuinely weak signal agreement (< 55%)
      if ((confidence.convergenceRatioRaw ?? 1) < 0.55) {
        console.log(`[Automation] 🚫 Path A blocked: convergence ${convPct}% < 55% — direction vote too weak to act on`);
      } else {
        console.log(`[Automation] ✅ PATH A: Momentum scalp (confidence=${confidence.confidence} ≥ ${adjustedThreshold} | conv=${convPct}%)`);
        automationState.pendingPath = 'A';
        await executeScalp(confidence, bars['5m'], bars['1m'], bars['1s']);
        return;
      }
    }

    // PATH B — VWAP mean reversion: price displaced from VWAP by ≥1σ + no catalyst
    // pathBBase computed above (with RV/IV adjustment)
    if (effectiveConf >= pathBBase) {
      const vwapSetup = checkVWAPMeanReversion(bars['5m'], volContext, confidence);
      if (vwapSetup.valid) {
        const vwapSource = confidence.vwapRelationship?.sessionVwap ? 'session' : 'rolling';
        console.log(`[Automation] 🔄 PATH B: VWAP reversion — ${vwapSetup.direction} (${vwapSetup.sigmas}σ displaced from ${vwapSource} VWAP)`);
        automationState.pendingPath = 'B';
        await executeScalp(vwapSetup, bars['5m'], bars['1m'], bars['1s']);
        return;
      }
    }

    const closestGap = Math.min(
      adjustedThreshold - effectiveConf,
      pathBBase - effectiveConf
    );
    if (closestGap > 0 && closestGap <= 10) {
      db.saveNearMiss({
        confidence:     confidence.confidence,
        thresholdA:     adjustedThreshold,
        thresholdB:     pathBBase,
        gap:            closestGap,
        direction:      confidence.direction,
        session:        cycleContext.phase,
        rvivRegime:     rvivSmoothed?.regime,
        catalystPenalty: catalystCheck.penalty || null,
        catalystBias:   catalystCheck.directionBias !== 'NEUTRAL' ? catalystCheck.directionBias : null,
      });
      console.log(`[Automation] Near-miss logged (gap=${closestGap.toFixed(1)}, conf=${confidence.confidence})`);
    } else {
      console.log(`[Automation] No signal — conf=${confidence.confidence}, threshA=${adjustedThreshold}, threshB=${pathBBase}`);
    }

  } catch (error) {
    console.error('[Automation] Cycle error:', error);
  }

  console.log('[Automation] === Cycle Complete ===');
  } finally {
    cycleRunning = false;
  }
}

// ============================================================================
// PATH B — VWAP MEAN REVERSION CHECK
// ============================================================================

/**
 * Check if VWAP displacement justifies a mean-reversion trade (Path B).
 * Uses the VWAP relationship already computed and returned by scalping-intelligence.
 *
 * @param {Array}  bars5m      - 5-minute bars (newest first)
 * @param {object} volContext  - { sigma, regime }
 * @param {object} confidence  - Output of calculateScalpingConfidence (has vwapRelationship)
 * @returns {{ valid: boolean, direction?: string, sigmas?: number, entry?: number,
 *             stopDistance?: number, targetDistance?: number, reasoning?: string,
 *             confidence?: string, grade?: string, shouldScalp?: boolean }}
 */
function checkVWAPMeanReversion(bars5m, volContext, confidence) {
  const vwapData = confidence.vwapRelationship;
  // Prefer session VWAP (anchored at 8:30 CT); fall back to rolling 12-bar VWAP
  const activeVwap = vwapData.sessionVwap ?? vwapData;
  if (!activeVwap || activeVwap.signal !== 'FADE_TO_VWAP') {
    return { valid: false };
  }

  const currentPrice = bars5m[0]?.close;
  if (!currentPrice) return { valid: false };

  // Check σ displacement — require ≥1σ
  const dispCheck = RealizedVol.vwapDisplacementCheck(currentPrice, activeVwap.vwap, volContext.sigma);
  if (!dispCheck.displaced) {
    return { valid: false };
  }

  // Vol-proportional R:R: stop = 0.5× displacement, target = displacement
  const stops = RealizedVol.volProportionalStops(volContext.sigma, currentPrice);

  return {
    valid:          true,
    direction:      dispCheck.direction,
    sigmas:         dispCheck.sigmas,
    confidence:     confidence.confidence,  // reuse existing score for logging
    grade:          confidence.grade,
    shouldScalp:    true,
    stopDistance:   Math.max(2, Math.round(stops.stopTicks * 0.5)),  // tighter stop for mean reversion
    targetDistance: stops.stopTicks,                                  // target = 1σ move, stop = 0.5σ
    recommendedSize: 1,
    maxHoldTime:    180,  // 3 minutes for mean reversion
    reasoning:      `VWAP fade: ${dispCheck.sigmas}σ displaced, ${activeVwap.reasoning}`
  };
}

// ============================================================================
// SCALP EXECUTION
// ============================================================================

/**
 * Execute a scalp based on confidence score
 */
async function executeScalp(confidence, bars5m, bars1m, bars1s) {
  console.log('[Automation] 🎯 EXECUTING SCALP:', confidence.grade, 'setup');

  // Clear any stale order state from the previous trade so that if we error-return
  // early (spread gate, SL validation, etc.) logScalpResult cannot read old values.
  automationState.currentOrder = null;

  try {
    const contract = await detectCurrentContract();
    const tickSize = contract.tickSize;
    
    // Use TICK-PERFECT entry finder instead of approximation
    const perfectEntry = TickPrecision.findTickPerfectEntry(
      bars1s,
      bars1m,
      bars5m,
      confidence.direction
    );
    
    console.log('[Automation] Tick-perfect entry found:', perfectEntry);
    
    // If tick analysis found a perfect entry, use it
    let entryPrice, stopPrice, targetPrice;
    
    if (perfectEntry.entryPrice && perfectEntry.confidence >= 60) {
      // Use tick-perfect levels.
      // Guard: tick-perfect for LONG places entry at support (below current price).
      // Clamp so a LONG limit is never more than 2 ticks below the live ask, and a
      // SHORT limit is never more than 2 ticks above the live bid — ensures fast fill.
      const liveQ2 = QuoteStream.getLatestQuote();
      entryPrice = perfectEntry.entryPrice;
      if (liveQ2) {
        if (confidence.direction === 'LONG' && liveQ2.ask && entryPrice < liveQ2.ask - 0.50) {
          console.log(`[Automation] Tick-perfect LONG entry ${entryPrice} too far below ask ${liveQ2.ask} — clamping to ask`);
          entryPrice = liveQ2.ask;
        } else if (confidence.direction === 'SHORT' && liveQ2.bid && entryPrice > liveQ2.bid + 0.50) {
          console.log(`[Automation] Tick-perfect SHORT entry ${entryPrice} too far above bid ${liveQ2.bid} — clamping to bid`);
          entryPrice = liveQ2.bid;
        }
      }
      stopPrice = perfectEntry.stopPrice;

      // Calculate target based on R:R
      const riskPoints = Math.abs(entryPrice - stopPrice);
      targetPrice = confidence.direction === 'LONG' ?
        entryPrice + (riskPoints * 2) :  // 2:1 R:R
        entryPrice - (riskPoints * 2);

      console.log('[Automation] Using tick-perfect entry:', {
        entry: entryPrice,
        stop: stopPrice,
        target: targetPrice,
        tickConfidence: perfectEntry.confidence
      });
      
    } else {
      // Fallback to approximate entry (if tick data insufficient).
      // For momentum scalps we want to fill immediately, so LONG enters at/above
      // the ask (not below) and SHORT enters at/below the bid (not above).
      // Use live quote if available, otherwise snap to nearest tick above/below.
      console.warn('[Automation] Tick-perfect entry unavailable, using fallback');

      const liveQ = QuoteStream.getLatestQuote();
      const currentPrice = bars5m[0].close;
      const entryOffset = 0.25;
      entryPrice = confidence.direction === 'LONG'
        ? (liveQ && liveQ.ask ? liveQ.ask : currentPrice + entryOffset)   // buy at ask — fills immediately
        : (liveQ && liveQ.bid ? liveQ.bid : currentPrice - entryOffset);  // sell at bid — fills immediately
      
      const stopTicks = confidence.stopDistance;
      stopPrice = confidence.direction === 'LONG' ?
        entryPrice - (stopTicks * tickSize) :
        entryPrice + (stopTicks * tickSize);
      
      const targetTicks = confidence.targetDistance;
      targetPrice = confidence.direction === 'LONG' ?
        entryPrice + (targetTicks * tickSize) :
        entryPrice - (targetTicks * tickSize);
    }
    
    // Enforce minimum stop bracket distance (3 ticks = 0.75 pt on MES).
    // Lowered from 4 to 3: data shows 4-6 tick stops are the worst-performing
    // bucket (16.7% WR) — the old floor pushed precision entries into a death
    // zone too tight to survive noise but too wide to indicate a precision entry.
    const MIN_STOP_TICKS = 3;
    const actualStopDist = Math.abs(entryPrice - stopPrice) / tickSize;
    if (actualStopDist < MIN_STOP_TICKS) {
      const newStopDist = MIN_STOP_TICKS * tickSize;
      stopPrice = confidence.direction === 'LONG'
        ? entryPrice - newStopDist
        : entryPrice + newStopDist;
      // Recalculate TP to maintain 2:1 R:R with the expanded stop
      targetPrice = confidence.direction === 'LONG'
        ? entryPrice + (newStopDist * 2)
        : entryPrice - (newStopDist * 2);
      console.log(`[Automation] Stop expanded to ${MIN_STOP_TICKS}t minimum: SL=${stopPrice.toFixed(2)} TP=${targetPrice.toFixed(2)}`);
    }

    // Hard sanity check: SL must be on the correct side of entry.
    // For SHORT: SL > entry (above entry). For LONG: SL < entry (below entry).
    const slValid = confidence.direction === 'LONG' ? stopPrice < entryPrice : stopPrice > entryPrice;
    if (!slValid) {
      console.error(`[Automation] ❌ SL direction validation FAILED: ${confidence.direction} entry=${entryPrice.toFixed(2)} SL=${stopPrice.toFixed(2)} — aborting to prevent inverted bracket`);
      return;
    }

    // Place limit order via TopstepX REST API
    const order = {
      direction: confidence.direction.toLowerCase(), // 'long' or 'short' (LOWERCASE)
      price: parseFloat(entryPrice.toFixed(2)),
      stopLoss: parseFloat(stopPrice.toFixed(2)),
      takeProfit: parseFloat(targetPrice.toFixed(2)),
      contract: contract,
      size: config.trading.contracts
    };
    
    console.log('[Automation] Placing scalp order:', order);

    // Require a live quote before placing any order.
    // Without a live mid we cannot verify the entry price is sane, risking phantom
    // orders (e.g. entry 5900 when market is at 6836 when the stream is not yet up).
    const spreadQuote = QuoteStream.getLatestQuote();
    if (!spreadQuote || !spreadQuote.mid) {
      console.warn('[Automation] No live quote available — skipping entry to prevent phantom orders');
      return;
    }

    if (spreadQuote.spread > 0.50) {
      console.warn(`[Automation] ⚠️ Spread too wide (${spreadQuote.spread.toFixed(4)}) — skipping entry`);
      return;
    }

    // Price sanity check: entry must be within 2% of live market.
    const priceDrift = Math.abs(entryPrice - spreadQuote.mid) / spreadQuote.mid;
    if (priceDrift > 0.02) {
      console.error(`[Automation] ❌ Entry price sanity FAILED: order ${entryPrice.toFixed(2)} is ${(priceDrift * 100).toFixed(1)}% from live mid ${spreadQuote.mid.toFixed(2)} — aborting (likely stale bar data)`);
      return;
    }

    const response = await topstepx.placeLimitOrder(order);
    
    if (response.success) {
      automationState.hasOpenOrder = true;
      automationState.currentOrderId = response.orderId;
      automationState.currentOrder = {
        ...order,
        confidence: confidence.confidence,
        grade: confidence.grade,
        reasoning: confidence.breakdown
          ? confidence.breakdown.map(b => b.reasoning).join('; ')
          : (confidence.reasoning || ''),
        tickPerfect: perfectEntry.entryPrice ? true : false,
        tickConfidence: perfectEntry.confidence || 0,
        timestamp: Date.now(),
        maxHoldTime: confidence.maxHoldTime
      };
      automationState.orderPlacedTime = Date.now();

      // Build rich trade context from current cycle snapshot for later db logging
      const snap = automationState.cycleSnapshot || {};
      const mc   = snap.macroContext     || {};
      const fc   = snap.futuresContext   || {};
      const ca   = snap.crossAssetContext || {};
      const rv   = snap.rvivSmoothed     || {};
      const vc   = snap.volContext       || {};
      const conf = snap.confidence       || confidence;
      const vwap = conf.vwapRelationship || {};
      const activeVwap = vwap.sessionVwap || vwap;
      const allSignals = conf.allSignals || [];

      // Compute signal vote counts
      const signalVotes     = allSignals.map(s => (typeof s === 'string' ? s : s.vote || s.signal || ''));
      const bullishCount    = signalVotes.filter(v => v === 'BULLISH').length;
      const bearishCount    = signalVotes.filter(v => v === 'BEARISH').length;
      const totalSignals    = allSignals.length;
      const convergenceRatio = totalSignals > 0 ? Math.max(bullishCount, bearishCount) / totalSignals : 0;

      // Top 5 breakdown factors by absolute score
      const breakdown  = conf.breakdown || [];
      const topFactors = [...breakdown]
        .sort((a, b) => Math.abs(b.score || 0) - Math.abs(a.score || 0))
        .slice(0, 5)
        .map(b => ({ layer: b.layer, factor: b.factor || b.reasoning, score: b.score }));

      const layerScores = conf.summary?.layerScores || {};

      automationState.tradeContext = {
        path:            automationState.pendingPath || 'A',
        entryType:       automationState.currentOrder.tickPerfect ? 'TICK_PERFECT' : 'APPROXIMATE',

        // Session
        session:         IntraydayCycle.getCycleContext().phase,
        sessionBarDelta: snap.sessionBarDelta ?? null,
        sessionBarCount: snap.sessionBarCount ?? null,
        holdTimeMax:     automationState.currentOrder.maxHoldTime || null,

        // Volatility
        sigma:           vc.sigma   ?? null,
        volRegime:       vc.regime  || null,
        rvivRatio:       rv.ratio   ?? null,
        rvivRegime:      rv.regime  || null,
        rvivRegimeRaw:   snap.rvivResult?.regime || null,

        // VIX / macro
        vix:             mc.macroData?.vix          ?? null,
        vix3m:           mc.macroData?.vix3m        ?? null,
        vixStructure:    mc.macroData?.vixStructure || null,
        vixTrend:        mc.macroData?.vixTrend     || null,
        macroRegime:     mc.regime?.type            || null,
        cotSignal:       mc.cotSignal?.signal       || null,
        cotPercentile:   mc.cotSignal?.percentile   ?? null,

        // Futures
        basisSignal:        fc.basis?.signal         || null,
        priceDiscoveryRole: fc.priceDiscovery?.role  || null,
        deltaImbalance:     fc.deltaImbalance?.signal || null,

        // Cross-asset
        nqDivergence:       ca.nqDivergence?.signal  || null,
        riskSentiment:      ca.riskSentiment?.label  || null,
        riskSentimentScore: ca.riskSentiment?.score  ?? null,

        // VWAP
        vwapSignal:      activeVwap.signal           || null,
        vwapBias:        activeVwap.bias || activeVwap.side || null,
        vwapZScore:      activeVwap.zScore           ?? null,
        usingSessionVwap: !!(vwap.sessionVwap),

        // Direction signals
        signalVotes:     allSignals,
        bullishCount, bearishCount, convergenceRatio, totalSignals,

        // Top factors
        topFactors,

        // Layer scores
        scoreMacro:      parseFloat(layerScores.MACRO       ?? layerScores.macro       ?? 0) || null,
        scoreFutures:    parseFloat(layerScores.FUTURES     ?? layerScores.futures     ?? 0) || null,
        scoreMicro:      parseFloat(layerScores.MICRO       ?? layerScores.micro       ?? 0) || null,
        scoreTick:       parseFloat(layerScores.TICK        ?? layerScores.tick        ?? 0) || null,
        scoreExecution:  parseFloat(layerScores.EXECUTION   ?? layerScores.execution   ?? 0) || null,
        scoreCrossAsset: parseFloat(layerScores.CROSS_ASSET ?? layerScores.crossAsset  ?? 0) || null,
      };

      console.log('[Automation] ✅ Order placed successfully. ID:', response.orderId);

      // Start monitoring for fill (with scalp-specific timeout)
      startScalpFillMonitoring();
    } else {
      console.error('[Automation] ❌ Order placement failed:', response.error);
    }
    
  } catch (error) {
    console.error('[Automation] Error executing scalp:', error);
  }
}

// ============================================================================
// SCALP MONITORING (Fast timeouts for scalping)
// ============================================================================

/**
 * Monitor for order fill (scalping version - faster timeout)
 */
function startScalpFillMonitoring() {
  if (automationState.fillMonitorInterval) {
    clearInterval(automationState.fillMonitorInterval);
  }
  
  console.log('[Automation] Starting scalp fill monitoring...');
  
  automationState.fillMonitorInterval = setInterval(async () => {
    if (!automationState.hasOpenOrder) {
      clearInterval(automationState.fillMonitorInterval);
      automationState.fillMonitorInterval = null;
      return;
    }
    
    // Scalp timeout: 5 minutes (not 90 minutes like swing trades)
    const elapsedSeconds = (Date.now() - automationState.orderPlacedTime) / 1000;
    const maxWaitTime = automationState.currentOrder.maxHoldTime || 300; // 5 minutes
    
    if (elapsedSeconds > maxWaitTime) {
      console.log('[Automation] ⏱️ Scalp order timeout - cancelling');
      clearInterval(automationState.fillMonitorInterval);
      automationState.fillMonitorInterval = null;

      // Attempt to cancel — but force-clear state regardless of API outcome.
      // If cancel fails (network error, exchange already rejected), the fill monitor
      // is already cleared; without force-clearing here hasOpenOrder stays true forever.
      const cancelledOrder = automationState.currentOrder;
      await cancelOrder(automationState.currentOrderId);

      // Force-clear in case cancelOrder failed and left hasOpenOrder=true
      automationState.hasOpenOrder    = false;
      automationState.currentOrderId  = null;
      automationState.currentOrder    = null;
      automationState.orderPlacedTime = null;

      // Log as passed opportunity
      logPassedScalp('TIMEOUT', cancelledOrder);

      return;
    }
    
    // Check order status
    try {
      const response = await topstepx.checkOrderStatus(automationState.currentOrderId);
      
      // Handle terminal states — REJECTED (5) or CANCELLED (3): clear state immediately
      if (response.statusCode === 5 || response.statusCode === 3) {
        const label = response.statusCode === 5 ? 'REJECTED' : 'CANCELLED';
        console.log(`[Automation] ⚠️ Order ${label} (statusCode=${response.statusCode}) — clearing order state`);
        clearInterval(automationState.fillMonitorInterval);
        automationState.fillMonitorInterval = null;
        const cancelledOrder = automationState.currentOrder;
        automationState.hasOpenOrder    = false;
        automationState.currentOrderId  = null;
        automationState.currentOrder    = null;
        automationState.orderPlacedTime = null;
        logPassedScalp(label, cancelledOrder);
        return;
      }

      if (response.filled) {
        console.log('[Automation] ✅ Order filled! Price:', response.fillPrice);
        console.log('[FillPath] ── FILL TRANSITION ──────────────────────────────────');
        console.log('[FillPath] orderId:', automationState.currentOrderId);
        console.log('[FillPath] currentOrder:', JSON.stringify(automationState.currentOrder));
        clearInterval(automationState.fillMonitorInterval);
        automationState.fillMonitorInterval = null;

        // Guard: currentOrder must be intact for position monitor to work
        if (!automationState.currentOrder) {
          console.error('[FillPath] ❌ CRITICAL: currentOrder is null after fill — cannot start position monitor. Trade is open at broker with active brackets.');
          automationState.hasOpenOrder  = false;
          automationState.inActiveTrade = false;
          return;
        }

        automationState.hasOpenOrder = false;
        automationState.inActiveTrade = true;
        automationState.currentTrade = {
          entry: response.fillPrice,
          entryTime: Date.now(),
          direction: automationState.currentOrder.direction.toUpperCase(),
          contracts: automationState.currentOrder.size,
          confidence: automationState.currentOrder.confidence,
          grade: automationState.currentOrder.grade
        };
        console.log('[FillPath] currentTrade set:', JSON.stringify(automationState.currentTrade));

        try {
          db.saveActiveTrade({
            direction:  automationState.currentTrade.direction,
            entry:      automationState.currentTrade.entry,
            stopLoss:   automationState.currentOrder.stopLoss,
            takeProfit: automationState.currentOrder.takeProfit,
            confidence: automationState.currentOrder.confidence,
            grade:      automationState.currentOrder.grade,
            entryTime:  automationState.currentTrade.entryTime,
            contractId: db.getSetting('selectedContractId') || config.trading.defaultContractId,
          });
          console.log('[FillPath] ✅ Active trade persisted to DB');
        } catch (dbErr) {
          console.error('[FillPath] ❌ db.saveActiveTrade failed:', dbErr.message);
        }

        console.log('[FillPath] Handing off to position monitor...');
        // Start position monitoring (scalp version - check every 5 seconds)
        startScalpPositionMonitoring();
        console.log('[FillPath] ✅ Position monitor started');
        console.log('[FillPath] ────────────────────────────────────────────────────');
      }
    } catch (error) {
      console.error('[Automation] Error checking order status:', error);
    }
  }, 10000); // Check every 10 seconds
}

/**
 * Monitor position for SL/TP (scalping version - faster checks).
 * Uses live SignalR quote mid-price; falls back to 5m bar close only if stream is down.
 * Implements break-even stop (at +1R) and trailing stop (at +1.5R).
 * Tracks max favorable / adverse excursion for learning analytics.
 */
function startScalpPositionMonitoring() {
  if (automationState.positionMonitorInterval) {
    clearInterval(automationState.positionMonitorInterval);
  }

  console.log('[Automation] Starting scalp position monitoring...');

  // Guard: both currentOrder and currentTrade must be set
  if (!automationState.currentOrder) {
    console.error('[PosMonitor] ❌ CRITICAL: currentOrder is null — cannot start position monitor. Broker brackets still active.');
    automationState.inActiveTrade = false;
    return;
  }
  if (!automationState.currentTrade) {
    console.error('[PosMonitor] ❌ CRITICAL: currentTrade is null — cannot start position monitor. Broker brackets still active.');
    automationState.inActiveTrade = false;
    return;
  }

  // Record when this position opened so we can enforce maxHoldTime
  const positionOpenTime = Date.now();
  const maxHoldMs = (automationState.currentOrder?.maxHoldTime || 300) * 1000;

  // Capture order in closure so mutations to stopLoss persist across interval ticks
  const order = automationState.currentOrder;
  const riskAmount = Math.abs((order.price || order.stopLoss) - order.stopLoss);

  console.log(`[PosMonitor] Tracking ${order.direction?.toUpperCase()} @ ${automationState.currentTrade.entry} | SL:${order.stopLoss} TP:${order.takeProfit} | maxHold:${maxHoldMs/1000}s`);

  // Closure state for trail / break-even
  let breakEvenTriggered    = false;
  let breakEvenStopLevel    = null;
  let trailStopTriggered    = false;
  let trailStopLevel        = null;
  let maxFavorableExcursion = 0;
  let maxAdverseExcursion   = 0;

  // Regime-aware effective hold time
  const entryCtx = automationState.tradeContext;
  const effectiveHoldMs =
    entryCtx?.rvivRegime === 'TRENDING' ? Math.max(maxHoldMs, 300_000) :
    entryCtx?.rvivRegime === 'RANGING'  ? Math.min(maxHoldMs, 120_000) :
    maxHoldMs;

  automationState.positionMonitorInterval = setInterval(async () => {
  try {
    if (!automationState.inActiveTrade) {
      clearInterval(automationState.positionMonitorInterval);
      automationState.positionMonitorInterval = null;
      return;
    }

    // Get current price — prefer live quote stream over stale bar close
    let currentPrice;
    const lq = QuoteStream.getLatestQuote();
    if (lq && lq.mid) {
      currentPrice = lq.mid;
    } else {
      const bars = await fetchBars();
      if (!bars?.['5m']?.length) {
        console.warn('[Automation] No price source available — skipping monitor tick');
        return;
      }
      currentPrice = bars['5m'][0].close;
    }

    const trade = automationState.currentTrade;
    if (!trade) {
      console.error('[PosMonitor] ❌ currentTrade became null mid-monitor — clearing interval');
      clearInterval(automationState.positionMonitorInterval);
      automationState.positionMonitorInterval = null;
      automationState.inActiveTrade = false;
      return;
    }

    // Compact per-tick status line
    const holdSec = ((Date.now() - positionOpenTime) / 1000).toFixed(0);
    console.log(`[PosMonitor] ${trade.direction} @ ${trade.entry} | now:${currentPrice} | SL:${order.stopLoss} TP:${order.takeProfit} | hold:${holdSec}s`);

    // Track excursion (positive = moving in our favour)
    const excursion = trade.direction === 'LONG'
      ? currentPrice - trade.entry
      : trade.entry - currentPrice;
    if (excursion > maxFavorableExcursion) maxFavorableExcursion = excursion;
    if (excursion < maxAdverseExcursion)   maxAdverseExcursion   = excursion;

    // ── Break-even and trailing stop ────────────────────────────────────────────
    // NOTE: These update order.stopLoss in memory ONLY. The broker's original bracket
    // stop-loss order (placed at entry) is NOT modified — TopstepX does not expose an
    // order-modification endpoint. The broker bracket is the real account protection.
    // BE/trail serve two purposes:
    //   1. Exit detection — when currentPrice crosses order.stopLoss, we log the reason
    //      (BREAKEVEN_STOP or TRAIL) and assume the broker's bracket already filled.
    //   2. Tighter virtual tracking — if we add an order-modification API in future,
    //      order.stopLoss is already the right value to send.

    // Break-even: move stop to entry +/- 1 tick when position reaches +1R profit
    if (!breakEvenTriggered && excursion >= riskAmount) {
      breakEvenTriggered = true;
      order.stopLoss = trade.direction === 'LONG' ? trade.entry + 0.25 : trade.entry - 0.25;
      breakEvenStopLevel = order.stopLoss;
      console.log(`[Automation] 🔒 Break-even: stop → ${order.stopLoss.toFixed(2)}`);
    }

    // Trailing stop: activates at +1.5R, trails at max(0.5σ, 0.5R) behind price
    const sigmaPoints = (entryCtx?.sigma ?? 0.002) * currentPrice;
    if (excursion >= riskAmount * 1.5) {
      trailStopTriggered = true;
      const trailDist = Math.max(sigmaPoints * 0.5, riskAmount * 0.5);
      const newTrail = trade.direction === 'LONG'
        ? currentPrice - trailDist
        : currentPrice + trailDist;
      // Only tighten — never loosen the trail
      if (trailStopLevel === null
        || (trade.direction === 'LONG'  && newTrail > trailStopLevel)
        || (trade.direction === 'SHORT' && newTrail < trailStopLevel)) {
        trailStopLevel = newTrail;
        const effectiveStop = breakEvenStopLevel !== null
          ? (trade.direction === 'LONG'
              ? Math.max(newTrail, breakEvenStopLevel)
              : Math.min(newTrail, breakEvenStopLevel))
          : newTrail;
        order.stopLoss = effectiveStop;
        console.log(`[Automation] 📈 Trail: ${effectiveStop.toFixed(2)}`);
      }
    }

    // ── Time-based exit: close if held beyond effectiveHoldMs ─────────────
    const holdMs = Date.now() - positionOpenTime;
    if (holdMs > effectiveHoldMs) {
      const pnl = calculatePnL(trade.entry, currentPrice, trade.direction, trade.contracts);
      console.warn(
        `[Automation] ⏱️ Max hold time exceeded (${(holdMs / 1000).toFixed(0)}s / ${effectiveHoldMs / 1000}s) ` +
        `— sending market close at ${currentPrice} | P&L: $${pnl.toFixed(2)}`
      );

      const contractId = db.getSetting('selectedContractId') || config.trading.defaultContractId;

      // Await the close — only clear state after confirmed success.
      // On failure, leave the monitor running so it retries on the next tick.
      let closeResult;
      try {
        closeResult = await topstepx.closePosition({
          contractId,
          direction: trade.direction.toLowerCase(),
          size: trade.contracts
        });
      } catch (err) {
        console.error('[Automation] Time-exit close exception:', err.message);
        closeResult = { success: false, error: err.message };
      }

      if (!closeResult.success) {
        console.error('[Automation] ❌ Time-exit close failed:', closeResult.error, '— will retry next tick');
        return; // leave interval running; retry on next monitor tick
      }

      console.log(`[Automation] ✅ Time-exit market order placed. ID: ${closeResult.orderId}`);
      console.log(`[PosMonitor] Exit: reason=TIME entry=${trade.entry} exit=${currentPrice} duration=${(holdMs/1000).toFixed(0)}s MFE=${maxFavorableExcursion.toFixed(2)} MAE=${maxAdverseExcursion.toFixed(2)}`);
      clearInterval(automationState.positionMonitorInterval);
      automationState.positionMonitorInterval = null;
      updateScalpingMetrics(pnl >= 0 ? 'WIN' : 'LOSS', pnl);
      console.log('[PosMonitor] Calling logScalpResult...');
      logScalpResult(pnl >= 0 ? 'WIN' : 'LOSS', {
        entry: trade.entry, exit: currentPrice, pnl, duration: holdMs,
        confidence: trade.confidence, grade: trade.grade,
        exitReason: 'TIME',
        maxFavorableExcursion, maxAdverseExcursion,
        breakEvenTriggered, trailStopTriggered
      });
      automationState.inActiveTrade = false;
      automationState.currentTrade  = null;
      return;
    }

    // Check SL/TP hit (stopLoss may have been updated by break-even or trail)
    const slHit = trade.direction === 'LONG'
      ? currentPrice <= order.stopLoss
      : currentPrice >= order.stopLoss;

    const tpHit = trade.direction === 'LONG'
      ? currentPrice >= order.takeProfit
      : currentPrice <= order.takeProfit;

    if (slHit || tpHit) {
      const exitPrice = tpHit ? order.takeProfit : order.stopLoss;
      const pnl       = calculatePnL(trade.entry, exitPrice, trade.direction, trade.contracts);
      // Base outcome on actual P&L, not exit mechanism.
      // BREAKEVEN_STOP and TRAIL exits can be profitable even though SL fired —
      // counting them as losses incorrectly inflates the streak counter.
      const outcome   = pnl >= 0 ? 'WIN' : 'LOSS';
      const duration  = Date.now() - trade.entryTime;

      // Determine exit reason
      let exitReason;
      if (tpHit)                                       exitReason = 'TP';
      else if (slHit && trailStopTriggered)            exitReason = 'TRAIL';
      else if (slHit && breakEvenTriggered)            exitReason = 'BREAKEVEN_STOP';
      else                                             exitReason = 'SL';

      console.log(`[Automation] 🎯 Scalp closed: ${outcome} - P&L: $${pnl.toFixed(2)}`);
      console.log(`[PosMonitor] Exit: reason=${exitReason} entry=${trade.entry} exit=${exitPrice} duration=${(duration/1000).toFixed(0)}s MFE=${maxFavorableExcursion.toFixed(2)} MAE=${maxAdverseExcursion.toFixed(2)}`);

      clearInterval(automationState.positionMonitorInterval);
      automationState.positionMonitorInterval = null;

      updateScalpingMetrics(outcome, pnl);
      console.log('[PosMonitor] Calling logScalpResult...');
      logScalpResult(outcome, {
        entry: trade.entry, exit: exitPrice, pnl, duration,
        confidence: trade.confidence, grade: trade.grade,
        exitReason,
        maxFavorableExcursion, maxAdverseExcursion,
        breakEvenTriggered, trailStopTriggered
      });

      automationState.inActiveTrade = false;
      automationState.currentTrade  = null;
    }
  } catch (monitorErr) {
    // Catch-all: log the full error so it's easy to pinpoint, but don't kill the interval.
    // The broker's brackets remain active regardless of what happens here.
    console.error('[PosMonitor] ❌ Unhandled error in position monitor tick:', monitorErr.message);
    console.error('[PosMonitor] Stack:', monitorErr.stack);
    console.error('[PosMonitor] State snapshot — inActiveTrade:', automationState.inActiveTrade,
      '| currentTrade:', JSON.stringify(automationState.currentTrade),
      '| currentOrder:', JSON.stringify(automationState.currentOrder));
  }
  }, 5000); // Check every 5 seconds (faster than swing trading)
}

/**
 * Cancel order
 */
async function cancelOrder(orderId) {
  console.log('[Automation] Cancelling order:', orderId);
  
  try {
    const response = await topstepx.cancelOrder(orderId);
    
    if (response.success) {
      automationState.hasOpenOrder = false;
      automationState.currentOrderId = null;
      automationState.currentOrder = null;
      automationState.orderPlacedTime = null;
      
      console.log('[Automation] ✅ Order cancelled successfully');
      
      if (automationState.fillMonitorInterval) {
        clearInterval(automationState.fillMonitorInterval);
        automationState.fillMonitorInterval = null;
      }
    } else {
      console.error('[Automation] ❌ Order cancellation failed:', response.error);
    }
    
    return response;
  } catch (error) {
    console.error('[Automation] Error cancelling order:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// METRICS TRACKING
// ============================================================================

function resetDailyMetricsIfNeeded() {
  const today = new Date().toDateString();

  if (automationState.scalpingMetrics.lastResetDate !== today) {
    console.log('[Automation] 📊 New trading day — resetting metrics');

    // Log all-time win-rate-by-phase before reset (feedback loop)
    try {
      const phaseStats = db.getWinRateByPhase();
      const phases = Object.keys(phaseStats);
      if (phases.length > 0) {
        console.log('[Automation] 📊 All-time win rate by session phase:');
        for (const phase of phases) {
          const s = phaseStats[phase];
          console.log(`  ${phase.padEnd(14)} ${s.winRate.padStart(6)}  (${s.total} trades | avg ${s.avgPnL} | total $${s.pnl.toFixed(2)})`);
        }
      }
    } catch (err) {
      console.warn('[Automation] Phase stats error (non-fatal):', err.message);
    }

    automationState.scalpingMetrics = {
      dailyTrades: 0,
      dailyWins: 0,
      dailyLosses: 0,
      dailyPnL: 0,
      lastResetDate: today,
      consecutiveLosses: 0,
      streakPauseUntil:  null
    };

    db.deleteSetting('vixHistory');
    console.log('[Automation] VIX history cleared for new session');

    // Load adaptive phase calibration from historical win-rate (requires ≥50 trades per phase)
    try {
      automationState.adaptivePhaseAdjustments = db.getAdaptivePhaseAdjustments(50);
      const keys = Object.keys(automationState.adaptivePhaseAdjustments);
      if (keys.length > 0) {
        console.log('[Automation] 📊 Adaptive phase adjustments:', automationState.adaptivePhaseAdjustments);
      } else {
        console.log('[Automation] 📊 Adaptive phase: insufficient trade history (need 50+ trades/phase)');
      }
    } catch (err) {
      console.warn('[Automation] Adaptive phase load error (non-fatal):', err.message);
    }

    // Load adaptive regime adjustments from historical RV/IV regime win-rate (requires ≥30 trades per regime)
    try {
      automationState.adaptiveRegimeAdjustments = db.getAdaptiveRegimeAdjustments(30);
      console.log('[Automation] Adaptive regime adjustments:', automationState.adaptiveRegimeAdjustments);
    } catch (err) {
      console.warn('[Automation] Adaptive regime load error (non-fatal):', err.message);
    }
  }
}

function updateScalpingMetrics(outcome, pnl) {
  automationState.scalpingMetrics.dailyTrades++;

  if (outcome === 'WIN') {
    automationState.scalpingMetrics.dailyWins++;
    automationState.scalpingMetrics.consecutiveLosses = 0;
  } else {
    automationState.scalpingMetrics.dailyLosses++;
    automationState.scalpingMetrics.consecutiveLosses++;
    // Streak pause disabled — counter tracked for analytics only.
    console.log(`[Automation] 📊 Consecutive losses: ${automationState.scalpingMetrics.consecutiveLosses}`);
  }

  automationState.scalpingMetrics.dailyPnL += pnl;

  // Persist daily metrics so they survive a process restart within the same trading day
  const metrics = automationState.scalpingMetrics;
  db.setSetting('dailyMetrics', {
    date:              metrics.lastResetDate,
    dailyTrades:       metrics.dailyTrades,
    dailyWins:         metrics.dailyWins,
    dailyLosses:       metrics.dailyLosses,
    dailyPnL:          metrics.dailyPnL,
    consecutiveLosses: metrics.consecutiveLosses,
    streakPauseUntil:  metrics.streakPauseUntil,
  });

  const winRate = metrics.dailyTrades > 0 ?
    (metrics.dailyWins / metrics.dailyTrades * 100).toFixed(1) : 0;

  console.log('[Automation] 📊 Daily Metrics:', {
    trades: metrics.dailyTrades,
    wins: metrics.dailyWins,
    losses: metrics.dailyLosses,
    winRate: winRate + '%',
    pnl: '$' + metrics.dailyPnL.toFixed(2)
  });
}

function logScalpResult(outcome, details) {
  const ctx = automationState.tradeContext || {};

  db.saveTrade({
    timestamp:       Date.now(),
    direction:       automationState.currentTrade?.direction?.toLowerCase() || null,
    path:            ctx.path            || null,
    grade:           details.grade       || ctx.grade  || null,
    confidence:      details.confidence  || null,

    entry:           details.entry       || null,
    stopLoss:        automationState.currentOrder?.stopLoss  ?? null,
    takeProfit:      automationState.currentOrder?.takeProfit ?? null,
    exitPrice:       details.exit        || null,
    exitReason:      details.exitReason  || null,
    profitLoss:      details.pnl         ?? null,
    outcome:         outcome === 'WIN' ? 'win' : 'loss',
    durationSeconds: details.duration ? parseFloat((details.duration / 1000).toFixed(1)) : null,

    entryType:       ctx.entryType       || null,
    tickConfidence:  automationState.currentOrder?.tickConfidence ?? null,
    maxFavorableExcursion: details.maxFavorableExcursion ?? null,
    maxAdverseExcursion:   details.maxAdverseExcursion   ?? null,
    breakEvenTriggered:    details.breakEvenTriggered    ?? false,
    trailStopTriggered:    details.trailStopTriggered    ?? false,

    session:         ctx.session         || IntraydayCycle.getCycleContext().phase,
    sessionBarDelta: ctx.sessionBarDelta ?? null,
    sessionBarCount: ctx.sessionBarCount ?? null,
    holdTimeMax:     ctx.holdTimeMax     || null,

    sigma:           ctx.sigma           ?? null,
    volRegime:       ctx.volRegime       || null,
    rvivRatio:       ctx.rvivRatio       ?? null,
    rvivRegime:      ctx.rvivRegime      || null,
    rvivRegimeRaw:   ctx.rvivRegimeRaw   || null,

    vix:             ctx.vix             ?? null,
    vix3m:           ctx.vix3m           ?? null,
    vixStructure:    ctx.vixStructure    || null,
    vixTrend:        ctx.vixTrend        || null,
    macroRegime:     ctx.macroRegime     || null,
    cotSignal:       ctx.cotSignal       || null,
    cotPercentile:   ctx.cotPercentile   ?? null,

    basisSignal:        ctx.basisSignal        || null,
    priceDiscoveryRole: ctx.priceDiscoveryRole || null,
    deltaImbalance:     ctx.deltaImbalance     || null,

    nqDivergence:       ctx.nqDivergence       || null,
    riskSentiment:      ctx.riskSentiment      || null,
    riskSentimentScore: ctx.riskSentimentScore ?? null,

    vwapSignal:      ctx.vwapSignal      || null,
    vwapBias:        ctx.vwapBias        || null,
    vwapZScore:      ctx.vwapZScore      ?? null,
    usingSessionVwap: ctx.usingSessionVwap ?? null,

    signalVotes:     ctx.signalVotes     || null,
    bullishCount:    ctx.bullishCount    ?? null,
    bearishCount:    ctx.bearishCount    ?? null,
    convergenceRatio: ctx.convergenceRatio ?? null,
    totalSignals:    ctx.totalSignals    ?? null,

    topFactors:      ctx.topFactors      || null,

    scoreMacro:      ctx.scoreMacro      ?? null,
    scoreFutures:    ctx.scoreFutures    ?? null,
    scoreMicro:      ctx.scoreMicro      ?? null,
    scoreTick:       ctx.scoreTick       ?? null,
    scoreExecution:  ctx.scoreExecution  ?? null,
    scoreCrossAsset: ctx.scoreCrossAsset ?? null,
  });

  console.log('[Automation] Scalp Result:', {
    outcome,
    path:        ctx.path                               || '?',
    regime:      ctx.rvivRegime                         || '?',
    vixStructure: ctx.vixStructure                      || '?',
    convergence: ctx.convergenceRatio != null ? (ctx.convergenceRatio * 100).toFixed(0) + '%' : '?',
    exitReason:  details.exitReason                     || '?',
    pnl:         '$' + (details.pnl || 0).toFixed(2),
    duration:    details.duration ? (details.duration / 1000).toFixed(0) + 's' : '?',
    mfe:         details.maxFavorableExcursion != null ? details.maxFavorableExcursion.toFixed(2) : '?',
    mae:         details.maxAdverseExcursion   != null ? details.maxAdverseExcursion.toFixed(2)   : '?',
  });

  // Update signal scorecard with this trade's data (non-fatal)
  try {
    const scorecard = SignalScorecard.updateScorecard();
    automationState.scorecardWeights = scorecard.activeWeights;
    if (scorecard.activeWeights.sufficient) {
      const tw = scorecard.activeWeights.layerWeights;
      const adjusted = Object.entries(tw).filter(([, w]) => w !== 1.0).map(([l, w]) => `${l}=${w}`).join(' ');
      if (adjusted) console.log(`[Analytics] Scorecard weights updated: ${adjusted}`);
    }
  } catch (err) {
    console.warn('[Analytics] Scorecard update failed (non-fatal):', err.message);
  }

  // Clear persisted active trade and context after saving
  db.clearActiveTrade();
  automationState.tradeContext   = null;
  automationState.cycleSnapshot  = null;
  automationState.currentOrder   = null;   // Prevent stale SL/TP on the next re-entry
  automationState.lastTradeExitTime = Date.now();  // Re-entry cooldown clock starts here
}

function logPassedScalp(reason, order) {
  db.savePassedScalp({
    reason,
    grade:      order.grade      || null,
    confidence: order.confidence || null,
    direction:  order.direction  || null,
    price:      order.price      || null,
    stopLoss:   order.stopLoss   || null,
    takeProfit: order.takeProfit || null,
  });
  console.log('[Automation] Passed Scalp:', { reason, grade: order.grade, confidence: order.confidence });
}

// ============================================================================
// CONSOLE DISPLAY (replaces DOM/window.postMessage)
// ============================================================================

function displayScalpingContext(macroContext, futuresContext, confidence, cycleContext, volContext, crossAssetContext) {
  const m = automationState.scalpingMetrics;
  const winRate = m.dailyTrades > 0 ? (m.dailyWins / m.dailyTrades * 100).toFixed(1) : '0.0';
  const cot = macroContext.cotSignal ? macroContext.cotSignal.signal.replace('DEALERS_', 'D:') : 'D:N/A';
  const vol = volContext ? `σ=${(volContext.sigma * 100).toFixed(3)}%(${volContext.regime.substring(0,3)})` : '';
  const phase = cycleContext ? cycleContext.phase.substring(0,7) : '';
  const ca = crossAssetContext
    ? `NQ:${crossAssetContext.nqDivergence.signal.substring(0,7)} Risk:${crossAssetContext.riskSentiment.label.substring(0,8)}`
    : 'CA:N/A';
  console.log(
    `[Scalping] Regime:${macroContext.regime.type.substring(0,7)} ` +
    `| ${cot} | ${vol} | Phase:${phase} ` +
    `| Basis:${futuresContext.basis.signal.substring(0,6)} ` +
    `| Delta:${futuresContext.deltaImbalance.signal.substring(0,8)} ` +
    `| ${ca} ` +
    `| Conf:${confidence.confidence.toFixed(1)}(${confidence.grade}) ` +
    `| Dir:${confidence.direction || 'NONE'} ` +
    `| Signal:${confidence.shouldScalp ? 'YES' : 'no'} ` +
    `| Day: ${m.dailyTrades}T ${winRate}% $${m.dailyPnL.toFixed(2)}`
  );
}

// ============================================================================
// START/STOP CONTROLS
// ============================================================================

async function startAutomation() {
  console.log('[Automation] 🚀 Starting v19.0.0');

  // ── Analytics initialization ──────────────────────────────────────────────
  // Generate previous day's summary if it doesn't already exist
  try {
    const prevSummary = DailySummary.generatePreviousDaySummary();
    if (prevSummary) console.log(`[Analytics] Previous day summary: ${prevSummary.overall.totalTrades} trades, $${prevSummary.overall.netPnL.toFixed(2)}`);
  } catch (err) {
    console.warn('[Analytics] Daily summary generation failed (non-fatal):', err.message);
  }

  // Load signal scorecard weights for layer multipliers
  try {
    automationState.scorecardWeights = SignalScorecard.getWeightMultipliers();
    if (automationState.scorecardWeights.sufficient) {
      const tw = automationState.scorecardWeights.layerWeights;
      const adjusted = Object.entries(tw).filter(([, w]) => w !== 1.0).map(([l, w]) => `${l}=${w}`).join(' ');
      console.log(`[Analytics] Scorecard loaded (${automationState.scorecardWeights.totalTrades} trades)${adjusted ? ': ' + adjusted : ''}`);
    } else {
      console.log(`[Analytics] Scorecard: insufficient data (${automationState.scorecardWeights.totalTrades} trades, need ${30}+) — all weights 1.0`);
    }
  } catch (err) {
    console.warn('[Analytics] Scorecard load failed (non-fatal):', err.message);
  }

  // Reset macro timestamp to force check on first cycle
  automationState.macroContextTimestamp = 0;

  // Start SignalR quote stream (non-blocking — falls back gracefully if it fails)
  const sessionToken = db.getSetting('sessionToken');
  const contractId   = db.getSetting('selectedContractId') || config.trading.defaultContractId;
  if (sessionToken) {
    QuoteStream.start(contractId, sessionToken).catch(err => {
      console.warn('[Automation] QuoteStream start error (non-fatal):', err.message);
    });
  }

  // Restore daily trade metrics if the system was restarted within the same trading day.
  // Without this, dailyTrades/dailyPnL reset to 0 on every restart, allowing trades past
  // the daily trade limit and loss limit guardrails.
  const savedMetrics = db.getSetting('dailyMetrics');
  const today = new Date().toDateString();
  if (savedMetrics && savedMetrics.date === today) {
    automationState.scalpingMetrics.dailyTrades       = savedMetrics.dailyTrades       || 0;
    automationState.scalpingMetrics.dailyWins         = savedMetrics.dailyWins         || 0;
    automationState.scalpingMetrics.dailyLosses       = savedMetrics.dailyLosses       || 0;
    automationState.scalpingMetrics.dailyPnL          = savedMetrics.dailyPnL          || 0;
    automationState.scalpingMetrics.consecutiveLosses = savedMetrics.consecutiveLosses || 0;
    automationState.scalpingMetrics.streakPauseUntil  = savedMetrics.streakPauseUntil  || null;
    automationState.scalpingMetrics.lastResetDate     = today;
    const pauseStatus = savedMetrics.streakPauseUntil && Date.now() < savedMetrics.streakPauseUntil
      ? ` | streak pause until ${new Date(savedMetrics.streakPauseUntil).toLocaleTimeString()}` : '';
    console.log(`[Automation] 📊 Restored today's metrics: ${savedMetrics.dailyTrades} trades, $${(savedMetrics.dailyPnL || 0).toFixed(2)} P&L${pauseStatus}`);
  }

  // Recover open trade from previous session if system was restarted during a live position.
  // SAFETY: verify the position still exists at the broker before resuming monitoring.
  // If the broker already closed it (SL/TP filled while system was down), skipping
  // monitoring avoids sending a market close order for a non-existent position which
  // would open a new position in the wrong direction.
  const persistedTrade = db.getActiveTrade();
  if (persistedTrade) {
    console.warn('[Automation] ⚠️ Persisted trade found — verifying with broker before resuming...');
    try {
      const openPositions = await topstepx.getOpenPositions();
      const recoveryContractId = persistedTrade.contractId
        || db.getSetting('selectedContractId')
        || config.trading.defaultContractId;

      if (openPositions === null) {
        // API failure — cannot confirm position state.
        // Skip monitoring: broker bracket orders (SL/TP placed at entry) still protect the account.
        console.error('[Automation] ❌ Cannot verify open position with broker (API error). Skipping recovery monitoring — broker bracket orders remain active.');
        db.clearActiveTrade();
      } else {
        const found = openPositions.find(p =>
          p.contractId === recoveryContractId ||
          (p.contractId || '').includes('MES')
        );
        if (found) {
          console.warn('[Automation] ✅ Broker confirms open position — resuming monitoring:', persistedTrade);
          automationState.inActiveTrade = true;
          automationState.currentOrder = {
            stopLoss:    persistedTrade.stopLoss,
            takeProfit:  persistedTrade.takeProfit,
            price:       persistedTrade.entry,
            size:        config.trading.contracts,
            confidence:  persistedTrade.confidence,
            grade:       persistedTrade.grade,
            maxHoldTime: 300,
          };
          automationState.currentTrade = {
            direction:  persistedTrade.direction,
            entry:      persistedTrade.entry,
            entryTime:  persistedTrade.entryTime || Date.now(),
            contracts:  config.trading.contracts,
            confidence: persistedTrade.confidence,
            grade:      persistedTrade.grade,
          };
          startScalpPositionMonitoring();
        } else {
          console.warn('[Automation] ✅ Broker shows no open position — was closed while system was down. Clearing persisted state.');
          db.clearActiveTrade();
        }
      }
    } catch (err) {
      console.error('[Automation] Recovery verification error — skipping monitoring:', err.message);
      db.clearActiveTrade();
    }
  }

  // Start macro updates
  startMacroUpdates();

  // Start main loop
  automationState.status = 'RUNNING';
  automationState.mainLoopInterval = setInterval(
    runScalpingCycle,
    CONSTRAINTS.loopFrequency
  );

  // Run immediately
  await runScalpingCycle();

  console.log('[Automation] ✅ System running - Scalping intelligence active');
}

function stopAutomation() {
  console.log('[Automation] ⏹️ Stopping automation...');
  
  automationState.status = 'STOPPED';
  
  if (automationState.mainLoopInterval) {
    clearInterval(automationState.mainLoopInterval);
    automationState.mainLoopInterval = null;
  }
  
  if (automationState.macroUpdateInterval) {
    clearInterval(automationState.macroUpdateInterval);
    automationState.macroUpdateInterval = null;
  }
  
  if (automationState.fillMonitorInterval) {
    clearInterval(automationState.fillMonitorInterval);
    automationState.fillMonitorInterval = null;
  }
  
  if (automationState.positionMonitorInterval) {
    clearInterval(automationState.positionMonitorInterval);
    automationState.positionMonitorInterval = null;
  }

  // Stop SignalR quote stream
  QuoteStream.stop().catch(() => {});

  console.log('[Automation] ✅ Automation stopped');
}

// ============================================================================
// MESSAGE LISTENERS
// ============================================================================

// ============================================================================
// ============================================================================
// EXPORTS (Node.js module)
// ============================================================================

// ─── Graceful shutdown on SIGINT / SIGTERM ────────────────────────────────────
// Cancels any pending limit order before exiting so stale orders don't sit in
// the broker's book after the process dies (e.g. Ctrl+C or kill signal).

async function gracefulShutdown(signal) {
  console.log(`\n[Automation] 🛑 ${signal} received — shutting down gracefully...`);

  // Stop main loop first so no new orders fire
  stopAutomation();

  // Cancel any pending (unfilled) order
  if (automationState.hasOpenOrder && automationState.currentOrderId) {
    console.log(`[Automation] Cancelling open order ${automationState.currentOrderId}...`);
    try {
      await topstepx.cancelOrder(automationState.currentOrderId);
      console.log('[Automation] ✅ Open order cancelled');
    } catch (err) {
      console.error('[Automation] ❌ Failed to cancel open order on shutdown:', err.message);
    }
    automationState.hasOpenOrder   = false;
    automationState.currentOrderId = null;
  }

  const m = automationState.scalpingMetrics;
  console.log('[Automation] Final metrics:', {
    trades: m.dailyTrades,
    wins:   m.dailyWins,
    losses: m.dailyLosses,
    pnl:    `$${m.dailyPnL.toFixed(2)}`
  });
  console.log('[Automation] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = {
  start:      startAutomation,
  stop:       stopAutomation,
  getState:   () => automationState,
  getMetrics: () => automationState.scalpingMetrics
};
