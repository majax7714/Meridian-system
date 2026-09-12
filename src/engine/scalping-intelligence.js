// ============================================================================
// SCALPING INTELLIGENCE ENGINE v18.6.0
// Complete Integration of All Academic Research
// ============================================================================
// 4-Layer Architecture:
// MACRO (strategic) → FUTURES (structural) → MICRO (tactical) → EXECUTION
// ============================================================================

const TickPrecision  = require('./tick-precision');
const RealizedVol    = require('./realized-volatility');
const CrossAsset     = require('./cross-asset');

// ============================================================================
// CONFIDENCE CALCULATOR - Integrates ALL metrics
// ============================================================================

/**
 * Calculate complete scalping confidence from all layers
 * Returns 0-100 score with detailed breakdown
 */
async function calculateScalpingConfidence(macroContext, futuresContext, bars5m, bars15m, bars1m, bars1s, hybridCtx = {}) {
  const { volContext = null, liveQuote = null, cycleContext = null, crossAssetContext = null, quoteBuffer = null, sessionBarDelta = 0, cumulativeDelta = 0, catalystContext = null, scorecardWeights = null } = hybridCtx;

  // Layer weight multipliers from signal scorecard (0.5–1.5 range, default 1.0)
  const lw = (scorecardWeights && scorecardWeights.sufficient && scorecardWeights.layerWeights) || {};
  const wMacro     = lw.macro      ?? 1.0;
  const wFutures   = lw.futures    ?? 1.0;
  const wMicro     = lw.micro      ?? 1.0;
  const wTick      = lw.tick       ?? 1.0;
  const wExecution = lw.execution  ?? 1.0;
  const wCrossAsset = lw.cross_asset ?? 1.0;
  console.log('[ScalpingEngine] Calculating comprehensive confidence score...');
  
  let totalConfidence = 0;
  const breakdown = [];
  
  // ========================================================================
  // LAYER 1: MACRO REGIME (Max 15 points) - Reduced to make room for tick
  // ========================================================================
  
  // Passive flow regime strength
  if (macroContext.regime.type === 'PASSIVE_DOMINATED') {
    const passiveScore = macroContext.regime.confidence / 6.67;  // 0-15
    totalConfidence += passiveScore;
    breakdown.push({
      layer: 'MACRO',
      factor: 'Passive Flow Regime',
      score: passiveScore.toFixed(1),
      reasoning: `${macroContext.regime.type} at ${macroContext.regime.confidence}% confidence`
    });
  } else if (macroContext.regime.type === 'ACTIVE_DOMINATED') {
    // Penalty for active regime
    totalConfidence -= 5;
    breakdown.push({
      layer: 'MACRO',
      factor: 'Active Regime Penalty',
      score: -5,
      reasoning: 'Active-dominated regime less predictable for scalping'
    });
  }

  // COT dealer positioning signal (±3 points) — applied after direction is tentatively known
  // We check it again after direction is set; store for later use
  const cotSignal = macroContext.cotSignal || null;

  // ========================================================================
  // LAYER 2: FUTURES MECHANICS (Max 25 points) - Reduced
  // ========================================================================
  
  // Order flow delta imbalance (0-10 points)
  if (futuresContext.deltaImbalance.signal === 'BULLISH_IMBALANCE' ||
      futuresContext.deltaImbalance.signal === 'BEARISH_IMBALANCE') {
    const deltaScore = 10;
    totalConfidence += deltaScore;
    breakdown.push({
      layer: 'FUTURES',
      factor: 'Order Flow Delta',
      score: deltaScore,
      reasoning: `${futuresContext.deltaImbalance.signal} - strong directional pressure`
    });
  }
  
  // ========================================================================
  // LAYER 3: MICRO REGIME (Max 25 points) - Reduced
  // ========================================================================
  
  // Calculate 5-minute trend strength
  const trend5min = calculateTrendStrength(bars5m, 12);  // Last hour
  const trendScore = (trend5min.strength / 100) * 12;  // 0-12 points
  totalConfidence += trendScore;
  breakdown.push({
    layer: 'MICRO',
    factor: '5min Trend Strength',
    score: trendScore.toFixed(1),
    reasoning: `${trend5min.direction} trend at ${trend5min.strength.toFixed(0)}% strength`
  });
  
  // Timeframe alignment (5min vs 15min)
  const trend15min = calculateTrendStrength(bars15m, 8);  // Last 2 hours
  if (trend5min.direction === trend15min.direction) {
    const alignmentScore = 8;
    totalConfidence += alignmentScore;
    breakdown.push({
      layer: 'MICRO',
      factor: 'Timeframe Alignment',
      score: alignmentScore,
      reasoning: '5min and 15min trends aligned - high confidence'
    });
  }
  
  // Volume confirmation (phase-normalized: adjusts for expected session volume level)
  const phaseExpectation = cycleContext?.volumeExpectation ?? 1.0;
  const volumeProfile = analyzeVolumeProfile(bars5m, phaseExpectation);
  if (volumeProfile.ratio > 1.2) {
    const volumeScore = 5;
    totalConfidence += volumeScore;
    breakdown.push({
      layer: 'MICRO',
      factor: 'Volume Confirmation',
      score: volumeScore,
      reasoning: `Volume ${((volumeProfile.ratio - 1) * 100).toFixed(0)}% above average`
    });
  }
  
  // ========================================================================
  // LAYER 4: TICK PRECISION (Max ~22 points)
  // v19: Restructured — rewards flow DIVERGENCE (accumulation/distribution)
  // over flow CONFIRMATION (late/crowded signal). Momentum and acceleration
  // halved. PARABOLIC excluded (exhaustion, not opportunity).
  // ========================================================================

  // Get tick analysis (pass live quote + quote buffer for order flow and spread scoring)
  const tickAnalysis = TickPrecision.getTickAnalysis(bars1s, bars1m, bars5m, liveQuote, quoteBuffer);

  if (tickAnalysis) {
    // Real-time order flow — scored by relationship to price trend:
    //   Divergence (flow opposes trend) = accumulation/distribution → max 8 pts
    //   Confirmation (flow agrees with trend) = late/crowded → max 4 pts
    //   Neutral trend or balanced flow → max 4 pts
    if (tickAnalysis.orderFlow.signal !== 'BALANCED') {
      const divergence = detectDeltaDivergence(trend5min.direction, tickAnalysis?.orderFlow.signal);
      const isDiverging = divergence.divergent;
      const flowCap = isDiverging ? 8 : 4;
      const flowScore = (tickAnalysis.orderFlow.confidence / 100) * flowCap;
      totalConfidence += flowScore;
      breakdown.push({
        layer: 'TICK',
        factor: isDiverging ? 'Order Flow Divergence (accumulation)' : 'Order Flow Confirmation',
        score: flowScore.toFixed(1),
        reasoning: tickAnalysis.orderFlow.reasoning + (isDiverging ? ' — flow opposing trend = predictive' : ' — flow confirming trend = late signal')
      });
    }

    // Tick momentum (0-5 points, halved from 10 — reduces chase signal)
    if (tickAnalysis.momentum.signal !== 'FLAT' && tickAnalysis.momentum.signal !== 'CHOPPY') {
      const momentumScore = (tickAnalysis.momentum.confidence / 100) * 5;
      totalConfidence += momentumScore;
      breakdown.push({
        layer: 'TICK',
        factor: 'Tick Momentum',
        score: momentumScore.toFixed(1),
        reasoning: tickAnalysis.momentum.reasoning
      });
    }

    // Price acceleration (0-4 points, halved from 8)
    // PARABOLIC excluded — exhaustion signal, not entry opportunity
    if (tickAnalysis.acceleration.signal === 'ACCELERATING' ||
        tickAnalysis.acceleration.signal === 'BUILDING') {
      const accelScore = (tickAnalysis.acceleration.confidence / 100) * 4;
      totalConfidence += accelScore;
      breakdown.push({
        layer: 'TICK',
        factor: 'Price Acceleration',
        score: accelScore.toFixed(1),
        reasoning: tickAnalysis.acceleration.reasoning
      });
    }

    // ── Tick structure: POC + key level proximity (data already computed, just not scored) ──
    if (tickAnalysis.currentPrice != null) {
      const price = tickAnalysis.currentPrice;

      // Point of Control (highest volume level) — institutional magnet
      const poc = tickAnalysis.volumeProfile?.pocPrice;
      if (poc) {
        const pocDist = Math.abs(price - poc);
        if (pocDist <= 0.25) {
          totalConfidence += 3;
          breakdown.push({ layer: 'TICK', factor: 'Price at POC', score: 3, reasoning: `Price ${price} at/near POC ${poc} (±0.25)` });
        } else if (pocDist <= 0.75) {
          totalConfidence += 1;
          breakdown.push({ layer: 'TICK', factor: 'Price near POC', score: 1, reasoning: `Price ${price} near POC ${poc} (±0.75)` });
        }
      }

      // Top high-frequency tick level
      const topLevel = tickAnalysis.levels?.levels?.[0];
      if (topLevel && Math.abs(price - topLevel.price) <= 0.25) {
        totalConfidence += 2;
        breakdown.push({ layer: 'TICK', factor: 'Key Tick Level', score: 2, reasoning: `Price at ${topLevel.price} (${topLevel.touches} touches)` });
      }

      // Low-volume node (LVN): price in a thin zone = fast acceleration likely
      const lvns = tickAnalysis.volumeProfile?.lowVolumeNodes;
      if (lvns && lvns.length > 0) {
        const nearestLVN = lvns.find(n => Math.abs(price - n.price) <= 0.5);
        if (nearestLVN) {
          totalConfidence += 4;
          breakdown.push({ layer: 'TICK', factor: 'LVN Acceleration Zone', score: 4, reasoning: `Price ${price} in low-volume node at ${nearestLVN.price} — thin zone, fast move likely` });
        }
      }
    }
  } else {
    breakdown.push({
      layer: 'TICK',
      factor: 'Tick Data Unavailable',
      score: 0,
      reasoning: 'Insufficient 1-second bar data'
    });
  }
  
  // ========================================================================
  // LAYER 5: EXECUTION CONTEXT (Max 18 points)
  // Expanded: liquidity (5) + vol regime (5) + VWAP alignment (8)
  // ========================================================================

  // Live spread from tick analysis (if SignalR quote available)
  if (tickAnalysis && tickAnalysis.liveSpread && tickAnalysis.liveSpread.score > 0) {
    totalConfidence += tickAnalysis.liveSpread.score;
    breakdown.push({
      layer: 'EXECUTION',
      factor: 'Live Spread Liquidity',
      score: tickAnalysis.liveSpread.score,
      reasoning: tickAnalysis.liveSpread.reasoning
    });
  } else {
    // Fallback: bar-based liquidity check
    const liquidityCheck = assessLiquidity(bars5m);
    if (liquidityCheck.canScalp) {
      const liquidityScore = 5;
      totalConfidence += liquidityScore;
      breakdown.push({
        layer: 'EXECUTION',
        factor: 'Liquidity',
        score: liquidityScore,
        reasoning: 'Spread tight, volume good - safe to scalp'
      });
    }
  }

  // Volatility regime
  const volatility = calculateRecentVolatility(bars5m, 12);
  if (volatility.regime === 'LOW_VOL' || volatility.regime === 'MEDIUM_VOL') {
    const volScore = 5;
    totalConfidence += volScore;
    breakdown.push({
      layer: 'EXECUTION',
      factor: 'Volatility Regime',
      score: volScore,
      reasoning: `${volatility.regime} - predictable for scalping`
    });
  }

  // VWAP relationship — wire in the existing but previously unused function (up to 8 points)
  const vwapRel = calculateVWAPRelationship(bars5m);
  const sessionVwap = calculateSessionVWAP(bars5m);  // null if before 8:30 CT or insufficient bars
  if (vwapRel.signal === 'TREND_BIAS' && vwapRel.bias) {
    // Price trending away from VWAP — good for momentum scalp
    const vwapScore = 4;
    totalConfidence += vwapScore;
    breakdown.push({
      layer: 'EXECUTION',
      factor: 'VWAP Trend Bias',
      score: vwapScore,
      reasoning: `${vwapRel.reasoning} — momentum continuation likely`
    });
  } else if (vwapRel.signal === 'FADE_TO_VWAP') {
    // Price displaced: mean reversion signal (good for Path B, neutral for Path A)
    const vwapScore = 3;
    totalConfidence += vwapScore;
    breakdown.push({
      layer: 'EXECUTION',
      factor: 'VWAP Reversion Setup',
      score: vwapScore,
      reasoning: `${vwapRel.reasoning} — fade trade opportunity`
    });
  }

  // ========================================================================
  // CONVERGENCE BONUS (Max 10 points)
  // Uses only fast (micro + tick) signals — slow macro signals excluded
  // to prevent artificial convergence bonus from slow-moving data.
  // ========================================================================

  // Fast signals (micro + tick): up to 5 signals
  const deltaSignal = futuresContext.deltaImbalance.signal.includes('BULLISH') ? 'BULLISH' :
                      futuresContext.deltaImbalance.signal.includes('BEARISH') ? 'BEARISH' : null;
  const tickFlow    = tickAnalysis?.orderFlow.signal.includes('BUYING')  ? 'BULLISH' :
                      tickAnalysis?.orderFlow.signal.includes('SELLING') ? 'BEARISH' : null;
  const tickMom     = tickAnalysis?.momentum.signal.includes('UP')   ? 'BULLISH' :
                      tickAnalysis?.momentum.signal.includes('DOWN') ? 'BEARISH' : null;

  const fastSignals = [
    trend5min.direction, trend15min.direction,
    deltaSignal, tickFlow, tickMom
  ].filter(s => s !== null && s !== 'NEUTRAL');

  const fastBull = fastSignals.filter(s => s === 'BULLISH').length;
  const fastBear = fastSignals.filter(s => s === 'BEARISH').length;

  const convergenceRatio = fastSignals.length > 0
    ? Math.max(fastBull, fastBear) / fastSignals.length
    : 0;

  if (convergenceRatio >= 0.75) {
    const convergenceBonus = 10;
    totalConfidence += convergenceBonus;
    breakdown.push({
      layer: 'CONVERGENCE',
      factor: 'Multi-Layer Agreement',
      score: convergenceBonus,
      reasoning: `${Math.max(fastBull, fastBear)}/${fastSignals.length} fast signals agree (${(convergenceRatio * 100).toFixed(0)}%)`
    });
  }

  // ========================================================================
  // MACRO / CROSS-ASSET DIRECTION SIGNALS (slow tiebreakers)
  // ========================================================================

  // COT dealer positioning
  const cotDir = cotSignal?.signal === 'DEALERS_LONG'  ? 'BULLISH' :
                 cotSignal?.signal === 'DEALERS_SHORT' ? 'BEARISH' : null;

  // VIX trend: falling VIX = risk-on = bullish bias
  const vixDir = macroContext.macroData?.vixTrend === 'FALLING' ? 'BULLISH' :
                 macroContext.macroData?.vixTrend === 'RISING'  ? 'BEARISH' : null;

  // NQ divergence from cross-asset
  const nqSig = crossAssetContext?.nqDivergence?.signal;
  const nqDir = (nqSig === 'NQ_LEADING_BULLISH' || nqSig === 'RISK_ON_CONFIRMED')  ? 'BULLISH' :
                (nqSig === 'NQ_LEADING_BEARISH' || nqSig === 'RISK_OFF_CONFIRMED') ? 'BEARISH' : null;

  // Risk sentiment composite
  const rsScore = crossAssetContext?.riskSentiment?.score ?? 0;
  const rsDir   = rsScore >= 2 ? 'BULLISH' : rsScore <= -2 ? 'BEARISH' : null;

  // VIX term structure: BACKWARDATION = near-term fear = BEARISH; CONTANGO = complacency = BULLISH
  const vixStructureDir = macroContext.macroData?.vixStructure === 'BACKWARDATION' ? 'BEARISH' :
                          macroContext.macroData?.vixStructure === 'CONTANGO'      ? 'BULLISH' : null;

  // Session bar delta: persistent 5m bar directional bias since 8:30 CT session open
  // ≥5 net buy bars = institutional accumulation bias; ≤-5 = distribution bias
  const sessionDeltaDir = sessionBarDelta >= 5  ? 'BULLISH' :
                          sessionBarDelta <= -5  ? 'BEARISH' : null;

  // Cumulative intraday tick delta (Lee-Ready): ≥+50 = sustained buying; ≤-50 = sustained selling
  const cumDeltaDir = cumulativeDelta >= 50  ? 'BULLISH' :
                      cumulativeDelta <= -50 ? 'BEARISH' : null;

  // All signals for direction vote — named objects enable per-signal win-rate tracking in db
  // (up to 11: 5 fast + 6 slow)
  const allSignals = [
    { name: '5m_trend',    vote: trend5min.direction },
    { name: '15m_trend',   vote: trend15min.direction },
    { name: 'delta',       vote: deltaSignal },
    { name: 'tick_flow',   vote: tickFlow },
    { name: 'tick_mom',    vote: tickMom },
    { name: 'cot_dealer',  vote: cotDir },
    { name: 'vix_trend',   vote: vixDir },
    { name: 'nq_div',      vote: nqDir },
    { name: 'risk_sent',   vote: rsDir },
    { name: 'vix_struct',  vote: vixStructureDir },
    { name: 'sess_delta',  vote: sessionDeltaDir },
    { name: 'cum_delta',   vote: cumDeltaDir }
  ].filter(s => s.vote !== null && s.vote !== 'NEUTRAL');

  const bullishCount = allSignals.filter(s => s.vote === 'BULLISH').length;
  const bearishCount = allSignals.filter(s => s.vote === 'BEARISH').length;
  const totalSignals = allSignals.length;

  // ========================================================================
  // FINAL CALCULATION
  // ========================================================================

  // Cap at 100
  totalConfidence = Math.min(Math.max(totalConfidence, 0), 100);

  // Determine direction (all 9 signals vote, majority wins)
  const direction = bullishCount > bearishCount ? 'LONG' :
                    bearishCount > bullishCount ? 'SHORT' : null;

  // COT dealer positioning adjustment (±3 points, applied after direction known)
  if (cotSignal && direction) {
    const cotDir = cotSignal.signal;
    const tradeDir = direction;
    if ((cotDir === 'DEALERS_LONG' && tradeDir === 'LONG') ||
        (cotDir === 'DEALERS_SHORT' && tradeDir === 'SHORT')) {
      // Dealer positioning confirms trade direction
      totalConfidence = Math.min(100, totalConfidence + 3);
      breakdown.push({
        layer: 'MACRO',
        factor: 'COT Dealer Alignment',
        score: 3,
        reasoning: `${cotDir} (${(cotSignal.percentile * 100).toFixed(0)}th pctile) aligns with ${tradeDir} — as of ${cotSignal.reportDate}`
      });
    } else if ((cotDir === 'DEALERS_LONG' && tradeDir === 'SHORT') ||
               (cotDir === 'DEALERS_SHORT' && tradeDir === 'LONG')) {
      // Dealer positioning opposes trade direction
      totalConfidence = Math.max(0, totalConfidence - 3);
      breakdown.push({
        layer: 'MACRO',
        factor: 'COT Dealer Conflict',
        score: -3,
        reasoning: `${cotDir} conflicts with ${tradeDir} — as of ${cotSignal.reportDate}`
      });
    }
  }

  // ── Post-direction FUTURES adjustments ──────────────────────────────────────
  // Basis: direction-aware arb signal (moved here from Layer 2 to require known direction)
  if (futuresContext.basis.signal !== 'FAIR_VALUE' && direction) {
    const basisBullish = futuresContext.basis.signal === 'FUTURES_CHEAP';  // arb buyers = bullish
    const aligned = (basisBullish && direction === 'LONG') || (!basisBullish && direction === 'SHORT');
    const basisScore = aligned ? 7 : -3;
    totalConfidence = Math.min(100, Math.max(0, totalConfidence + basisScore));
    breakdown.push({
      layer: 'FUTURES',
      factor: aligned ? 'Basis Arbitrage Tailwind' : 'Basis Arbitrage Headwind',
      score: basisScore,
      reasoning: `${futuresContext.basis.signal} ${aligned ? 'aligns with' : 'opposes'} ${direction} — ${futuresContext.basis.reasoning}`
    });
  }

  // Price discovery: only credit when acceleration aligns with trade direction
  if (futuresContext.priceDiscovery.role === 'LEADING' && direction) {
    const magPositive = futuresContext.priceDiscovery.magnitude > 0;
    const aligned = (magPositive && direction === 'LONG') || (!magPositive && direction === 'SHORT');
    if (aligned) {
      totalConfidence = Math.min(100, totalConfidence + 8);
      breakdown.push({
        layer: 'FUTURES',
        factor: 'Price Discovery Leading',
        score: 8,
        reasoning: `ES accelerating ${magPositive ? 'up' : 'down'} — aligns with ${direction} (${futuresContext.priceDiscovery.reasoning})`
      });
    }
    // No negative penalty for misaligned discovery — just don't score it
  }

  // 0DTE gamma momentum bonus — peak window (3pm-4pm) amplifies dealer hedging flow
  // Only fires during the 3pm hour when gamma hedging is at maximum intensity
  const dte0Pressure = futuresContext.dte0Pressure;
  if (dte0Pressure && dte0Pressure.peakWindow && direction !== null) {
    const gammaScore = 3;
    totalConfidence = Math.min(100, totalConfidence + gammaScore);
    breakdown.push({
      layer: 'EXECUTION',
      factor: '0DTE Gamma Momentum',
      score: gammaScore,
      reasoning: `${dte0Pressure.reasoning} — hedging flow amplifies ${direction} momentum`
    });
  }

  // ========================================================================
  // CROSS-ASSET LAYER (NQ alignment: ±4–8 pts | Risk sentiment: ±5–6 pts)
  // Applied after direction is known. NQ divergence + Gold/BTC/Oil composite.
  // Academic: Barberis et al. (2005), Baur & Lucey (2010), Bouri et al. (2020)
  // ========================================================================
  if (crossAssetContext && direction) {
    const caScore = CrossAsset.computeCrossAssetScore(
      crossAssetContext.nqDivergence,
      crossAssetContext.riskSentiment,
      direction
    );
    if (caScore.score !== 0) {
      totalConfidence = Math.min(100, Math.max(0, totalConfidence + caScore.score));
      for (const entry of caScore.breakdown) {
        breakdown.push({
          layer:     'CROSS_ASSET',
          factor:    entry.factor,
          score:     entry.score,
          reasoning: entry.reasoning
        });
      }
    }
  }

  // VIX term structure alignment (±2 pts post-direction)
  if (vixStructureDir && direction) {
    const vixStructAligned = (vixStructureDir === 'BULLISH' && direction === 'LONG') ||
                             (vixStructureDir === 'BEARISH' && direction === 'SHORT');
    if (vixStructAligned) {
      totalConfidence = Math.min(100, totalConfidence + 2);
      breakdown.push({
        layer: 'MACRO',
        factor: 'VIX Structure Aligned',
        score: 2,
        reasoning: `VIX ${macroContext.macroData.vixStructure} (VIX ${macroContext.macroData.vix?.toFixed(1)} / VIX3M ${macroContext.macroData.vix3m?.toFixed(1)}) confirms ${direction}`
      });
    }
    // No penalty for misalignment — VIX structure is slow/noisy, don't double-penalize
  }

  // Session bar delta alignment (±2 pts post-direction)
  if (sessionDeltaDir && direction) {
    const deltaAligned = (sessionDeltaDir === 'BULLISH' && direction === 'LONG') ||
                         (sessionDeltaDir === 'BEARISH' && direction === 'SHORT');
    if (deltaAligned) {
      totalConfidence = Math.min(100, totalConfidence + 2);
      breakdown.push({
        layer: 'TICK',
        factor: 'Session Flow Aligned',
        score: 2,
        reasoning: `Session bar delta ${sessionBarDelta > 0 ? '+' : ''}${sessionBarDelta} confirms ${direction} institutional bias today`
      });
    } else {
      totalConfidence = Math.max(0, totalConfidence - 2);
      breakdown.push({
        layer: 'TICK',
        factor: 'Session Flow Opposed',
        score: -2,
        reasoning: `Session bar delta ${sessionBarDelta > 0 ? '+' : ''}${sessionBarDelta} — trading against today's dominant flow`
      });
    }
  }

  // Cumulative tick delta alignment (±3 pts post-direction)
  // Uses Lee-Ready classified net buy/sell tick count since session open
  if (cumDeltaDir && direction) {
    const cumAligned = (cumDeltaDir === 'BULLISH' && direction === 'LONG') ||
                       (cumDeltaDir === 'BEARISH' && direction === 'SHORT');
    if (cumAligned) {
      totalConfidence = Math.min(100, totalConfidence + 3);
      breakdown.push({
        layer: 'TICK',
        factor: 'Cumulative Delta Aligned',
        score: 3,
        reasoning: `Cumulative delta ${cumulativeDelta > 0 ? '+' : ''}${cumulativeDelta} confirms ${direction} — sustained ${cumDeltaDir.toLowerCase()} pressure from open`
      });
    } else {
      totalConfidence = Math.max(0, totalConfidence - 3);
      breakdown.push({
        layer: 'TICK',
        factor: 'Cumulative Delta Opposed',
        score: -3,
        reasoning: `Cumulative delta ${cumulativeDelta > 0 ? '+' : ''}${cumulativeDelta} — trading against sustained ${cumDeltaDir.toLowerCase()} pressure since open`
      });
    }
  }

  // ── Catalyst layer integration ─────────────────────────────────────────────
  // Post-event per-layer penalties reduce confidence proportionally to remaining
  // event influence. Aligned bias bonus (+3) when trade direction follows the
  // event directional signal (e.g., going LONG after a bullish NFP print).
  // Only fires during post-event window (penalty > 0, not a hard pre-event block).
  if (catalystContext && catalystContext.penalty > 0 && !catalystContext.blocked && direction) {
    const lp = catalystContext.layerPenalties || {};
    const layerAdj = (lp.MACRO || 0) + (lp.TICK || 0) + (lp.FUTURES || 0) + (lp.MICRO || 0);
    if (layerAdj !== 0) {
      totalConfidence = Math.min(100, Math.max(0, totalConfidence + layerAdj));
      breakdown.push({
        layer:     'CATALYST',
        factor:    'Event Layer Penalties',
        score:     layerAdj,
        reasoning: `Post-event adjustments: MACRO${lp.MACRO || 0} TICK${lp.TICK || 0} FUTURES${lp.FUTURES || 0} MICRO${lp.MICRO || 0}`
      });
    }
    const bias = catalystContext.directionBias;
    const biasAligned = (bias === 'BULLISH' && direction === 'LONG') ||
                        (bias === 'BEARISH' && direction === 'SHORT');
    if (biasAligned) {
      // Scale bonus by FinBERT confidence weight (0–1).
      // weight = finbert.confidence × (1 − finbert.neutralProb), set in catalyst-filter.js.
      // A high-confidence "NFP beats" read (weight ~0.85) earns the full +3.
      // A borderline call (weight ~0.35) earns only +1 — we trust the model less.
      // Falls back to full +3 when weight is absent (old cached contexts).
      const weight = catalystContext.directionWeight ?? 1;
      const biasBonus = weight >= 0.65 ? 3 : weight >= 0.45 ? 2 : weight >= 0.25 ? 1 : 0;
      if (biasBonus > 0) {
        totalConfidence = Math.min(100, totalConfidence + biasBonus);
        breakdown.push({
          layer:     'CATALYST',
          factor:    'Event Direction Aligned',
          score:     biasBonus,
          reasoning: `${bias} event bias aligns with ${direction} — post-event tailwind (FinBERT weight ${weight.toFixed(2)} → +${biasBonus}pts)`
        });
      }
    }
  }

  // ── Apply scorecard weight multipliers ──────────────────────────────────
  // Adjusts per-layer contributions based on rolling accuracy data.
  // Multipliers are 0.5–1.5 (1.0 = no change). We compute each layer's
  // total from the breakdown, then scale the DELTA (weight - 1.0) × layerTotal.
  // This way a 0.7 TICK weight removes 30% of TICK's contribution.
  const layerWeightMap = { MACRO: wMacro, FUTURES: wFutures, MICRO: wMicro, TICK: wTick, EXECUTION: wExecution, CROSS_ASSET: wCrossAsset };
  let scorecardAdj = 0;
  for (const [layer, weight] of Object.entries(layerWeightMap)) {
    if (weight === 1.0) continue;
    const layerTotal = breakdown
      .filter(b => b.layer === layer)
      .reduce((sum, b) => sum + (parseFloat(b.score) || 0), 0);
    const adj = layerTotal * (weight - 1.0);
    scorecardAdj += adj;
  }
  if (scorecardAdj !== 0) {
    totalConfidence = Math.max(0, Math.min(100, totalConfidence + scorecardAdj));
    breakdown.push({
      layer: 'SCORECARD',
      factor: 'Weight Adjustment',
      score: +scorecardAdj.toFixed(1),
      reasoning: `Scorecard multipliers: ${Object.entries(layerWeightMap).filter(([,w]) => w !== 1.0).map(([l,w]) => `${l}=${w}`).join(', ') || 'none'}`
    });
  }

  // Grade the setup
  const grade = totalConfidence >= 85 ? 'A+' :
                totalConfidence >= 75 ? 'A' :
                totalConfidence >= 65 ? 'B+' :
                totalConfidence >= 55 ? 'B' :
                totalConfidence >= 45 ? 'C+' : 'C';

  // Should we scalp? (B- or better = 55+, caller applies session phase adjustment)
  const shouldScalp = totalConfidence >= 55 && direction !== null;

  // Vol-proportional stop/target distances (in ticks)
  // Falls back to volatility-regime-based sizing if no volContext passed in
  let stopDistance, targetDistance;
  if (volContext && bars5m && bars5m[0]) {
    const stops = RealizedVol.volProportionalStops(volContext.sigma, bars5m[0].close);
    stopDistance   = stops.stopTicks;
    targetDistance = stops.targetTicks;
  } else {
    stopDistance = volatility.regime === 'LOW_VOL' ? 4 :
                   volatility.regime === 'MEDIUM_VOL' ? 4 : 5; // 4t minimum per TopstepX rules
    targetDistance = stopDistance * 2;
  }

  return {
    confidence: parseFloat(totalConfidence.toFixed(1)),
    grade,
    direction,
    shouldScalp,

    // Execution parameters
    recommendedSize: 1,  // Always 1 for scalping
    stopDistance,
    targetDistance,
    maxHoldTime: 300,  // 5 minutes

    // VWAP context (used by Path B in automation.js); sessionVwap added for Path B preference
    vwapRelationship: { ...vwapRel, sessionVwap },

    // Detailed breakdown
    breakdown,

    // Tick analysis (if available)
    tickAnalysis: tickAnalysis || null,

    // Named signal vote array — enables per-signal win-rate tracking via db.getSignalReliability()
    allSignals,

    // Raw convergence ratio (0-1, fast signals only) — used by automation.js gate checks
    convergenceRatioRaw: convergenceRatio,

    // Summary
    summary: {
      convergenceRatio: (convergenceRatio * 100).toFixed(0) + '%',
      signalsAgreeing: `${Math.max(bullishCount, bearishCount)}/${totalSignals} (${fastSignals.length} fast + ${totalSignals - fastSignals.length} slow, named)`,
      layerScores: {
        macro:      breakdown.filter(b => b.layer === 'MACRO').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1),
        futures:    breakdown.filter(b => b.layer === 'FUTURES').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1),
        micro:      breakdown.filter(b => b.layer === 'MICRO').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1),
        tick:       breakdown.filter(b => b.layer === 'TICK').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1),
        execution:  breakdown.filter(b => b.layer === 'EXECUTION').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1),
        crossAsset: breakdown.filter(b => b.layer === 'CROSS_ASSET').reduce((sum, b) => sum + parseFloat(b.score), 0).toFixed(1)
      }
    }
  };
}

