// ============================================================================
// MACRO CONTEXT MODULE v18.0.0
// Passive Flow Detection Based on Academic Research
// ============================================================================
// Computes institutional flow mechanics using publicly available data

const { execSync } = require('child_process');
const db      = require('../storage/db');
const CotData = require('./cot-data');
// Theory: Jiang-Vayanos-Zheng (2025), Chinco-Sammon (2022), Ben-David (2018)
// ============================================================================

console.log('[MacroContext] Loading macro-context.js v18.0.0...');

// ============================================================================
// LIVE VIX FEED
// ============================================================================

/**
 * Fetch live VIX from Yahoo Finance. Cached in DB for 1 hour.
 * Falls back to 15.5 (neutral) if fetch fails.
 * URL: query1.finance.yahoo.com/v8/finance/chart/%5EVIX
 */
function getLiveVIX() {
  const VIX_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  const cachedVix       = db.getSetting('vixPrice');
  const cachedTimestamp = db.getSetting('vixTimestamp');

  if (cachedVix && cachedTimestamp && (Date.now() - cachedTimestamp) < VIX_CACHE_TTL) {
    console.log(`[MacroContext] VIX cached: ${cachedVix} (age ${((Date.now()-cachedTimestamp)/60000).toFixed(0)}m)`);
    return cachedVix;
  }

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d';
    const cmd = `curl -s -L -H 'User-Agent: Mozilla/5.0' '${url}'`;
    const raw  = execSync(cmd, { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(raw);
    const vix  = data?.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (vix && vix > 0) {
      // Keep single-delta prev for backward compat
      const prev = db.getSetting('vixPrice');
      if (prev) db.setSetting('vixPricePrev', prev);

      // Maintain rolling 3-reading history (~1h apart) for slope-based trend
      const vixHistory = db.getSetting('vixHistory') || [];
      vixHistory.push({ value: vix, timestamp: Date.now() });
      if (vixHistory.length > 3) vixHistory.shift();
      db.setSetting('vixHistory', vixHistory);

      db.setSetting('vixPrice', vix);
      db.setSetting('vixTimestamp', Date.now());
      console.log(`[MacroContext] ✅ Live VIX: ${vix} (history: ${vixHistory.map(h => h.value.toFixed(1)).join('→')})`);
      return vix;
    }
  } catch (err) {
    console.warn('[MacroContext] VIX fetch failed (using fallback):', err.message);
  }

  // Fallback: use last cached value if any, otherwise neutral 15.5
  const fallback = cachedVix || 15.5;
  console.warn(`[MacroContext] VIX fallback: ${fallback}`);
  return fallback;
}

// ============================================================================
// VIX TERM STRUCTURE (VIX3M ratio)
// ============================================================================

/**
 * Fetch 3-month VIX (^VIX3M) from Yahoo Finance. Cached 1 hour.
 * VIX/VIX3M > 1 = BACKWARDATION (near-term fear > long-term → genuine risk-off)
 * VIX/VIX3M < 1 = CONTANGO      (markets calm near-term vs longer horizon → complacency)
 * Returns null if fetch fails and no cached value.
 */
function getVIXTermStructure() {
  const VIX3M_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  const cached    = db.getSetting('vix3mPrice');
  const cachedTs  = db.getSetting('vix3mTimestamp');

  if (cached && cachedTs && (Date.now() - cachedTs) < VIX3M_CACHE_TTL) {
    return cached;
  }

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX3M?interval=1d&range=1d';
    const cmd = `curl -s -L -H 'User-Agent: Mozilla/5.0' '${url}'`;
    const raw  = execSync(cmd, { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(raw);
    const vix3m = data?.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (vix3m && vix3m > 0) {
      db.setSetting('vix3mPrice', vix3m);
      db.setSetting('vix3mTimestamp', Date.now());
      console.log(`[MacroContext] ✅ Live VIX3M: ${vix3m}`);
      return vix3m;
    }
  } catch (err) {
    console.warn('[MacroContext] VIX3M fetch failed (non-fatal):', err.message);
  }

  return cached || null;
}

// ============================================================================
// REBALANCING CALENDAR
// ============================================================================

/**
 * Get 3rd Friday of a given month/year
 */
function getThirdFriday(year, month) {
  let day = 1;
  let fridayCount = 0;
  
  while (fridayCount < 3) {
    const date = new Date(year, month, day);
    if (date.getDay() === 5) { // Friday
      fridayCount++;
      if (fridayCount === 3) {
        return date;
      }
    }
    day++;
  }
  return null;
}

/**
 * Get last business day of month
 */
function getLastBusinessDay(year, month) {
  const lastDay = new Date(year, month + 1, 0);
  let day = lastDay.getDate();
  
  while (day > 0) {
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay();
    
    // Not weekend
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      return date;
    }
    day--;
  }
  return lastDay;
}

/**
 * Generate rebalancing calendar for current year
 */
function generateRebalancingCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  
  const events = [];
  
  // Russell Reconstitution (June 27 - fixed date, moving to semi-annual in 2026)
  events.push({
    name: 'Russell Reconstitution',
    date: new Date(year, 5, 27), // June 27
    intensity: 100,
    type: 'REBALANCING',
    description: '~$10T benchmarked to Russell indices - highest volume day of year'
  });
  
  // S&P 500 Quarterly Rebalancing (3rd Friday of Mar, Jun, Sep, Dec)
  const spMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec
  spMonths.forEach(month => {
    const monthNames = ['Mar', 'Jun', 'Sep', 'Dec'];
    events.push({
      name: `S&P 500 Q${Math.floor(month/3) + 1} Rebalance`,
      date: getThirdFriday(year, month),
      intensity: 60,
      type: 'REBALANCING',
      description: `~$13T benchmarked to S&P 500 - quarterly reconstitution`
    });
  });
  
  // MSCI Rebalancing (last business day of Feb, May, Aug, Nov)
  const msciMonths = [1, 4, 7, 10]; // Feb, May, Aug, Nov
  msciMonths.forEach(month => {
    events.push({
      name: `MSCI Q${Math.floor(month/3) + 1} Rebalance`,
      date: getLastBusinessDay(year, month),
      intensity: 40,
      type: 'REBALANCING',
      description: 'MSCI index quarterly rebalancing'
    });
  });
  
  // Triple Witching (Options/Futures expiration - 3rd Friday of Mar, Jun, Sep, Dec)
  spMonths.forEach(month => {
    events.push({
      name: `Triple Witching Q${Math.floor(month/3) + 1}`,
      date: getThirdFriday(year, month),
      intensity: 80,
      type: 'OPTIONS_EXPIRATION',
      description: 'Options and futures expiration - dealer re-hedging'
    });
  });
  
  // Monthly Options Expiration (3rd Friday every month)
  for (let month = 0; month < 12; month++) {
    // Skip months already covered by triple witching
    if (!spMonths.includes(month)) {
      events.push({
        name: 'Monthly OpEx',
        date: getThirdFriday(year, month),
        intensity: 30,
        type: 'OPTIONS_EXPIRATION',
        description: 'Monthly options expiration'
      });
    }
  }
  
  return events.sort((a, b) => a.date - b.date);
}

