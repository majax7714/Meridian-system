// ============================================================================
// FUTURES MECHANICS MODULE v18.0.0
// ES/MES-Specific Price Discovery and Arbitrage
// ============================================================================
// Based on Academic Research:
// - Cost-of-Carry Model (Cornell & French, 1981)
// - Price Discovery (Mizrach & Neely, 2008; Fleming et al., 1996)
// - Inventory Effects (Fishe et al., 2017 - E-mini specific)
// - ETF Arbitrage (Bookmap, 2025)
// - Options Delta Hedging (Bookmap, 2025)
// - Order Flow Imbalance (TRADEPRO Academy, 2025)
// ============================================================================

const { execSync } = require('child_process');
const db = require('../storage/db');

console.log('[FuturesMechanics] Loading futures-mechanics.js v18.0.0...');

// ============================================================================
// LIVE SPX SPOT PRICE
// ============================================================================

/**
 * Fetch live SPX spot price from Yahoo Finance. Cached 5 minutes in DB.
 * Falls back to esPrice approximation if fetch fails.
 * URL: query1.finance.yahoo.com/v8/finance/chart/%5EGSPC
 */
function getLiveSPX() {
  const SPX_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const cachedSpx       = db.getSetting('spxPrice');
  const cachedTimestamp = db.getSetting('spxTimestamp');

  if (cachedSpx && cachedTimestamp && (Date.now() - cachedTimestamp) < SPX_CACHE_TTL) {
    return cachedSpx;
  }

  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d';
    const cmd = `curl -s -L -H 'User-Agent: Mozilla/5.0' '${url}'`;
    const raw  = execSync(cmd, { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(raw);
    const spx  = data?.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (spx && spx > 0) {
      db.setSetting('spxPrice', spx);
      db.setSetting('spxTimestamp', Date.now());
      console.log(`[FuturesMechanics] ✅ Live SPX: ${spx}`);
      return spx;
    }
  } catch (err) {
    console.warn('[FuturesMechanics] SPX fetch failed (using fallback):', err.message);
  }

  return cachedSpx || null; // null signals caller to use esPrice fallback
}

// ============================================================================
// CONSTANTS
// ============================================================================

// S&P 500 Index typical values (update quarterly)
const SPX_DIVIDEND_YIELD = 0.013;  // 1.3% annually (approximate)
const FUTURES_TICK_SIZE = 0.25;    // ES/MES minimum tick
const ES_MULTIPLIER = 50;          // $50 per point
const MES_MULTIPLIER = 5;          // $5 per point

// Arbitrage bounds (ES-specific, from academic research)
const BASIS_LOWER_BOUND = -2.0;    // Points below fair value
const BASIS_UPPER_BOUND = 2.0;     // Points above fair value

// Order flow thresholds (ES-specific, from TRADEPRO Academy)
const DELTA_LARGE_IMBALANCE = 5000;  // Volume-weighted approximation

// 2026 Rollover Schedule (CME)
const ROLLOVER_DATES_2026 = [
  new Date(2025, 11, 15), // Dec 15, 2025 → March 2026 contract
  new Date(2026, 2, 16),  // Mar 16, 2026 → June 2026 contract
  new Date(2026, 5, 15),  // Jun 15, 2026 → September 2026 contract
  new Date(2026, 8, 14),  // Sep 14, 2026 → December 2026 contract
  new Date(2026, 11, 14)  // Dec 14, 2026 → March 2027 contract
];

// ============================================================================
// FUTURES BASIS (Cost-of-Carry Model)
// ============================================================================

/**
 * Calculate futures basis using cost-of-carry model
 * Theory: Cornell & French (1981)
 * 
 * Formula: Fair Value = Spot × e^((r - d) × t)
 * Where:
 *   r = risk-free rate
 *   d = dividend yield
 *   t = time to expiration (years)
 */
function calculateFuturesBasis(esPrice, spxPrice, daysToExpiration, riskFreeRate) {
  const yearFraction = daysToExpiration / 365;
  
  // Fair value (theoretical futures price)
  const fairValue = spxPrice * Math.exp((riskFreeRate - SPX_DIVIDEND_YIELD) * yearFraction);
  
  // Actual basis (futures premium/discount to fair value)
  const actualBasis = esPrice - fairValue;
  
  const analysis = {
    fairValue: fairValue.toFixed(2),
    actualBasis: actualBasis.toFixed(2),
    isWithinBounds: actualBasis > BASIS_LOWER_BOUND && actualBasis < BASIS_UPPER_BOUND,
    signal: null,
    reasoning: ''
  };
  
  // Arbitrage signals
  if (actualBasis > BASIS_UPPER_BOUND) {
    // Futures overpriced relative to fair value
    analysis.signal = 'FUTURES_RICH';
    analysis.reasoning = `Basis +${actualBasis.toFixed(2)} points above fair value → Futures overpriced, expect selling pressure from arbitrageurs`;
  } else if (actualBasis < BASIS_LOWER_BOUND) {
    // Futures underpriced relative to fair value
    analysis.signal = 'FUTURES_CHEAP';
    analysis.reasoning = `Basis ${actualBasis.toFixed(2)} points below fair value → Futures underpriced, expect buying pressure from arbitrageurs`;
  } else {
    analysis.signal = 'FAIR_VALUE';
    analysis.reasoning = `Basis ${actualBasis.toFixed(2)} points within arbitrage bounds (${BASIS_LOWER_BOUND} to ${BASIS_UPPER_BOUND})`;
  }
  
  return analysis;
}

// ============================================================================
// ROLLOVER PRESSURE
// ============================================================================

/**
 * Detect futures contract rollover pressure
 * Theory: Predictable volume shift creates price pressure
 */
function detectRolloverPressure() {
  const now = new Date();
  
  // Find next rollover date
  const nextRollover = ROLLOVER_DATES_2026.find(d => d > now);
  
  if (!nextRollover) {
    return {
      level: 0,
      daysUntil: null,
      reasoning: 'No upcoming rollover in calendar'
    };
  }
  
  const msUntil = nextRollover - now;
  const daysUntil = msUntil / (1000 * 60 * 60 * 24);
  
  const pressure = {
    level: 0,
    daysUntil: daysUntil.toFixed(1),
    reasoning: ''
  };
  
  // Pressure ramps up 3 days before
  if (daysUntil <= 1) {
    // ROLLOVER DAY
    pressure.level = 100;
    pressure.reasoning = `🚨 ROLLOVER DAY - Avoid trading! Massive volume shift to new contract creates unpredictable price action`;
  } else if (daysUntil <= 3) {
    // 1-3 days before
    const rampFactor = 1 - (daysUntil / 3);
    pressure.level = Math.floor(rampFactor * 80);
    pressure.reasoning = `Rollover in ${daysUntil.toFixed(1)} days - ${pressure.level}% of volume shifting to new contract`;
  } else if (daysUntil <= 7) {
    // 3-7 days before
    pressure.level = 30;
    pressure.reasoning = `Rollover in ${daysUntil.toFixed(1)} days - early positioning beginning`;
  } else {
    pressure.level = 0;
    pressure.reasoning = `Next rollover in ${daysUntil.toFixed(0)} days`;
  }
  
  return pressure;
}

// ============================================================================
// ETF AUCTION FLOW
// ============================================================================

/**
 * Detect ETF market-on-close auction flow window
 * Theory: SPY MOC orders force ES dealer hedging (Bookmap, 2025)
 */
function detectETFAuctionFlow() {
  const now = new Date();
  const hour = now.getUTCHours() - 5; // Convert to EST
  const minute = now.getUTCMinutes();
  
  const flow = {
    isAuctionWindow: false,
    intensity: 0,
    expectedDirection: null,
    reasoning: ''
  };
  
  // Check if market is open
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    flow.reasoning = 'Weekend - no ETF auction';
    return flow;
  }
  
  // 3:55-4:00pm EST = PEAK MOC WINDOW
  if (hour === 15 && minute >= 55) {
    flow.isAuctionWindow = true;
    flow.intensity = 150; // MAXIMUM
    flow.reasoning = '🚨 MOC AUCTION WINDOW - SPY closing imbalances forcing ES dealer hedging (last 5 minutes most volatile)';
    flow.expectedDirection = 'PENDING'; // Caller will set based on session trend
  }
  
  // 3:50-3:55pm = Pre-auction positioning
  else if (hour === 15 && minute >= 50 && minute < 55) {
    flow.isAuctionWindow = true;
    flow.intensity = 80;
    flow.reasoning = 'Pre-auction window - dealers positioning for MOC flows';
  }
  
  // 3:45-3:50pm = Approaching auction
  else if (hour === 15 && minute >= 45 && minute < 50) {
    flow.isAuctionWindow = false;
    flow.intensity = 40;
    flow.reasoning = 'Approaching MOC auction - building pressure';
  }
  
  return flow;
}