// ============================================================================
// HELPER FUNCTIONS - Micro Regime Analysis
// ============================================================================

/**
 * Calculate trend strength from bars
 */
function calculateTrendStrength(bars, lookback) {
  if (!bars || bars.length < lookback) {
    return { direction: 'NEUTRAL', strength: 0 };
  }
  
  const latest = bars[0];
  const oldest = bars[lookback - 1];
  
  const priceMove = latest.close - oldest.close;
  const movePct = (priceMove / oldest.close) * 100;
  
  // Count consecutive bars in same direction
  let consecutiveBars = 0;
  for (let i = 0; i < lookback - 1; i++) {
    const currentBar = bars[i];
    const prevBar = bars[i + 1];
    
    const barDirection = currentBar.close > prevBar.close ? 'UP' : 'DOWN';
    const overallDirection = movePct > 0 ? 'UP' : 'DOWN';
    
    if (barDirection === overallDirection) {
      consecutiveBars++;
    }
  }
  
  // Strength = combination of move size + consistency
  const moveStrength = Math.min(Math.abs(movePct) * 20, 60);  // 0-60 from move
  const consistencyStrength = (consecutiveBars / (lookback - 1)) * 40;  // 0-40 from consistency
  
  const totalStrength = moveStrength + consistencyStrength;
  
  const direction = Math.abs(movePct) < 0.05 ? 'NEUTRAL' :
                    movePct > 0 ? 'BULLISH' : 'BEARISH';
  
  return {
    direction,
    strength: totalStrength,
    priceMove,
    consecutiveBars
  };
}