// ============================================================================
// PASSIVE FLOW PRESSURE
// ============================================================================

/**
 * Calculate passive flow pressure from rebalancing calendar
 * Theory: Chinco & Sammon (2022) - flows concentrated 5 days before rebalancing
 */
function calculatePassiveFlowPressure() {
  const now = new Date();
  const calendar = generateRebalancingCalendar();
  
  const pressure = {
    level: 0,        // 0-100 scale
    direction: null, // 'BUY' | 'SELL' | 'NEUTRAL'
    source: null,
    daysUntil: null,
    hoursUntil: null,
    reasoning: ''
  };
  
  // Find nearest upcoming event
  const upcomingEvents = calendar.filter(e => e.date >= now);
  
  if (upcomingEvents.length === 0) return pressure;
  
  const nearestEvent = upcomingEvents[0];
  const msUntil = nearestEvent.date - now;
  const hoursUntil = msUntil / (1000 * 60 * 60);
  const daysUntil = hoursUntil / 24;
  
  pressure.hoursUntil = hoursUntil;
  pressure.daysUntil = daysUntil;
  pressure.source = nearestEvent.name;
  
  // Pressure ramps up starting 5 days before
  if (hoursUntil <= 24) {
    // Day of event - PEAK pressure
    pressure.level = nearestEvent.intensity;
    pressure.reasoning = `${nearestEvent.name} TODAY - peak passive flow pressure`;
    
    // Direction based on session trend
    // Passive funds follow the trend (buy on up days, sell on down)
    // We'll set this from market data in main flow
    pressure.direction = 'PENDING'; // Caller will set based on trend
    
  } else if (hoursUntil <= 120) { // 5 days
    // Pre-positioning phase
    const rampFactor = 1 - (hoursUntil / 120); // 0 at 5 days, 1 at event
    pressure.level = Math.floor(nearestEvent.intensity * rampFactor);
    pressure.reasoning = `${nearestEvent.name} in ${daysUntil.toFixed(1)} days - pre-positioning phase`;
    pressure.direction = 'MIXED'; // Both buying and selling as funds position
    
  } else {
    // More than 5 days away
    pressure.level = 0;
    pressure.reasoning = `Next event: ${nearestEvent.name} in ${daysUntil.toFixed(1)} days`;
  }
  
  return pressure;
}