// ============================================================================
// 0DTE OPTIONS GAMMA PRESSURE
// ============================================================================

/**
 * Detect 0DTE (same-day expiration) options gamma pressure
 * Theory: Dealers delta-hedge options → intraday ES volatility (Bookmap, 2025)
 */
function detect0DTEGammaPressure() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours() - 5; // EST
  
  const pressure = {
    is0DTEDay: false,
    intensity: 0,
    peakWindow: false,
    reasoning: ''
  };
  
  // 0DTE only on trading days
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    pressure.reasoning = 'Weekend - no 0DTE options';
    return pressure;
  }
  
  pressure.is0DTEDay = true;
  
  // Wednesday and Friday = highest 0DTE volume
  if (dayOfWeek === 3) {
    pressure.intensity = 80;
    pressure.reasoning = 'Wednesday 0DTE - High gamma hedging activity throughout session';
  } else if (dayOfWeek === 5) {
    pressure.intensity = 90;
    pressure.reasoning = 'Friday 0DTE - PEAK gamma hedging activity (end-of-week positioning)';
  } else {
    pressure.intensity = 50;
    pressure.reasoning = '0DTE expiration today - Moderate gamma hedging';
  }
  
  // Last hour before close = peak dealer hedging
  if (hour === 15) {
    pressure.peakWindow = true;
    pressure.intensity += 20;
    pressure.reasoning += ' (PEAK HOUR - dealers frantically adjusting hedges before expiration)';
  }
  
  return pressure;
}