/**
 * Calculate VWAP and relationship to current price
 */
function calculateVWAPRelationship(bars) {
  if (!bars || bars.length < 12) {
    return { signal: 'NEUTRAL', bias: null, reasoning: 'Insufficient data' };
  }
  
  // Calculate VWAP over last 12 bars (1 hour)
  let sumPV = 0;
  let sumV = 0;
  
  for (let i = 0; i < 12; i++) {
    const bar = bars[i];
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    sumPV += typicalPrice * bar.volume;
    sumV += bar.volume;
  }
  
  const vwap = sumPV / sumV;
  const currentPrice = bars[0].close;
  const deviation = currentPrice - vwap;
  const deviationPct = (deviation / vwap) * 100;
  
  // Calculate standard deviation
  let sumSquaredDev = 0;
  for (let i = 0; i < 12; i++) {
    const bar = bars[i];
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    sumSquaredDev += Math.pow(typicalPrice - vwap, 2) * bar.volume;
  }
  const stdDev = Math.sqrt(sumSquaredDev / sumV);
  const zScore = deviation / stdDev;
  
  let signal, bias, reasoning;
  
  if (Math.abs(zScore) > 2) {
    // More than 2 std devs away - fade to VWAP
    signal = 'FADE_TO_VWAP';
    bias = currentPrice > vwap ? 'BEARISH' : 'BULLISH';
    reasoning = `Price ${Math.abs(deviationPct).toFixed(2)}% from VWAP (${zScore.toFixed(1)} std devs) - expect mean reversion`;
  } else if (Math.abs(deviationPct) > 0.1) {
    // Above/below VWAP but not extreme
    signal = 'TREND_BIAS';
    bias = currentPrice > vwap ? 'BULLISH' : 'BEARISH';
    reasoning = `Price ${deviationPct > 0 ? 'above' : 'below'} VWAP - ${bias} bias`;
  } else {
    signal = 'NEUTRAL';
    bias = null;
    reasoning = 'Price near VWAP - no clear bias';
  }
  
  return { signal, bias, reasoning, vwap, zScore };
}