// ============================================================================
// INTRADAY PASSIVE TIMING
// ============================================================================

/**
 * Detect passive flow timing based on time of day
 * Theory: Ben-David et al. (2018) - ETF creation/redemption at market close
 */
function detectIntradayPassiveTiming() {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // Convert to ET (Eastern Time) — UTC-4 during EDT (Mar–Nov), UTC-5 during EST
  const isDST = now.getMonth() >= 2 && now.getMonth() <= 10; // approx Mar–Nov
  const etOffset = isDST ? 4 : 5;
  let estHour = hour - etOffset;
  if (estHour < 0) estHour += 24;
  
  const timing = {
    isPassiveHour: false,
    flowType: null,
    intensity: 0,
    reasoning: '',
    timeUntilPeak: null // minutes until peak passive flow
  };
  
  // Market hours: 9:30am - 4:00pm EST
  const dayOfWeek = now.getUTCDay();
  
  // Not a trading day
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    timing.reasoning = 'Market closed (weekend)';
    return timing;
  }
  
  // Before market open
  if (estHour < 9 || (estHour === 9 && minute < 30)) {
    timing.reasoning = 'Pre-market - passive flows pending';
    const minutesUntilOpen = (9 - estHour) * 60 + (30 - minute);
    timing.timeUntilPeak = minutesUntilOpen;
    return timing;
  }
  
  // After market close
  if (estHour >= 16) {
    timing.reasoning = 'After hours - passive flows complete';
    return timing;
  }
  
  // === DURING MARKET HOURS ===
  
  // 9:30-10:00am: Opening Auction
  if (estHour === 9 && minute >= 30) {
    timing.isPassiveHour = true;
    timing.flowType = 'OPENING_AUCTION';
    timing.intensity = 70;
    timing.reasoning = 'Opening auction - overnight passive orders execute, ETF APs begin hedging';
    timing.timeUntilPeak = 0; // Peak is now
  }
  
  // 11:00am-12:00pm: Midday Rebalancing
  else if (estHour === 11) {
    timing.isPassiveHour = true;
    timing.flowType = 'MIDDAY_REBALANCE';
    timing.intensity = 40;
    timing.reasoning = 'Midday window - some passive funds rebalance to avoid close concentration';
    timing.timeUntilPeak = 0;
  }
  
  // 3:00-3:50pm: Pre-Close Positioning
  else if (estHour === 15 && minute < 50) {
    timing.isPassiveHour = true;
    timing.flowType = 'PRE_CLOSE';
    timing.intensity = 60;
    timing.reasoning = 'Pre-close positioning - passive funds preparing for closing cross';
    timing.timeUntilPeak = 50 - minute; // Minutes until 3:50pm
  }
  
  // 3:50-4:00pm: CLOSING CROSS (PEAK)
  else if (estHour === 15 && minute >= 50) {
    timing.isPassiveHour = true;
    timing.flowType = 'CLOSING_CROSS';
    timing.intensity = 150; // MAXIMUM
    timing.reasoning = '⚠️ CLOSING CROSS - Peak passive flow window! ETF creation/redemption baskets exchanged';
    timing.timeUntilPeak = 0; // Peak is NOW
  }
  
  // 2:00-3:00pm: Approaching Close
  else if (estHour === 14 || (estHour === 15 && minute < 0)) {
    timing.isPassiveHour = false;
    timing.flowType = 'APPROACHING_CLOSE';
    timing.intensity = 30;
    timing.reasoning = 'Approaching close - passive flow pressure building';
    const minutesUntilClose = (15 - estHour) * 60 + (50 - minute);
    timing.timeUntilPeak = minutesUntilClose;
  }
  
  // Normal trading hours
  else {
    timing.isPassiveHour = false;
    timing.flowType = 'NORMAL_HOURS';
    timing.intensity = 10;
    timing.reasoning = 'Normal hours - minimal passive flow pressure';
    
    // Calculate minutes until closing cross (3:50pm)
    const minutesUntilClose = (15 - estHour) * 60 + (50 - minute);
    timing.timeUntilPeak = minutesUntilClose;
  }
  
  return timing;
}