// ============================================================================
// ORDER FLOW DELTA IMBALANCE
// ============================================================================

/**
 * Calculate cumulative delta from bars (approximation)
 * Theory: Large imbalances predict direction (TRADEPRO Academy, 2025)
 * 
 * Note: Real delta = bid volume - ask volume at each level
 * Our approximation: (close - open) × volume
 */
function calculateCumulativeDelta(bars5m, periods = 12) {
  if (!bars5m || bars5m.length < periods) {
    return {
      cumulativeDelta: 0,
      signal: null,
      reasoning: 'Insufficient data for delta calculation'
    };
  }
  
  let cumulativeDelta = 0;
  
  // Accumulate delta over lookback period
  for (let i = 0; i < periods; i++) {
    const bar = bars5m[i];
    
    // Positive bar (close > open) = buying pressure
    // Negative bar (close < open) = selling pressure
    const barDelta = (bar.close - bar.open) * bar.volume;
    
    cumulativeDelta += barDelta;
  }
  
  const analysis = {
    cumulativeDelta: Math.round(cumulativeDelta),
    signal: null,
    reasoning: ''
  };
  
  // Threshold: ±5000 volume-weighted points
  // (Approximates ±800 real delta for ES)
  if (cumulativeDelta > DELTA_LARGE_IMBALANCE) {
    analysis.signal = 'BULLISH_IMBALANCE';
    analysis.reasoning = `Strong buying pressure (cumulative delta +${(cumulativeDelta / 1000).toFixed(1)}k) - buyers in control, expect continuation`;
  } else if (cumulativeDelta < -DELTA_LARGE_IMBALANCE) {
    analysis.signal = 'BEARISH_IMBALANCE';
    analysis.reasoning = `Strong selling pressure (cumulative delta ${(cumulativeDelta / 1000).toFixed(1)}k) - sellers in control, expect continuation`;
  } else {
    analysis.signal = 'BALANCED';
    analysis.reasoning = `Balanced order flow (cumulative delta ${(cumulativeDelta / 1000).toFixed(1)}k) - no clear directional pressure`;
  }
  
  return analysis;
}

// ============================================================================
// PRICE DISCOVERY ROLE
// ============================================================================

/**
 * Detect if ES is leading or lagging price discovery
 * Theory: Futures should lead spot (Fleming et al., 1996)
 */
function detectPriceDiscoveryRole(bars5m) {
  if (!bars5m || bars5m.length < 3) {
    return {
      role: 'UNKNOWN',
      magnitude: 0,
      reasoning: 'Insufficient data for price discovery analysis'
    };
  }
  
  const latest = bars5m[0];
  const previous = bars5m[1];
  const older = bars5m[2];
  
  // Calculate recent momentum
  const recentMove = latest.close - previous.close;
  const previousMove = previous.close - older.close;
  
  // Acceleration = recent move is larger than previous
  const acceleration = Math.abs(recentMove) / (Math.abs(previousMove) || 1);
  
  if (acceleration > 1.5) {
    // ES accelerating = likely leading
    return {
      role: 'LEADING',
      magnitude: recentMove,
      reasoning: `ES accelerating (${acceleration.toFixed(1)}x previous move) - likely leading spot price discovery, momentum building`
    };
  } else if (acceleration < 0.5) {
    // ES decelerating = possibly lagging
    return {
      role: 'LAGGING',
      magnitude: recentMove,
      reasoning: `ES decelerating (${acceleration.toFixed(1)}x previous move) - may be lagging spot, check for news not yet priced in`
    };
  }
  
  return {
    role: 'INLINE',
    magnitude: recentMove,
    reasoning: `ES moving inline with recent pace (${acceleration.toFixed(1)}x) - following expected price discovery`
  };
}