/**
 * Analyze volume profile, normalized by session phase expectation.
 * Dividing recent volume by phaseExpectation before the ratio comparison
 * means that "normal midday volume" (0.6× global) scores the same as
 * "normal midmorning volume" (1.3× global), reducing false negatives in MIDDAY_CHOP.
 *
 * @param {Array}  bars             - 5-minute bars (newest first)
 * @param {number} phaseExpectation - Expected relative volume for current phase (0.2–2.5)
 */
function analyzeVolumeProfile(bars, phaseExpectation = 1.0) {
  if (!bars || bars.length < 24) {
    return { ratio: 1.0, interpretation: 'Insufficient data' };
  }

  // Recent volume (last 12 bars = 1 hour)
  const recentVolume = bars.slice(0, 12).reduce((sum, b) => sum + b.volume, 0) / 12;

  // Previous hour volume (bars 12-24) — raw baseline
  const avgVolume = bars.slice(12, 24).reduce((sum, b) => sum + b.volume, 0) / 12;

  // Phase-normalize recent volume: raises the effective ratio during quiet phases
  // so that normal midday volume isn't penalized vs a higher-volume prior hour
  const norm = phaseExpectation > 0 ? phaseExpectation : 1.0;
  const ratio = avgVolume > 0 ? (recentVolume / norm) / avgVolume : 1.0;

  const interpretation = ratio > 1.5 ? 'Very high volume - strong participation' :
                         ratio > 1.2 ? 'Above average volume - good participation' :
                         ratio > 0.8 ? 'Normal volume' :
                         'Low volume - thin participation';

  return { ratio, phaseExpectation: norm, interpretation };
}