// ============================================================================
// LEVERAGED ETF REBALANCING
// ============================================================================

/**
 * Calculate expected leveraged ETF rebalancing pressure
 * Theory: Fed Reserve (2018) - LETFs mechanically rebalance daily
 * 
 * Formula: If market moves X%, 3x Bull ETF must trade ~2X% of AUM to restore leverage
 */
function calculateLeveragedETFPressure(bars5m) {
  if (!bars5m || bars5m.length < 2) {
    return {
      direction: null,
      intensity: 0,
      reasoning: 'Insufficient data'
    };
  }
  
  // Find session start (9:30am bar)
  const sessionStart = findSessionStart(bars5m);
  const currentBar = bars5m[0];
  
  if (!sessionStart) {
    return {
      direction: null,
      intensity: 0,
      reasoning: 'Session start not found'
    };
  }
  
  const sessionMove = (currentBar.close - sessionStart.open) / sessionStart.open;
  const sessionMovePercent = sessionMove * 100;
  
  const pressure = {
    direction: null,
    intensity: 0,
    sessionMove: sessionMovePercent,
    reasoning: ''
  };
  
  // Only significant if |move| > 1%
  if (Math.abs(sessionMovePercent) < 1.0) {
    pressure.reasoning = `Session move ${sessionMovePercent.toFixed(2)}% too small for LETF impact`;
    return pressure;
  }
  
  // Leveraged ETFs MUST rebalance to maintain leverage ratio
  // Example: Market up 2%, 3x Bull ETF is now 3.06x levered → must BUY to get back to 3x
  //          Market down 2%, 3x Bull ETF is now 2.94x levered → must SELL to get back to 3x
  
  if (sessionMovePercent > 0) {
    // UP DAY
    // - 3x Bull ETFs (SPXL, TQQQ, UPRO) must BUY to restore leverage
    // - 3x Bear ETFs (SPXS, SQQQ, SPXU) must BUY to cover short exposure
    // → NET BUYING PRESSURE
    
    pressure.direction = 'BUY';
    pressure.intensity = Math.min(Math.abs(sessionMovePercent) * 25, 100); // Scale: 4% move = 100 intensity
    pressure.reasoning = `Session +${sessionMovePercent.toFixed(2)}% → Leveraged ETFs must BUY to restore 3x exposure (bull ETFs adding, bear ETFs covering)`;
    
  } else {
    // DOWN DAY
    // - 3x Bull ETFs must SELL to reduce leverage
    // - 3x Bear ETFs must SELL to add short exposure
    // → NET SELLING PRESSURE
    
    pressure.direction = 'SELL';
    pressure.intensity = Math.min(Math.abs(sessionMovePercent) * 25, 100);
    pressure.reasoning = `Session ${sessionMovePercent.toFixed(2)}% → Leveraged ETFs must SELL to restore 3x exposure (bull ETFs reducing, bear ETFs adding)`;
  }
  
  return pressure;
}

/**
 * Find session start bar (9:30am EST)
 */
function findSessionStart(bars5m) {
  // Bars are in reverse chronological order (newest first)
  // Session start is the bar with time closest to 9:30am EST
  
  for (let i = bars5m.length - 1; i >= 0; i--) {
    const bar = bars5m[i];
    const barTime = new Date(bar.time);
    const hour = barTime.getUTCHours() - 5; // Convert to EST
    const minute = barTime.getUTCMinutes();
    
    // 9:30am bar
    if (hour === 9 && minute === 30) {
      return bar;
    }
  }
  
  // If not found, use oldest bar in dataset
  return bars5m[bars5m.length - 1];
}

// ============================================================================
// MACRO REGIME DETECTION
// ============================================================================

/**
 * Detect if market is passive-dominated or active-dominated
 * Theory: Jiang-Vayanos-Zheng (2025) - passive flows dominant in calm, trending markets
 */
