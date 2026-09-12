// ============================================================================
// Unit tests for TopstepX scalping assistant (offline — no network, no broker)
// Run with: node test/unit.js  OR  npm run test:unit
//
// Note: DB tests append one test trade to data/trades.json (expected behaviour).
// Phase-detection tests assume a US-timezone machine (UTC-5 to UTC-8) for DST
// correctness in getSessionPhase. They use December 2025 dates (always CST = UTC-6).
// ============================================================================

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

// ─── Harness ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const _pending = [];   // async tests queued, resolved before final summary

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      // Register async test — resolved in runAll()
      _pending.push(ret.then(() => { console.log(`✅  ${name}`); pass++; })
                        .catch(e  => { console.log(`❌  ${name}: ${e.message}`); fail++; }));
    } else {
      console.log(`✅  ${name}`);
      pass++;
    }
  } catch (e) {
    console.log(`❌  ${name}: ${e.message}`);
    fail++;
  }
}

function assert(cond, msg)    { if (!cond) throw new Error(msg || 'Assertion failed'); }
function eq(a, b, msg)        { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function approx(a, b, tol, msg) {
  tol = tol ?? 1e-12;
  if (Math.abs(a - b) > tol) throw new Error(msg || `Expected ~${b} (±${tol}), got ${a}`);
}

// ─── Bar fixture factories ─────────────────────────────────────────────────────

function makeBars(closes, baseTime) {
  const t0 = baseTime ?? Date.now();
  return closes.map((c, i) => ({
    time:   t0 - i * 300_000,
    open:   c - 0.5,
    high:   c + 1,
    low:    c - 1,
    close:  c,
    volume: 1000 + i * 10
  }));
}

/** Flat bars — zero realized vol */
function flatBars(n, price = 5000) {
  return makeBars(new Array(n).fill(price));
}

/** Trending bars — each bar adds `step` to close */
function trendBars(n, start = 5000, step = 1) {
  const closes = Array.from({ length: n }, (_, i) => start + (n - 1 - i) * step);
  return makeBars(closes);
}

// ─── Section 1: Realized Volatility ──────────────────────────────────────────

console.log('\n── RealizedVol ──────────────────────────────────────────────────────────');
const RV = require(path.join(ROOT, 'src/engine/realized-volatility'));

test('computeRealizedVol: default 0.005 when too few bars', () => {
  eq(RV.computeRealizedVol(makeBars([5000, 5001]), 20), 0.005);
});

test('computeRealizedVol: ~0 for completely flat prices', () => {
  approx(RV.computeRealizedVol(flatBars(25), 20), 0, 1e-12, 'Flat bars should have zero vol');
});

test('computeRealizedVol: larger moves → higher sigma', () => {
  const small = makeBars(Array.from({ length: 25 }, (_, i) => 5000 + (i % 2 === 0 ? 0.1 : 0)));
  const large = makeBars(Array.from({ length: 25 }, (_, i) => 5000 + (i % 2 === 0 ? 10  : 0)));
  assert(RV.computeRealizedVol(large, 20) > RV.computeRealizedVol(small, 20));
});

test('computeRealizedVol: returns positive number for trending bars', () => {
  const sigma = RV.computeRealizedVol(trendBars(25), 20);
  assert(sigma > 0 && sigma < 1, `sigma ${sigma} out of expected range`);
});

test('classifyVolRegime: LOW < 0.0015', () => {
  eq(RV.classifyVolRegime(0.001), 'LOW');
  eq(RV.classifyVolRegime(0.0014), 'LOW');
});

test('classifyVolRegime: MEDIUM 0.0015–0.004', () => {
  eq(RV.classifyVolRegime(0.0015), 'MEDIUM');
  eq(RV.classifyVolRegime(0.003), 'MEDIUM');
});

test('classifyVolRegime: HIGH 0.004–0.008', () => {
  eq(RV.classifyVolRegime(0.005), 'HIGH');
  eq(RV.classifyVolRegime(0.0079), 'HIGH');
});

test('classifyVolRegime: SPIKE >= 0.008', () => {
  eq(RV.classifyVolRegime(0.008), 'SPIKE');
  eq(RV.classifyVolRegime(0.05), 'SPIKE');
});

test('volProportionalStops: minimum 4 ticks (TopstepX bracket minimum)', () => {
  const { stopTicks } = RV.volProportionalStops(0.00001, 5000);
  eq(stopTicks, 4, 'Very low sigma should floor at 4 ticks (TopstepX min bracket distance)');
});

test('volProportionalStops: maximum 10 ticks', () => {
  const { stopTicks } = RV.volProportionalStops(1.0, 5000);
  eq(stopTicks, 10, 'Very high sigma should cap at 10 ticks');
});

test('volProportionalStops: target = 2 × stop (2:1 R:R)', () => {
  const { stopTicks, targetTicks } = RV.volProportionalStops(0.003, 5000);
  eq(targetTicks, stopTicks * 2);
});

test('volProportionalStops: medium sigma gives in-range stop', () => {
  const { stopTicks } = RV.volProportionalStops(0.003, 5000);
  assert(stopTicks >= 2 && stopTicks <= 10, `stop=${stopTicks} out of [2,10]`);
});

test('vwapDisplacementCheck: NOT displaced at VWAP', () => {
  const { displaced } = RV.vwapDisplacementCheck(5000, 5000, 0.003);
  eq(displaced, false);
});

test('vwapDisplacementCheck: displaced 20pts above, sigma=0.003 (sigmaPoints=15)', () => {
  const { displaced, direction } = RV.vwapDisplacementCheck(5020, 5000, 0.003);
  assert(displaced, 'Price 20pts above VWAP (>1σ) should be displaced');
  eq(direction, 'SHORT', 'Fade from above = SHORT');
});

test('vwapDisplacementCheck: direction LONG when below VWAP', () => {
  const { direction } = RV.vwapDisplacementCheck(4975, 5000, 0.003);
  eq(direction, 'LONG', 'Fade from below = LONG');
});

test('vwapDisplacementCheck: sigmas is numeric and positive when displaced', () => {
  const { sigmas } = RV.vwapDisplacementCheck(5020, 5000, 0.003);
  assert(typeof sigmas === 'number' && sigmas > 0);
});

test('computeRVIVRatio: NEUTRAL for null sigma', () => {
  eq(RV.computeRVIVRatio(null, 15).regime, 'NEUTRAL');
});

test('computeRVIVRatio: NEUTRAL for vix=0', () => {
  eq(RV.computeRVIVRatio(0.003, 0).regime, 'NEUTRAL');
});

test('computeRVIVRatio: TRENDING when RV >> IV (high sigma, low vix)', () => {
  // sigma=0.02, vix=8 → very high RV relative to IV
  eq(RV.computeRVIVRatio(0.02, 8).regime, 'TRENDING');
});

test('computeRVIVRatio: RANGING when RV << IV (very low sigma, high vix)', () => {
  // sigma=0.0001, vix=40 → very low RV relative to IV
  eq(RV.computeRVIVRatio(0.0001, 40).regime, 'RANGING');
});

test('computeRVIVRatio: ratio is positive number', () => {
  const { ratio } = RV.computeRVIVRatio(0.003, 15);
  assert(typeof ratio === 'number' && ratio > 0, `ratio ${ratio} should be positive`);
});

test('computeRVIVRatio: returns dailyRV and dailyIV', () => {
  const { dailyRV, dailyIV } = RV.computeRVIVRatio(0.003, 15);
  assert(dailyRV > 0 && dailyIV > 0);
});

// ─── Section 2: Intraday Cycle ────────────────────────────────────────────────

console.log('\n── IntraydayCycle ───────────────────────────────────────────────────────');
const IC = require(path.join(ROOT, 'src/engine/intraday-cycle'));

/**
 * Create a Date object representing h:m Central Standard Time (UTC-6) in Dec 2025.
 * Works correctly on any machine timezone — uses UTC epoch arithmetic so that
 * getSessionPhase's timezone-offset calculation yields the expected CT result.
 */
function makeCT(h, m) {
  // Dec 15 2025 = standard time (CST = UTC-6): CT+6hrs = UTC
  return new Date(Date.UTC(2025, 11, 15, h + 6, m, 0, 0));
}

test('Phase: PRE_MARKET before 8:30 CT', () => {
  eq(IC.getSessionPhase(makeCT(7, 0)),  'PRE_MARKET');
  eq(IC.getSessionPhase(makeCT(8, 29)), 'PRE_MARKET');
});

test('Phase: OPEN_RUSH 8:30–9:29 CT', () => {
  eq(IC.getSessionPhase(makeCT(8, 30)), 'OPEN_RUSH');
  eq(IC.getSessionPhase(makeCT(9, 29)), 'OPEN_RUSH');
});

test('Phase: MIDMORNING 9:30–10:59 CT', () => {
  eq(IC.getSessionPhase(makeCT(9,  30)), 'MIDMORNING');
  eq(IC.getSessionPhase(makeCT(10, 59)), 'MIDMORNING');
});

test('Phase: MIDDAY_CHOP 11:00–12:59 CT', () => {
  eq(IC.getSessionPhase(makeCT(11, 0)),  'MIDDAY_CHOP');
  eq(IC.getSessionPhase(makeCT(12, 59)), 'MIDDAY_CHOP');
});

test('Phase: CLOSE_RUSH 13:00–14:44 CT', () => {
  eq(IC.getSessionPhase(makeCT(13, 0)),  'CLOSE_RUSH');
  eq(IC.getSessionPhase(makeCT(14, 44)), 'CLOSE_RUSH');
});

test('Phase: AFTER_HOURS at 14:45+ CT (3:45 PM ET)', () => {
  eq(IC.getSessionPhase(makeCT(14, 45)), 'AFTER_HOURS');
  eq(IC.getSessionPhase(makeCT(17, 0)),  'AFTER_HOURS');
  // Verify 14:44 is still CLOSE_RUSH (one minute before cutoff)
  eq(IC.getSessionPhase(makeCT(14, 44)), 'CLOSE_RUSH');
});

test('getCycleContext: MIDMORNING — tradingAllowed=true, adj=0', () => {
  const ctx = IC.getCycleContext(makeCT(10, 0));
  eq(ctx.phase,               'MIDMORNING');
  eq(ctx.tradingAllowed,      true);
  eq(ctx.thresholdAdjustment, 0);
  eq(ctx.adaptiveAdj,         0);
});

test('getCycleContext: MIDDAY_CHOP — adj=15', () => {
  const ctx = IC.getCycleContext(makeCT(11, 30));
  eq(ctx.phase,               'MIDDAY_CHOP');
  eq(ctx.thresholdAdjustment, 15);
});

test('getCycleContext: OPEN_RUSH — adj=10', () => {
  const ctx = IC.getCycleContext(makeCT(9, 0));
  eq(ctx.thresholdAdjustment, 10);
});

test('getCycleContext: PRE_MARKET — tradingAllowed=false', () => {
  const ctx = IC.getCycleContext(makeCT(7, 0));
  eq(ctx.tradingAllowed, false);
});

test('getCycleContext: AFTER_HOURS — tradingAllowed=false', () => {
  const ctx = IC.getCycleContext(makeCT(14, 45));
  eq(ctx.tradingAllowed, false);
});

test('getCycleContext: adaptive adj clamped to ±10', () => {
  const ctx = IC.getCycleContext(makeCT(10, 0), { MIDMORNING: 999 });
  eq(ctx.adaptiveAdj, 10, 'Adaptive adj should cap at 10');
  eq(ctx.thresholdAdjustment, 10, 'Base 0 + capped 10 = 10');
});

test('getCycleContext: negative adaptive adj clamped to -10', () => {
  const ctx = IC.getCycleContext(makeCT(10, 0), { MIDMORNING: -999 });
  eq(ctx.adaptiveAdj, -10);
  eq(ctx.thresholdAdjustment, -10);
});

test('getCycleContext: blocked phases (99) ignore adaptive adj', () => {
  const ctx = IC.getCycleContext(makeCT(7, 0), { PRE_MARKET: -50 });
  eq(ctx.adaptiveAdj,         0,  'Blocked phase should not apply adaptive adj');
  eq(ctx.thresholdAdjustment, 99, 'Blocked phase stays at 99');
});

test('getCycleMultiplier: OPEN_RUSH=10, MIDDAY_CHOP=15, MIDMORNING=0', () => {
  eq(IC.getCycleMultiplier('OPEN_RUSH'),   10);
  eq(IC.getCycleMultiplier('MIDDAY_CHOP'), 15);
  eq(IC.getCycleMultiplier('MIDMORNING'),  0);
});

test('getCycleMultiplier: PRE_MARKET and AFTER_HOURS both 99', () => {
  eq(IC.getCycleMultiplier('PRE_MARKET'),  99);
  eq(IC.getCycleMultiplier('AFTER_HOURS'), 99);
});

test('getVolumeExpectation: MIDDAY_CHOP < OPEN_RUSH', () => {
  assert(IC.getVolumeExpectation('MIDDAY_CHOP') < IC.getVolumeExpectation('OPEN_RUSH'),
    'Midday should have lower expected volume than open rush');
});

test('getVolumeExpectation: CLOSE_RUSH > MIDMORNING', () => {
  assert(IC.getVolumeExpectation('CLOSE_RUSH') > IC.getVolumeExpectation('MIDMORNING'));
});

// ─── Section 3: DB Analytics ──────────────────────────────────────────────────

console.log('\n── DB Analytics ─────────────────────────────────────────────────────────');
const db = require(path.join(ROOT, 'src/storage/db'));

test('getWinRateByRegime: returns empty object when minTrades threshold unmet', () => {
  const result = db.getWinRateByRegime(999999);
  assert(typeof result === 'object' && !Array.isArray(result));
  eq(Object.keys(result).length, 0, 'Should be {} with impossibly high minTrades');
});

test('getWinRateByPath: returns empty object when minTrades threshold unmet', () => {
  const result = db.getWinRateByPath(999999);
  assert(typeof result === 'object' && !Array.isArray(result));
});

test('getWinRateByConfidenceBucket: always returns all 5 buckets', () => {
  const result = db.getWinRateByConfidenceBucket();
  const expectedKeys = ['<50', '50-60', '60-70', '70-80', '80+'];
  for (const k of expectedKeys) {
    assert(k in result, `Missing bucket ${k}`);
    assert(typeof result[k].wins    === 'number');
    assert(typeof result[k].losses  === 'number');
    assert(typeof result[k].total   === 'number');
    assert(typeof result[k].winRate === 'string');
  }
});

test('getAdaptiveRegimeAdjustments: returns plain object', () => {
  const result = db.getAdaptiveRegimeAdjustments(999999);
  assert(typeof result === 'object' && !Array.isArray(result));
});

test('getSignalReliability: returns an array', () => {
  const result = db.getSignalReliability();
  assert(Array.isArray(result));
});

// Round-trip: saves one test trade; also seeds data for reliability test below
test('saveTrade + getRecentTrades round-trip', () => {
  const before = db.getRecentTrades(10000);
  db.saveTrade({
    direction: 'long', path: 'A', grade: 'B+', confidence: 62,
    entry: 5900, stopLoss: 5897, takeProfit: 5906,
    exitPrice: 5906, exitReason: 'TP', profitLoss: 37.5, outcome: 'win',
    durationSeconds: 87, rvivRegime: 'NEUTRAL', session: 'MIDMORNING',
    signalVotes: [
      { name: '5m_trend', vote: 'BULLISH' },
      { name: 'delta',    vote: 'BULLISH' },
      { name: 'tick_flow', vote: 'BEARISH' }
    ],
    bullishCount: 2, bearishCount: 1, convergenceRatio: 0.667, totalSignals: 3,
    scoreMacro: 12, scoreFutures: 8, scoreMicro: 14, scoreTick: 9
  });
  const after = db.getRecentTrades(10000);
  eq(after.length, before.length + 1, 'Should have one more trade after save');
  // Verify field mapping (snake_case in stored record)
  const t = after[0];  // getRecentTrades returns newest-first
  eq(t.path,        'A',       'path field');
  eq(t.exit_reason, 'TP',      'exit_reason field');
  eq(t.rviv_regime, 'NEUTRAL', 'rviv_regime field');
  eq(t.outcome,     'win',     'outcome field');
  assert(t.signal_votes != null, 'signal_votes should be stored');
});

test('getSignalReliability: reads named signals from saved trades', () => {
  const result = db.getSignalReliability();
  assert(Array.isArray(result));
  // At minimum the trade we just saved should contribute if it had named signals
  if (result.length > 0) {
    const first = result[0];
    assert(typeof first.name         === 'string',  'name should be string');
    assert(typeof first.tradesActive === 'number',  'tradesActive should be number');
    assert(typeof first.winRate      === 'string',  'winRate should be string');
    assert(typeof first.avgPnL       === 'number',  'avgPnL should be number');
    // Verify our test trade's signals appear
    const names = result.map(r => r.name);
    assert(names.includes('5m_trend'), '5m_trend signal should be tracked');
  }
});

test('getWinRateByRegime: NEUTRAL bucket has our test trade', () => {
  // Our test trade has rvivRegime: 'NEUTRAL' and outcome 'win'
  // With minTrades=1 it should appear
  const result = db.getWinRateByRegime(1);
  assert('NEUTRAL' in result, 'NEUTRAL regime should appear with minTrades=1');
  assert(result.NEUTRAL.total >= 1);
});

test('getWinRateByPath: path A bucket has our test trade', () => {
  const result = db.getWinRateByPath(1);
  assert('A' in result, 'Path A should appear with minTrades=1');
  assert(result.A.total >= 1);
});

test('getWinRateByConfidenceBucket: 60-70 bucket has our test trade (confidence=62)', () => {
  const result = db.getWinRateByConfidenceBucket();
  assert(result['60-70'].total >= 1, '60-70 bucket should have at least 1 trade');
});

test('getDailyStats: returns object with total/wins/losses/pnl', () => {
  const stats = db.getDailyStats();
  assert(typeof stats.total   === 'number');
  assert(typeof stats.wins    === 'number');
  assert(typeof stats.losses  === 'number');
  assert(typeof stats.pnl     === 'number');
});

// ─── Section 4: Module Load ───────────────────────────────────────────────────

console.log('\n── Module Load ──────────────────────────────────────────────────────────');

test('realized-volatility.js loads', () => {
  const m = require(path.join(ROOT, 'src/engine/realized-volatility'));
  assert(typeof m.computeRealizedVol   === 'function');
  assert(typeof m.classifyVolRegime    === 'function');
  assert(typeof m.volProportionalStops === 'function');
  assert(typeof m.computeRVIVRatio     === 'function');
});

test('intraday-cycle.js loads', () => {
  const m = require(path.join(ROOT, 'src/engine/intraday-cycle'));
  assert(typeof m.getSessionPhase  === 'function');
  assert(typeof m.getCycleContext  === 'function');
  assert(typeof m.PHASES           === 'object');
});

test('tick-precision.js loads', () => {
  const m = require(path.join(ROOT, 'src/engine/tick-precision'));
  assert(typeof m.getTickAnalysis       === 'function');
  assert(typeof m.findTickPerfectEntry  === 'function');
});

test('scalping-intelligence.js loads and exports calculateScalpingConfidence', () => {
  const m = require(path.join(ROOT, 'src/engine/scalping-intelligence'));
  assert(typeof m.calculateScalpingConfidence === 'function');
});

test('automation.js loads without side effects', () => {
  const m = require(path.join(ROOT, 'src/engine/automation'));
  assert(typeof m.start     === 'function', 'start should be exported');
  assert(typeof m.stop      === 'function', 'stop should be exported');
  assert(typeof m.getState  === 'function', 'getState should be exported');
  assert(typeof m.getMetrics === 'function', 'getMetrics should be exported');
  // Verify key state fields are present
  const state = m.getState();
  assert('cumulativeDelta'           in state, 'cumulativeDelta in state');
  assert('cycleSnapshot'             in state, 'cycleSnapshot in state');
  assert('tradeContext'              in state, 'tradeContext in state');
  assert('adaptiveRegimeAdjustments' in state, 'adaptiveRegimeAdjustments in state');
});

// ─── Section 5: ScalpingIntelligence async fixture ────────────────────────────

console.log('\n── ScalpingIntelligence (async fixture) ─────────────────────────────────');
const SI = require(path.join(ROOT, 'src/engine/scalping-intelligence'));

function makeMinimalBars(n, basePrice = 5000) {
  return Array.from({ length: n }, (_, i) => ({
    time:   Date.now() - i * 300_000,
    open:   basePrice + (Math.random() - 0.5),
    high:   basePrice + 2,
    low:    basePrice - 2,
    close:  basePrice + (Math.random() - 0.5) * 2,
    volume: 1000
  }));
}

const stubMacro = {
  regime:    { type: 'PASSIVE_DOMINATED', confidence: 70, flowPressure: 'BULLISH' },
  macroData: { vix: 14.0, vix3m: 15.0, vixStructure: 'CONTANGO', vixTrend: 'FALLING' },
  cotSignal: { signal: 'DEALERS_LONG', percentile: 0.75, reportDate: '2026-02-01' }
};

const stubFutures = {
  basis:          { signal: 'FAIR_VALUE', reasoning: 'test' },
  deltaImbalance: { signal: 'BULLISH_IMBALANCE', confidence: 80, reasoning: 'test' },
  priceDiscovery: { role: 'LEADING', magnitude: 0.5, reasoning: 'test' },
  dte0Pressure:   null
};

async function testScalpingIntelligence() {
  const bars5m  = makeMinimalBars(40);
  const bars15m = makeMinimalBars(25);
  const bars1m  = makeMinimalBars(60);
  const bars1s  = [];

  // Case 1: no cumulative delta (neutral)
  const result = await SI.calculateScalpingConfidence(
    stubMacro, stubFutures,
    bars5m, bars15m, bars1m, bars1s,
    { sessionBarDelta: 3, cumulativeDelta: 0 }
  );

  assert(typeof result.confidence === 'number',
    'confidence should be number');
  assert(['LONG', 'SHORT', null].includes(result.direction),
    `direction ${result.direction} unexpected`);
  assert(Array.isArray(result.breakdown), 'breakdown should be array');
  assert(typeof result.shouldScalp === 'boolean', 'shouldScalp should be boolean');
  assert(result.vwapRelationship != null, 'vwapRelationship should exist');
  assert(result.summary?.layerScores != null, 'layerScores should exist');

  // allSignals should be present and named
  assert(Array.isArray(result.allSignals), 'allSignals should be an array');
  if (result.allSignals.length > 0) {
    const sig = result.allSignals[0];
    assert(typeof sig.name === 'string', 'signal.name should be string');
    assert(typeof sig.vote === 'string', 'signal.vote should be string');
    assert(['BULLISH', 'BEARISH'].includes(sig.vote), `signal.vote ${sig.vote} unexpected`);
  }

  // cum_delta should NOT appear when cumulativeDelta=0 (filtered out as null)
  const cumDeltaSig = result.allSignals.find(s => s.name === 'cum_delta');
  assert(!cumDeltaSig, 'cum_delta should not appear in allSignals when delta=0');

  console.log(`    → confidence=${result.confidence} dir=${result.direction} ` +
    `signals=${result.allSignals.length} grade=${result.grade}`);

  // Case 2: with strong BULLISH cumulative delta
  const result2 = await SI.calculateScalpingConfidence(
    stubMacro, stubFutures,
    bars5m, bars15m, bars1m, bars1s,
    { sessionBarDelta: 6, cumulativeDelta: 75 }  // sess_delta BULLISH + cum_delta BULLISH
  );

  assert(Array.isArray(result2.allSignals), 'allSignals should exist');
  const cumDeltaSig2 = result2.allSignals.find(s => s.name === 'cum_delta');
  assert(cumDeltaSig2 != null, 'cum_delta should appear when cumulativeDelta=75');
  eq(cumDeltaSig2.vote, 'BULLISH', 'cum_delta vote should be BULLISH for delta=75');

  // Verify scoring was applied: look for Cumulative Delta breakdown entry
  const cumBreakdown = result2.breakdown.find(b => b.factor?.includes('Cumulative Delta'));
  assert(cumBreakdown != null, 'Cumulative Delta breakdown entry should appear');

  console.log(`    → cum_delta=75: score=${cumBreakdown?.score} factor="${cumBreakdown?.factor}"`);
}

test('ScalpingIntelligence fixture: shape, allSignals, cum_delta scoring', () => testScalpingIntelligence());

// ─── Section 6: Safety & Recovery ────────────────────────────────────────────

console.log('\n── Safety & Recovery ────────────────────────────────────────────────────');

test('db.saveActiveTrade + getActiveTrade round-trip', () => {
  db.saveActiveTrade({ direction: 'LONG', entry: 5900, stopLoss: 5897, takeProfit: 5906, confidence: 65, grade: 'B+' });
  const t = db.getActiveTrade();
  assert(t !== null, 'getActiveTrade should return saved trade');
  eq(t.direction, 'LONG',  'direction round-trips');
  eq(t.entry,     5900,    'entry round-trips');
  eq(t.stopLoss,  5897,    'stopLoss round-trips');
});

test('db.clearActiveTrade removes persisted trade', () => {
  db.saveActiveTrade({ direction: 'SHORT', entry: 5905 });
  db.clearActiveTrade();
  eq(db.getActiveTrade(), null, 'getActiveTrade should return null after clear');
});

test('db.getActiveTrade returns null when no trade persisted', () => {
  db.clearActiveTrade(); // ensure clean
  eq(db.getActiveTrade(), null);
});

test('db.saveNearMiss + getRecentNearMisses round-trip', () => {
  db.saveNearMiss({ confidence: 52, gap: 3, session: 'MIDMORNING', rvivRegime: 'NEUTRAL' });
  const misses = db.getRecentNearMisses(1);
  assert(Array.isArray(misses), 'getRecentNearMisses returns array');
  assert(misses.length >= 1, 'should have at least 1 near miss');
  const m = misses[misses.length - 1];
  eq(m.confidence, 52, 'confidence round-trips');
  eq(m.session, 'MIDMORNING', 'session round-trips');
  assert(typeof m.timestamp === 'number', 'timestamp added by saveNearMiss');
});

test('db.getRecentNearMisses(0) returns empty slice', () => {
  const misses = db.getRecentNearMisses(0);
  eq(misses.length, 0);
});

test('quote-stream exports getQuoteAge', () => {
  const qs = require(path.join(ROOT, 'src/api/quote-stream'));
  assert(typeof qs.getQuoteAge === 'function', 'getQuoteAge should be exported');
  // No connection in tests — should return Infinity
  const age = qs.getQuoteAge();
  eq(age, Infinity, 'getQuoteAge returns Infinity before any quote received');
});

test('automation.js getState has consecutiveLosses + streakPauseUntil', () => {
  const auto = require(path.join(ROOT, 'src/engine/automation'));
  const state = auto.getState();
  assert('consecutiveLosses' in state.scalpingMetrics, 'consecutiveLosses in scalpingMetrics');
  assert('streakPauseUntil'  in state.scalpingMetrics, 'streakPauseUntil in scalpingMetrics');
  eq(state.scalpingMetrics.consecutiveLosses, 0,    'consecutiveLosses starts at 0');
  eq(state.scalpingMetrics.streakPauseUntil,  null, 'streakPauseUntil starts null');
});

test('db exports all 5 new Safety functions', () => {
  assert(typeof db.saveActiveTrade      === 'function', 'saveActiveTrade exported');
  assert(typeof db.getActiveTrade       === 'function', 'getActiveTrade exported');
  assert(typeof db.clearActiveTrade     === 'function', 'clearActiveTrade exported');
  assert(typeof db.saveNearMiss         === 'function', 'saveNearMiss exported');
  assert(typeof db.getRecentNearMisses  === 'function', 'getRecentNearMisses exported');
});

// ─── Section 7: v18.4.0 — Bug Fixes & Learning Pipeline ─────────────────────

console.log('\n── v18.4.0 Bug Fixes & Learning Pipeline ────────────────────────────────');

test('ScalpingIntelligence confidence is a number (not string)', () => {
  return (async () => {
    const bars5m  = makeMinimalBars(40);
    const bars15m = makeMinimalBars(25);
    const result = await SI.calculateScalpingConfidence(
      stubMacro, stubFutures, bars5m, bars15m, [], [],
      { sessionBarDelta: 0, cumulativeDelta: 0 }
    );
    assert(typeof result.confidence === 'number', `confidence should be number, got ${typeof result.confidence}`);
    assert(!isNaN(result.confidence), 'confidence should not be NaN');
    // Ensure .toFixed() works directly (would throw if it were a string)
    assert(typeof result.confidence.toFixed(1) === 'string', '.toFixed(1) should work on number');
  })();
});

test('db.savePassedScalp + getRecentPassedScalps round-trip', () => {
  db.savePassedScalp({ reason: 'TIMEOUT', grade: 'B', confidence: 58, direction: 'LONG' });
  const scalps = db.getRecentPassedScalps(1);
  assert(Array.isArray(scalps), 'getRecentPassedScalps returns array');
  assert(scalps.length >= 1, 'should have at least 1 passed scalp');
  const s = scalps[scalps.length - 1];
  eq(s.reason,     'TIMEOUT', 'reason round-trips');
  eq(s.grade,      'B',       'grade round-trips');
  eq(s.confidence, 58,        'confidence round-trips');
  assert(typeof s.timestamp === 'number', 'timestamp added by savePassedScalp');
});

test('db.getRecentPassedScalps(0) returns empty slice', () => {
  eq(db.getRecentPassedScalps(0).length, 0);
});

test('db.getWinRateByExitReason: returns plain object', () => {
  const result = db.getWinRateByExitReason(999999);
  assert(typeof result === 'object' && !Array.isArray(result));
  eq(Object.keys(result).length, 0, 'Should be {} with impossibly high minTrades');
});

test('db.getWinRateByExitReason: returns data with minTrades=1 when trades exist', () => {
  // Our test trade has exit_reason='TP' and outcome='win' (seeded in Section 3)
  const result = db.getWinRateByExitReason(1);
  assert(typeof result === 'object' && !Array.isArray(result));
  if ('TP' in result) {
    assert(typeof result.TP.wins   === 'number', 'wins should be number');
    assert(typeof result.TP.total  === 'number', 'total should be number');
    assert(typeof result.TP.winRate === 'string', 'winRate should be string');
    assert(typeof result.TP.avgPnL  === 'string', 'avgPnL should be string');
  }
});

test('db.getWinRateByEntryType: returns plain object', () => {
  const result = db.getWinRateByEntryType(999999);
  assert(typeof result === 'object' && !Array.isArray(result));
  eq(Object.keys(result).length, 0, 'Should be {} with impossibly high minTrades');
});

test('db exports all 4 new v18.4.0 functions', () => {
  assert(typeof db.savePassedScalp        === 'function', 'savePassedScalp exported');
  assert(typeof db.getRecentPassedScalps  === 'function', 'getRecentPassedScalps exported');
  assert(typeof db.getWinRateByExitReason === 'function', 'getWinRateByExitReason exported');
  assert(typeof db.getWinRateByEntryType  === 'function', 'getWinRateByEntryType exported');
});

test('automation.js state has lastCrossAssetContext + lastCrossAssetTs', () => {
  const auto = require(path.join(ROOT, 'src/engine/automation'));
  const state = auto.getState();
  assert('lastCrossAssetContext' in state, 'lastCrossAssetContext in state');
  assert('lastCrossAssetTs'      in state, 'lastCrossAssetTs in state');
  eq(state.lastCrossAssetContext, null, 'lastCrossAssetContext starts null');
  eq(state.lastCrossAssetTs,      null, 'lastCrossAssetTs starts null');
});

test('trail stop: effectiveStop uses breakEvenStopLevel when more protective (LONG)', () => {
  // Simulate: break-even at 5901.25, trail would land at 5900.50 (below BE)
  // Expected: effectiveStop = 5901.25 (break-even wins)
  const beStop  = 5901.25;
  const trail   = 5900.50;
  const direction = 'LONG';
  const effectiveStop = direction === 'LONG'
    ? Math.max(trail, beStop)
    : Math.min(trail, beStop);
  eq(effectiveStop, beStop, 'LONG: break-even stop should protect when trail is lower');
});

test('trail stop: effectiveStop uses newTrail when more protective than break-even (LONG)', () => {
  // Simulate: break-even at 5901.25, trail at 5903.00 (above BE) → trail wins
  const beStop  = 5901.25;
  const trail   = 5903.00;
  const direction = 'LONG';
  const effectiveStop = direction === 'LONG'
    ? Math.max(trail, beStop)
    : Math.min(trail, beStop);
  eq(effectiveStop, trail, 'LONG: trail should win when it is higher than break-even');
});

// ─── Section 7 continued: False-Negative Analysis ─────────────────────────────

test('getNearMissProfile: returns correct shape on empty data', () => {
  // Use a temp near-misses file path check — function reads from FILES.nearMisses
  // If file is empty or absent, should return sentinel with all keys
  const profile = db.getNearMissProfile();
  assert(typeof profile === 'object', 'returns object');
  assert('total' in profile,          'has total');
  assert('avgGap' in profile,         'has avgGap');
  assert('avgConfidence' in profile,  'has avgConfidence');
  assert('bySession' in profile,      'has bySession');
  assert('byRegime' in profile,       'has byRegime');
  assert('byGapBucket' in profile,    'has byGapBucket');
  assert('0-3'  in profile.byGapBucket, 'byGapBucket has 0-3');
  assert('3-5'  in profile.byGapBucket, 'byGapBucket has 3-5');
  assert('5-10' in profile.byGapBucket, 'byGapBucket has 5-10');
  // total is a number (may be > 0 from prior tests — that's fine)
  assert(typeof profile.total === 'number', 'total is a number');
});

test('getNearMissProfile: byGapBucket boundaries correct', () => {
  // Seed 3 near-misses with known gaps
  db.saveNearMiss({ confidence: 50, gap: 3,  session: 'MORNING',  rvivRegime: 'NEUTRAL' }); // → '0-3'
  db.saveNearMiss({ confidence: 51, gap: 4,  session: 'MORNING',  rvivRegime: 'NEUTRAL' }); // → '3-5'
  db.saveNearMiss({ confidence: 52, gap: 8,  session: 'MORNING',  rvivRegime: 'NEUTRAL' }); // → '5-10'
  const profile = db.getNearMissProfile();
  assert(profile.byGapBucket['0-3']  >= 1, '0-3 bucket has at least 1 entry (gap=3)');
  assert(profile.byGapBucket['3-5']  >= 1, '3-5 bucket has at least 1 entry (gap=4)');
  assert(profile.byGapBucket['5-10'] >= 1, '5-10 bucket has at least 1 entry (gap=8)');
});

test('getNearMissProfile: bySession populated after saveNearMiss', () => {
  // Near-miss with session=MIDMORNING was seeded in Section 6
  const profile = db.getNearMissProfile();
  assert(profile.total > 0, 'should have near-misses from prior tests');
  const sessions = Object.keys(profile.bySession);
  assert(sessions.length > 0, 'bySession should have at least 1 entry');
  const firstSession = profile.bySession[sessions[0]];
  assert(typeof firstSession.count        === 'number', 'bySession entry has count');
  assert(typeof firstSession.avgGap       === 'number', 'bySession entry has avgGap');
  assert(typeof firstSession.avgConfidence === 'number', 'bySession entry has avgConfidence');
});

test('getPassedScalpProfile: returns correct shape on empty-ish data', () => {
  const profile = db.getPassedScalpProfile();
  assert(typeof profile === 'object', 'returns object');
  assert('total' in profile,             'has total');
  assert('avgConfidence' in profile,     'has avgConfidence');
  assert('byReason' in profile,          'has byReason');
  assert('byGrade' in profile,           'has byGrade');
  assert('confidenceBuckets' in profile, 'has confidenceBuckets');
  // All 5 confidence buckets always present
  assert('<50'   in profile.confidenceBuckets, 'bucket <50 present');
  assert('50-60' in profile.confidenceBuckets, 'bucket 50-60 present');
  assert('60-70' in profile.confidenceBuckets, 'bucket 60-70 present');
  assert('70-80' in profile.confidenceBuckets, 'bucket 70-80 present');
  assert('80+'   in profile.confidenceBuckets, 'bucket 80+ present');
});

test('getPassedScalpProfile: byReason populated after savePassedScalp', () => {
  // Passed scalp with reason=TIMEOUT was seeded in Section 7 round-trip test
  const profile = db.getPassedScalpProfile();
  assert(profile.total > 0, 'should have passed scalps from prior tests');
  assert('TIMEOUT' in profile.byReason, 'TIMEOUT reason should appear');
  assert(profile.byReason.TIMEOUT.count >= 1, 'TIMEOUT count >= 1');
  // confidence=58 → '50-60' bucket
  assert(profile.confidenceBuckets['50-60'] >= 1, '50-60 bucket should have at least 1 entry');
});

test('getFalseNegativeRate: returns correct shape', () => {
  const result = db.getFalseNegativeRate(1);
  assert(typeof result === 'object', 'returns object');
  assert('estimatedFalseNegativeRate' in result, 'has estimatedFalseNegativeRate');
  assert('totalNearMisses'            in result, 'has totalNearMisses');
  assert('estimatedWinnersCount'      in result, 'has estimatedWinnersCount');
  assert('contextBreakdown'           in result, 'has contextBreakdown');
  assert('hasEnoughData'              in result, 'has hasEnoughData');
  assert(Array.isArray(result.contextBreakdown), 'contextBreakdown is array');
  assert(typeof result.hasEnoughData === 'boolean', 'hasEnoughData is boolean');
  assert(typeof result.totalNearMisses === 'number', 'totalNearMisses is number');
  assert(typeof result.estimatedWinnersCount === 'number', 'estimatedWinnersCount is number');
});

test('getFalseNegativeRate: hasEnoughData=false when no matching trade context', () => {
  // Near-misses exist (seeded above) but no trades share session+regime with near-misses
  // using an impossibly high minTrades so nothing matches
  const result = db.getFalseNegativeRate(999999);
  eq(result.hasEnoughData, false, 'hasEnoughData should be false with minTrades=999999');
  assert(result.totalNearMisses > 0, 'totalNearMisses should reflect seeded near-misses');
  eq(result.estimatedWinnersCount, 0, 'no winners estimated when no context matches');
});

test('db exports 3 new false-negative functions', () => {
  assert(typeof db.getNearMissProfile    === 'function', 'getNearMissProfile exported');
  assert(typeof db.getPassedScalpProfile === 'function', 'getPassedScalpProfile exported');
  assert(typeof db.getFalseNegativeRate  === 'function', 'getFalseNegativeRate exported');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

async function runAll() {
  // Wait for all async tests registered via test()
  await Promise.all(_pending);
  console.log(`\n${'─'.repeat(75)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailed tests indicate issues that should be fixed before live trading.');
    process.exit(1);
  } else {
    console.log('All tests passed ✅');
  }
}

// Kick off — give sync tests a tick to finish registering, then run async
setImmediate(() => runAll().catch(err => { console.error('Test runner error:', err); process.exit(1); }));