/**
 * Assess current liquidity
 */
function assessLiquidity(bars) {
  if (!bars || bars.length < 3) {
    return { canScalp: false, reasoning: 'Insufficient data' };
  }
  
  // Approximate spread from high-low of recent bars
  const recentBars = bars.slice(0, 3);
  const avgRange = recentBars.reduce((sum, b) => sum + (b.high - b.low), 0) / 3;
  
  // Check volume
  const avgVolume = recentBars.reduce((sum, b) => sum + b.volume, 0) / 3;
  
  const canScalp = avgRange < 2.0 && avgVolume > 500;  // Tight range + good volume
  
  const reasoning = canScalp ? 
    'Tight spread, good volume - safe to scalp' :
    'Spread wide or volume thin - avoid scalping';
  
  return { canScalp, reasoning, avgRange, avgVolume };
}

/**
 * Calculate recent volatility
 */
function calculateRecentVolatility(bars, lookback) {
  if (!bars || bars.length < lookback + 1) {
    return { regime: 'UNKNOWN', value: 0 };
  }
  
  // Calculate returns
  const returns = [];
  for (let i = 0; i < lookback; i++) {
    const ret = (bars[i].close - bars[i + 1].close) / bars[i + 1].close;
    returns.push(Math.abs(ret));
  }
  
  // Average absolute return
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volPct = avgReturn * 100;
  
  const regime = volPct < 0.08 ? 'LOW_VOL' :
                 volPct < 0.15 ? 'MEDIUM_VOL' :
                 volPct < 0.25 ? 'HIGH_VOL' : 'SPIKE';
  
  return { regime, value: volPct };
}