function detectMacroRegime(macroData, betaDivergence, flowPressure) {
  const regime = {
    type: null,      // 'PASSIVE_DOMINATED' | 'ACTIVE_DOMINATED' | 'MIXED'
    confidence: 0,   // -100 to +100 (negative = active, positive = passive)
    drivers: []
  };
  
  // === PASSIVE-DOMINATED INDICATORS ===
  
  // 1. Low VIX (< 16) - calm markets favor passive flows
  if (macroData.vix && macroData.vix < 16) {
    regime.confidence += 20;
    regime.drivers.push(`Low VIX (${macroData.vix}) favors passive flows`);
  }
  
  // 2. Very low VIX (< 13) - extreme complacency
  if (macroData.vix && macroData.vix < 13) {
    regime.confidence += 10;
    regime.drivers.push(`Extremely low VIX - passive inflows accelerating`);
  }
  
  // 3. Major rebalancing event approaching (within 5 days)
  if (flowPressure.level > 50) {
    regime.confidence += 30;
    regime.drivers.push(`${flowPressure.source} approaching - passive flows dominate`);
  }
  
  // 4. Low/falling interest rates - passive equity inflows
  if (macroData.fedFundsRate && macroData.fedFundsRate < 4.0) {
    regime.confidence += 15;
    regime.drivers.push(`Low rates (${macroData.fedFundsRate}%) favor equity passive inflows`);
  }
  
  if (macroData.fedFundsTrend === 'CUTTING') {
    regime.confidence += 10;
    regime.drivers.push('Fed cutting rates - passive allocation shift to equities');
  }
  
  // 5. Small beta divergence - market moving together
  if (betaDivergence && betaDivergence['12bar']) {
    const divergence = Math.abs(parseFloat(betaDivergence['12bar'].divergence));
    if (divergence < 0.2) {
      regime.confidence += 15;
      regime.drivers.push('Low sector divergence - broad passive flows dominating');
    }
  }
  
  // === ACTIVE-DOMINATED INDICATORS ===
  
  // 1. High VIX (> 20) - volatility sparks active trading
  if (macroData.vix && macroData.vix > 20) {
    regime.confidence -= 30;
    regime.drivers.push(`High VIX (${macroData.vix}) - active managers seeking alpha`);
  }
  
  // 2. Extreme VIX (> 25) - fear/panic
  if (macroData.vix && macroData.vix > 25) {
    regime.confidence -= 20;
    regime.drivers.push('VIX spike - active risk management dominant');
  }
  
  // 3. High-impact macro event pending
  if (macroData.todaysEvents && macroData.todaysEvents.some(e => e.impact === 'HIGH')) {
    regime.confidence -= 25;
    regime.drivers.push('High-impact event pending - active positioning dominant');
  }
  
  // 4. Large beta divergence - stock picking environment
  if (betaDivergence && betaDivergence['12bar']) {
    const divergence = Math.abs(parseFloat(betaDivergence['12bar'].divergence));
    if (divergence > 0.5) {
      regime.confidence -= 20;
      regime.drivers.push('High sector rotation - active stock picking');
    }
  }
  
  // 5. Inverted yield curve - recession fears
  if (macroData.yieldCurve === 'INVERTED') {
    regime.confidence -= 15;
    regime.drivers.push('Inverted yield curve - active defensive positioning');
  }
  
  // 6. Rising VIX trend
  if (macroData.vixTrend === 'RISING') {
    regime.confidence -= 15;
    regime.drivers.push('VIX rising - active traders dominating');
  }
  
  // === DETERMINE REGIME TYPE ===
  
  if (regime.confidence > 40) {
    regime.type = 'PASSIVE_DOMINATED';
  } else if (regime.confidence < -20) {
    regime.type = 'ACTIVE_DOMINATED';
  } else {
    regime.type = 'MIXED';
  }
  
  return regime;
}

// ============================================================================
// FLOW IMPACT MODEL
// ============================================================================

/**
 * Estimate expected price impact from passive flows
 * Theory: Jiang-Vayanos-Zheng (2025) - passive flows create idiosyncratic volatility
 * 
 * Simplified model: Impact ∝ (Flow Intensity / Liquidity) × Volatility
 */