// ============================================================================
// MAIN FUTURES CONTEXT FUNCTION
// ============================================================================

/**
 * Get complete futures mechanics context
 * Called by automation-system.js every 10 seconds
 */
async function getFuturesContext(bars5m, macroContext) {
  console.log('[FuturesMechanics] Computing futures context...');
  
  if (!bars5m || bars5m.length === 0) {
    console.warn('[FuturesMechanics] No bars provided');
    return null;
  }
  
  // Current ES price
  const esPrice = bars5m[0].close;

  // Live SPX spot (5-minute cache). Falls back to esPrice if fetch fails —
  // fair value formula with spxPrice = esPrice still computes an output,
  // it just always lands near FAIR_VALUE instead of RICH/CHEAP.
  const spxPrice = getLiveSPX() || esPrice;
  if (spxPrice !== esPrice) {
    console.log(`[FuturesMechanics] ES=${esPrice} SPX=${spxPrice} premium=${(esPrice - spxPrice).toFixed(2)}`);
  }
  
  // Days to next quarterly expiration (approximate)
  const now = new Date();
  const nextQuarterlyExpiration = getNextQuarterlyExpiration(now);
  const daysToExpiration = (nextQuarterlyExpiration - now) / (1000 * 60 * 60 * 24);
  
  // Risk-free rate from macro context
  const riskFreeRate = macroContext.macroData && macroContext.macroData.fedFundsRate ? 
    (macroContext.macroData.fedFundsRate / 100) : 0.045;
  
  // 1. Calculate futures basis
  const basis = calculateFuturesBasis(esPrice, spxPrice, daysToExpiration, riskFreeRate);
  
  // 2. Detect rollover pressure
  const rollover = detectRolloverPressure();
  
  // 3. Detect ETF auction flow
  const etfAuctionFlow = detectETFAuctionFlow();
  
  // 4. Detect 0DTE gamma pressure
  const dte0Pressure = detect0DTEGammaPressure();
  
  // 5. Calculate delta imbalance
  const deltaImbalance = calculateCumulativeDelta(bars5m, 12); // 1 hour lookback
  
  // 6. Detect price discovery role
  const priceDiscovery = detectPriceDiscoveryRole(bars5m);
  
  // Assemble complete futures context
  const futuresContext = {
    basis,
    rollover,
    etfAuctionFlow,
    dte0Pressure,
    deltaImbalance,
    priceDiscovery,
    
    // Metadata
    currentPrice: esPrice,
    daysToExpiration: daysToExpiration.toFixed(1),
    computedAt: new Date().toISOString()
  };
  
  console.log('[FuturesMechanics] ✅ Futures context computed:', {
    basisSignal: futuresContext.basis.signal,
    rolloverLevel: futuresContext.rollover.level,
    etfIntensity: futuresContext.etfAuctionFlow.intensity,
    deltaSignal: futuresContext.deltaImbalance.signal
  });
  
  return futuresContext;
}

/**
 * Get next quarterly futures expiration (3rd Friday of Mar/Jun/Sep/Dec)
 */
function getNextQuarterlyExpiration(now) {
  const quarterlyMonths = [2, 5, 8, 11]; // March, June, September, December
  const year = now.getFullYear();
  const currentMonth = now.getMonth();
  
  // Find next quarterly month
  let nextMonth = quarterlyMonths.find(m => m >= currentMonth);
  let nextYear = year;
  
  if (!nextMonth) {
    nextMonth = quarterlyMonths[0]; // March of next year
    nextYear = year + 1;
  }
  
  // Get 3rd Friday of that month
  return getThirdFriday(nextYear, nextMonth);
}

/**
 * Get 3rd Friday of a given month
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
  
  return new Date(year, month, 21); // Fallback to 21st
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  getFuturesContext,
  getLiveSPX,
  calculateFuturesBasis,
  detectRolloverPressure,
  detectETFAuctionFlow,
  detect0DTEGammaPressure,
  calculateCumulativeDelta,
  detectPriceDiscoveryRole
};

console.log('[FuturesMechanics] ✅ Module loaded successfully');