// ============================================================================
// HELPER — Delta Divergence Detection
// ============================================================================

/**
 * Detect when price trend and order flow contradict each other.
 * e.g., price trending BULLISH but SELLING pressure in order flow = reversal warning.
 */
function detectDeltaDivergence(priceTrendDir, orderFlowSignal) {
  if (!priceTrendDir || priceTrendDir === 'NEUTRAL') return { divergent: false };
  if (!orderFlowSignal || orderFlowSignal === 'INSUFFICIENT_DATA' || orderFlowSignal === 'BALANCED') return { divergent: false };

  const flowBullish = orderFlowSignal.includes('BUYING');
  const flowBearish = orderFlowSignal.includes('SELLING');
  const trendBullish = priceTrendDir === 'BULLISH';

  const divergent = (trendBullish && flowBearish) || (!trendBullish && flowBullish);
  return { divergent, trendDir: priceTrendDir, flowSignal: orderFlowSignal };
}

// ============================================================================
// HELPER — Session VWAP (anchored at 8:30 CT session open)
// ============================================================================

/**
 * Compute VWAP anchored at today's 8:30 CT session open.
 * Returns null if fewer than 3 session bars are available.
 * @param {Array} bars5m - 5-minute bars, newest first, each with { time, high, low, close, volume }
 */