function estimateFlowImpact(bars5m, flowPressure, intradayTiming) {
  const impact = {
    expectedMove: 0,      // Points
    confidence: 0,        // 0-100
    timeframe: null,
    reasoning: ''
  };
  
  // Only estimate if significant flow pressure
  if (flowPressure.level < 30 && intradayTiming.intensity < 50) {
    impact.reasoning = 'Insufficient flow pressure to estimate impact';
    return impact;
  }
  
  // Calculate recent volatility (standard deviation of 5m returns)
  const volatility = calculateVolatility(bars5m, 12); // 1 hour
  
  // Combine flow sources
  const totalFlowIntensity = Math.max(flowPressure.level, intradayTiming.intensity);
  
  // Base impact formula (simplified from academic research)
  // Real formula would include: order imbalance, liquidity depth, time-to-rebalance
  // Our approximation: (flow_intensity / 100) × volatility × 0.15
  
  const baseImpact = (totalFlowIntensity / 100) * volatility * 0.15;
  
  // Direction
  let direction = 1; // Default buy
  if (flowPressure.direction === 'SELL') {
    direction = -1;
  } else if (flowPressure.direction === 'NEUTRAL' || flowPressure.direction === 'MIXED') {
    direction = 0; // No directional impact
  }
  
  impact.expectedMove = baseImpact * direction;
  impact.confidence = Math.min(totalFlowIntensity, 75);
  
  // Timeframe based on source
  if (intradayTiming.flowType === 'CLOSING_CROSS') {
    impact.timeframe = 'NEXT_10_MINUTES';
    impact.reasoning = `${intradayTiming.intensity}% passive flow at closing cross → expected ${impact.expectedMove > 0 ? '+' : ''}${impact.expectedMove.toFixed(2)} point impact`;
  } else if (flowPressure.level > 50 && flowPressure.daysUntil < 1) {
    impact.timeframe = 'TODAY';
    impact.reasoning = `${flowPressure.source} today → expected ${impact.expectedMove > 0 ? '+' : ''}${impact.expectedMove.toFixed(2)} point cumulative impact`;
  } else if (flowPressure.level > 30 && flowPressure.daysUntil < 5) {
    impact.timeframe = 'NEXT_5_DAYS';
    impact.reasoning = `${flowPressure.source} in ${flowPressure.daysUntil.toFixed(1)} days → pre-positioning impact ${impact.expectedMove > 0 ? '+' : ''}${impact.expectedMove.toFixed(2)} points`;
  }
  
  return impact;
}

/**
 * Calculate volatility (standard deviation of returns)
 */
function calculateVolatility(bars, periods) {
  if (!bars || bars.length < periods + 1) {
    return 0;
  }
  
  const returns = [];
  for (let i = 0; i < periods; i++) {
    const ret = (bars[i].close - bars[i + 1].close) / bars[i + 1].close;
    returns.push(ret);
  }
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  // Convert to points (approximate)
  const currentPrice = bars[0].close;
  return stdDev * currentPrice;
}

// ============================================================================
// MAIN MACRO CONTEXT FUNCTION
// ============================================================================

/**
 * Get complete macro context
 * This is called by automation-system.js every 10 seconds
 */