function calculateSessionVWAP(bars5m) {
  if (!bars5m || bars5m.length < 2) return null;

  // Determine session open timestamp for today (8:30 CT)
  const now = new Date();
  const isDST = now.getMonth() >= 2 && now.getMonth() <= 10; // approx Mar–Nov
  const ctOffsetHours = isDST ? 5 : 6;
  const ctNow = new Date(now.getTime() - ctOffsetHours * 3600000);
  const sessionOpenCT = new Date(ctNow);
  sessionOpenCT.setHours(8, 30, 0, 0);
  const sessionOpenMs = sessionOpenCT.getTime() + ctOffsetHours * 3600000; // back to UTC ms

  // Filter bars to session (bars are newest-first, time is start of bar)
  const sessionBars = bars5m.filter(b => b.time >= sessionOpenMs);
  if (sessionBars.length < 3) return null; // too few bars — fall back to rolling VWAP

  // Compute VWAP (volume-weighted typical price)
  let sumPV = 0, sumV = 0;
  for (const bar of sessionBars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    sumPV += tp * bar.volume;
    sumV  += bar.volume;
  }
  if (sumV <= 0) return null;

  const vwap = sumPV / sumV;
  const currentPrice = bars5m[0].close;
  const deviation = currentPrice - vwap;

  // Compute stdDev for z-score
  let sumSqDev = 0;
  for (const bar of sessionBars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    sumSqDev += Math.pow(tp - vwap, 2) * bar.volume;
  }
  const stdDev = Math.sqrt(sumSqDev / sumV);
  const zScore = stdDev > 0 ? deviation / stdDev : 0;

  // Session VWAP uses 1.5σ (vs 2σ for rolling VWAP) — stable anchor makes 1.5σ meaningful
  const signal = Math.abs(zScore) > 1.5       ? 'FADE_TO_VWAP' :
                 Math.abs(deviation / vwap) > 0.001 ? 'TREND_BIAS' : 'NEUTRAL';
  const bias = signal !== 'NEUTRAL' ? (currentPrice > vwap ? 'BEARISH' : 'BULLISH') : null;

  return {
    vwap,
    zScore,
    signal,
    bias,
    sessionBars: sessionBars.length,
    reasoning: `Session VWAP (${sessionBars.length} bars): price ${deviation > 0 ? '+' : ''}${deviation.toFixed(2)} from VWAP ${vwap.toFixed(2)} (${zScore.toFixed(1)}σ)`
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  calculateScalpingConfidence
};

console.log('[ScalpingEngine] ✅ Scalping intelligence engine loaded');