async function getMacroContext(bars5m, bars15m, dailySummary) {
  console.log('[MacroContext] Computing macro context...');

  // Live VIX from Yahoo Finance (1-hour cache)
  const liveVix = getLiveVIX();

  // Rolling slope trend: uses up to 3 cached readings (~1h apart).
  // More reliable than a single-delta comparison — smooths momentary VIX spikes.
  let vixTrend;
  const vixHistory = db.getSetting('vixHistory') || [];
  if (vixHistory.length >= 2) {
    const n = vixHistory.length;
    // Simple first→last slope normalised by span (each reading ~1h apart)
    const slope = (vixHistory[n - 1].value - vixHistory[0].value) / Math.max(n - 1, 1);
    vixTrend = slope > 0.3 ? 'RISING' : slope < -0.3 ? 'FALLING' : 'HOLDING';
    console.log(`[MacroContext] VIX slope: ${slope.toFixed(2)}/reading (${vixHistory.map(h => h.value.toFixed(1)).join('→')}) → ${vixTrend}`);
  } else {
    // Only one reading — fall back to single-point delta
    const prevVix = db.getSetting('vixPricePrev') || liveVix;
    const vixDelta = liveVix - prevVix;
    vixTrend = vixDelta > 0.5 ? 'RISING' : vixDelta < -0.5 ? 'FALLING' : 'HOLDING';
  }

  // VIX term structure: VIX / VIX3M ratio classifies fear vs complacency
  const vix3m = getVIXTermStructure();
  const vixStructure = (vix3m && vix3m > 0)
    ? (liveVix > vix3m * 1.02 ? 'BACKWARDATION' : liveVix < vix3m * 0.98 ? 'CONTANGO' : 'FLAT')
    : 'UNKNOWN';

  const macroData = {
    vix:          liveVix,
    vix3m,
    vixTrend,
    vixStructure,
    fedFundsRate: 4.50,
    fedFundsTrend: 'HOLDING',
    treasury10yr: 4.25,
    yieldCurve:   'NORMAL',
    todaysEvents: []
  };

  // ── Step 1: Passive flow pressure from rebalancing calendar ─────────────────
  // Calendar-aware: Russell, S&P 500 quarterly, MSCI, triple witching, monthly OpEx
  const flowPressure = calculatePassiveFlowPressure();

  // ── Step 2: Intraday passive timing (ETF creation/redemption windows) ────────
  const intradayTiming = detectIntradayPassiveTiming();

  // ── Step 3: LETF daily rebalancing pressure (session-move based) ─────────────
  const letfPressure = (bars5m && bars5m.length > 1)
    ? calculateLeveragedETFPressure(bars5m)
    : { direction: null, intensity: 0, reasoning: 'No bars for LETF calculation' };

  // ── Step 4: Regime detection ─────────────────────────────────────────────────
  // If a Claude daily summary exists, override with its keyword-parsed regime.
  // Otherwise use detectMacroRegime() with the live calendar signals.
  let regime;

  if (dailySummary && typeof dailySummary === 'string') {
    console.log('[MacroContext] ✅ Using daily summary for regime override');
    const upper = dailySummary.toUpperCase();
    if (upper.includes('PASSIVE-DOMINATED') || upper.includes('PASSIVE DOMINATED')) {
      regime = { type: 'PASSIVE_DOMINATED', confidence: 75, drivers: ['Daily summary: PASSIVE'] };
    } else if (upper.includes('ACTIVE-DOMINATED') || upper.includes('ACTIVE DOMINATED')) {
      regime = { type: 'ACTIVE_DOMINATED',  confidence: 75, drivers: ['Daily summary: ACTIVE'] };
    } else {
      // Summary exists but regime ambiguous — still run detectMacroRegime for calendar signals
      regime = detectMacroRegime(macroData, null, flowPressure);
    }
  } else {
    // No summary — use full calendar + macro regime detection
    regime = detectMacroRegime(macroData, null, flowPressure);
  }

  // Attach supplementary flow data to regime for display and scoring
  regime.flowPressure        = flowPressure.level;   // alias kept for automation.js log compat
  regime.flowPressureLevel   = flowPressure.level;
  regime.flowPressureSource  = flowPressure.source || null;
  regime.intradayIntensity   = intradayTiming.intensity;
  regime.intradayFlowType    = intradayTiming.flowType || 'NORMAL_HOURS';
  regime.letfPressure        = letfPressure.direction || 'NEUTRAL';
  regime.letfIntensity       = letfPressure.intensity;

  console.log('[MacroContext] ✅ Macro context computed:', {
    regime:        regime.type,
    confidence:    regime.confidence,
    flowPressure:  flowPressure.level,
    flowSource:    flowPressure.source || 'none',
    intraday:      intradayTiming.flowType || 'NORMAL_HOURS',
    letf:          letfPressure.direction || 'NEUTRAL',
    letfIntensity: letfPressure.intensity
  });

  // ── COT dealer positioning (7-day cache, non-blocking) ──────────────────────
  let cotSignal = { net: 0, signal: 'DEALERS_NEUTRAL', percentile: 0.5, reportDate: 'N/A' };
  try {
    cotSignal = await CotData.getDealerNetPosition();
  } catch (err) {
    console.warn('[MacroContext] COT fetch error (non-fatal):', err.message);
  }

  return {
    regime,
    macroData,
    cotSignal,
    flowPressure,
    intradayTiming,
    letfPressure
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

// Make functions available globally
module.exports = {
  getMacroContext,
  getLiveVIX,
  getVIXTermStructure,
  calculatePassiveFlowPressure,
  detectIntradayPassiveTiming,
  calculateLeveragedETFPressure,
  detectMacroRegime,
  estimateFlowImpact,
  generateRebalancingCalendar
};

console.log('[MacroContext] ✅ Module loaded successfully');
