# Development Status — Meridian System v18.6.0

> **Last updated:** 2026-02-22
> **Run:** `node index.js`

---

## What This Is

Standalone Node.js autonomous futures scalping system for TopstepX (MES/ES).
No browser extension. No proxy. No runtime user interaction.

**Engine:** 2-path hybrid (momentum scalp + VWAP mean reversion) over a 5-layer confidence scorer (0–100 pts).
**NLP:** FinBERT TRC2 (ONNX, 30ms/text) classifies economic events for directional bias and post-event penalty decay.

---

## Layer Architecture

```
MACRO (15+3 pts)    macro-context.js        Passive flow regime + live VIX + COT dealer alignment (±3 pts)
FUTURES (10+15 pts) futures-mechanics.js    Delta imbalance (10) — direction-aware post-vote:
                                              Basis ±7/−3 (aligned tailwind vs headwind)
                                              Price discovery +8 (only when magnitude aligns with direction)
                                              0DTE gamma +3 (Wed/Fri 3–4pm, direction set)
MICRO (25 pts)      scalping-intelligence   5m/15m trend strength + alignment + phase-normalized volume
TICK (30+5 pts)     tick-precision.js       Order flow + momentum + spread scoring
                                            Delta divergence −5 (trend vs flow contradict)
                                            POC proximity +1/+3; key tick level +2
                                            Source priority: 1s bars → quote buffer → insufficient
EXECUTION (18 pts)  scalping-intelligence   Vol regime (5) + VWAP alignment (8) + live spread (5)
CONVERGENCE (+10)   scalping-intelligence   ≥75% of fast signals agree on direction (bonus)

CROSS_ASSET         cross-asset.js          NQ divergence (±8 pts) + risk sentiment (±6 pts)
                                            Applied after direction known; not part of base scorer ceiling

CATALYST            catalyst-filter.js      Post-event per-layer score reductions (MACRO/TICK/FUTURES/MICRO)
                                            Applied inside SI after direction known.
                                            Aligned bias bonus: +3 when trade direction matches event bias
                                            (e.g., LONG after bullish NFP print → tailwind)
```

**Direction vote (9 signals):**
- Fast (5): 5m trend, 15m trend, futures delta, tick order flow, tick momentum
- Slow / tiebreaker (4): COT dealer, VIX trend, NQ divergence, risk sentiment composite
- Convergence bonus uses fast signals only (prevents slow macro signals from inflating the bonus)

**Stop/target:** vol-proportional via `realized-volatility.js`
- LOW σ  → 2–3t stop / 4–6t target
- MEDIUM → 3–5t stop / 6–10t target
- HIGH   → 5–8t stop / 10–16t target

---

## Cycle Flow (`automation.js → runScalpingCycle`)

```
1.  Catalyst gate      → catalyst-filter.js           hard block pre-event; decayed penalty post-event
                                                        catalystContext passed into calculateScalpingConfidence
2.  Session gate       → intraday-cycle.js             skip PRE_MARKET / AFTER_HOURS (CT)
3.  Fetch bars         → topstepx.fetchBars()          1s/1m/5m/15m, newest-first
4.  Realized σ         → realized-volatility.computeRealizedVol(bars5m)
5.  Live quote         → quote-stream.getLatestQuote() null if disconnected
6.  Quote buffer       → quote-stream.getQuoteBuffer() up to 300 quotes, 60s window
7.  Macro context      → macro-context.getMacroContext() 1-hour cache
8.  Cross-asset        → cross-asset.getCrossAssetContext(bars5m)
9.  Session bar delta  → computeSessionBarDelta(bars5m)  ← moved before confidence
10. Confidence score   → scalping-intelligence.calculateScalpingConfidence()
11. RV/IV ratio        → realized-volatility.computeRVIVRatio(sigma, vix)
12. cycleSnapshot      → captured for tradeContext (all context refs for entry logging)
13. Dynamic threshold  → 55/52/48 (A) or 45/43/40 (B) + RV/IV ±3 + adaptive ±3 + session phase
14. Path A check       → confidence ≥ adjusted threshold + direction set
15. Path B check       → session VWAP ≥1σ displaced, confidence ≥ Path B threshold
```

---

## Dynamic Threshold Logic

```
tickBarsAvailable  = bars['1s'] && bars['1s'].length >= 60
quoteBufferUsable  = quoteBuffer.length >= 10

scaledBase A: tickBarsAvailable ? 55 : quoteBufferUsable ? 52 : 48
scaledBase B: tickBarsAvailable ? 45 : quoteBufferUsable ? 43 : 40

RV/IV regime (computeRVIVRatio) — base ±3:
  TRENDING (ratio > 1.3): Path A −3, Path B +3   — momentum favored
  RANGING  (ratio < 0.7): Path A +3, Path B −3   — mean reversion favored
  NEUTRAL  (0.7–1.3):     no adjustment

Adaptive regime adjustment (from db.getAdaptiveRegimeAdjustments, loaded at day reset):
  win rate < 40% in regime → +3 more (raise barrier)
  win rate > 60% in regime → -3 more (lower barrier)
  Combined bound: ±6 total for RV/IV adj

Smoothing: rvivHistory (last 5 readings) — only shift regime when ≥3 agree

Catalyst penalty — handled inside ScalpingIntelligence (not on threshold):
  catalystContext passed via hybridCtx → CATALYST layer applies per-layer score reductions
  after direction is known; aligned bias adds +3 when trade follows event signal.

pathABase = scaledBase A + rvivAdjA
pathBBase = scaledBase B + rvivAdjB
adjustedThreshold = pathABase + cycleContext.thresholdAdjustment (session phase)
```

Log lines each cycle:
```
[Automation] ⚠️  POST-EVENT: [INFLATION_TIER1] CPI m/m 14m ago → BEARISH (−18pts, surprise=+0.034)
[Automation] 📅 Next: [EMPLOYMENT_TIER1] Non-Farm Employment Change in 47m
[Automation] RV/IV: 0.94 raw=NEUTRAL smoothed=NEUTRAL (3/5 readings)
[Automation] Threshold: 55 (base 55 — TICK-bars + phase +0 + RV/IV NEUTRAL/0 cat[BEARISH])
[Automation] 🔄 PATH B: VWAP reversion — SHORT (1.4σ displaced from session VWAP)
[Automation] Scalp Result: { outcome: 'WIN', path: 'A', regime: 'NEUTRAL', ... }
```

---

## Catalyst Filter v2 — Event Taxonomy

12 categories with individually calibrated pre/post windows and decay half-lives.
FinBERT TRC2 classifies event title → journalism tone → equity direction via per-category rule.

| Category | Pre | Post | Decay½ | Max penalty | Direction rule |
|---|---|---|---|---|---|
| FED_DECISION | 60m | 90m | 120m | −30 | HAWKISH_INVERSE |
| FED_SPEAKER | 30m | 45m | 60m | −15 | HAWKISH_INVERSE |
| INFLATION_TIER1 (CPI/PCE) | 30m | 60m | 60m | −25 | INVERSE |
| INFLATION_TIER2 (PPI) | 20m | 30m | 30m | −12 | INVERSE |
| EMPLOYMENT_TIER1 (NFP) | 30m | 45m | 45m | −22 | DIRECT |
| EMPLOYMENT_TIER2 (ADP/Claims) | 20m | 25m | 25m | −10 | DIRECT |
| GROWTH (GDP/Retail) | 20m | 30m | 30m | −15 | DIRECT |
| MANUFACTURING / SERVICES | 15m | 20m | 20m | −8 | DIRECT |
| CONSUMER | 15m | 20m | 20m | −6 | DIRECT |
| HOUSING | 10m | 15m | 15m | −5 | DIRECT |
| TREASURY | 10m | 15m | 15m | −5 | NEUTRAL |
| UNKNOWN_HIGH | 30m | 30m | 30m | −15 | NEUTRAL |

**Direction rules (FinBERT tone → ES price direction):**
- `DIRECT`: positive journalism tone → BULLISH (jobs, growth, consumer)
- `INVERSE`: positive journalism tone → BEARISH (hot inflation = hawkish = ES bearish)
- `HAWKISH_INVERSE`: confident/hawkish Fed language → BEARISH
- `NEUTRAL`: no directional inference (treasury, minute releases)

**Surprise factor:** `(actual − forecast) / |forecast|`, clamped [-1, 1].
Amplifies post-event penalty by up to 1.5× when release significantly surprises.

**Decay parameters are domain-knowledge starting points.** Empirical calibration
(fit to your own trade win-rate recovery curves post-event) should replace them once
you have 20+ trades per category.

---

## FinBERT TRC2

- **Model:** `BertForSequenceClassification`, BERT-base-uncased, fine-tuned on Thomson Reuters TRC2 corpus
- **Labels:** positive / negative / neutral (financial journalism tone)
- **Inference:** `onnxruntime-node`, 30ms/text, zero Python at runtime
- **Location:** `model/finbert/onnx/model.onnx` (418MB ONNX); source weights `model/finbert/pytorch_model.bin`
- **WordPiece tokenizer:** implemented in JS from `model/finbert/vocab.txt` (30,522 tokens)
- **Warmup:** call `finbert.warmup()` at startup to avoid cold-start latency on first catalyst event
- **Tone vs. direction:** FinBERT output is NOT used raw as a trade signal. It feeds
  `resolveDirectionBias(sentiment, directionRule)` which applies the DIRECT/INVERSE/HAWKISH_INVERSE
  translation per event category. "CPI surges" → positive tone + INVERSE rule → BEARISH bias.

---

## False-Negative Analysis (v18.5.0)

Three analytics functions in `db.js` for pre-live calibration:

```js
db.getNearMissProfile()      // breakdown by session/regime/gap bucket
db.getPassedScalpProfile()   // breakdown by reason/grade/confidence bucket
db.getFalseNegativeRate(5)   // estimates % of near-misses that would have won
                             // joins near-miss context to trade win rates
                             // returns estimatedFalseNegativeRate, hasEnoughData
```

---

## Known Working (live-tested)

| Component | Status | Notes |
|---|---|---|
| `node index.js` startup | ✅ | Auth → account → contract → loop |
| JSON storage | ✅ | settings / summaries / trades all working |
| TopstepX REST auth | ✅ | API key auth works; errorCode 7 handled by Puppeteer |
| Bar fetching + normalization | ✅ | 1s/1m/5m/15m, t/o/h/l/c/v fields correct |
| All engine modules load | ✅ | No import errors |
| realized-volatility.js | ✅ | σ, vol-proportional stops, computeRVIVRatio |
| intraday-cycle.js | ✅ | MIDDAY_CHOP +15 threshold confirmed |
| catalyst-filter.js v2 | ✅ | 12-category taxonomy; FinBERT direction bias; surprise factor; exponential decay |
| FinBERT TRC2 ONNX | ✅ | 30ms/text; ONNX session loads clean; 14/14 taxonomy patterns pass |
| cot-data.js | ✅ | Live CFTC fetch — 52-week history, dealer percentile |
| quote-stream.js SignalR | ✅ | GatewayQuote(contractId, data), bestBid/bestAsk confirmed live |
| Quote buffer | ✅ | 300-quote rolling buffer, getQuoteBuffer() exports correctly |
| Lee-Ready order flow | ✅ | calculateOrderFlowFromQuotes() — unit tested |
| Spread trend scoring | ✅ | calculateSpreadTrend() — TIGHTENING/STABLE/WIDENING confirmed |
| Dynamic threshold | ✅ | 55/52/48 + RV/IV + session; clean (no penalty on threshold) |
| Catalyst v2 full integration (v18.6.0) | ✅ | Per-layer penalties inside SI; aligned bias +3 bonus wired |
| 9-signal direction vote | ✅ | COT/VIX/NQ/risk-sentiment tiebreakers in scalping-intelligence |
| Convergence uses fast signals only | ✅ | Macro/CA excluded from convergence bonus calc |
| Hybrid engine pipeline | ✅ | Live cycles running — 29–69 pt scores observed |
| RV/IV ratio + path bias | ✅ | computeRVIVRatio; ±3 threshold adj for Path A/B |
| Direction-aware FUTURES scoring | ✅ | Basis ±7/−3; price discovery +8 only when aligned |
| Session VWAP for Path B | ✅ | Anchored at 8:30 CT; Path B prefers over rolling 12-bar |
| Daily trade/loss limits | ✅ | maxDailyTrades=30, maxDailyLoss=$200 enforced |
| Contract rollover | ✅ | ROLLOVER_SCHEDULE auto-selects front month; 7/7 date tests pass |
| Cross-asset engine | ✅ | NQ, Gold, BTC, Oil wired into CROSS_ASSET scoring layer |
| Backtesting | ✅ | `npm run backtest` — MICRO+CA replay, win-rate-by-bucket table |
| Break-even + trail stop | ✅ | BE at +1R; trail activates at +1.5R; only tightens |
| MFE / MAE tracking | ✅ | max_favorable_excursion / max_adverse_excursion per trade |
| exit_reason | ✅ | SL / TP / TIME / TRAIL / BREAKEVEN_STOP |
| Adaptive regime calibration | ✅ | getAdaptiveRegimeAdjustments(30); loaded at day reset |
| Safety & Recovery (v18.3.0) | ✅ | Cycle guard, streak breaker, spread gate, position recovery, near-miss logging |
| Learning analytics | ✅ | getWinRateByRegime/ByPath/ByConfidenceBucket/ByExitReason/getSignalReliability |
| False-negative analysis (v18.5.0) | ✅ | getNearMissProfile, getPassedScalpProfile, getFalseNegativeRate — 83 unit tests |
| hasOpenOrder force-clear failsafe | ✅ | automation.js:913–923 — force-clears state after fill timeout regardless of cancel API result |

---

## Outstanding / Next Steps

### Future — Empirical decay calibration

Once 20+ trades exist per catalyst category, replace hardcoded `decayHalf` values with empirically fitted
half-lives from your own win-rate recovery curves post-event. The shape (exponential) is correct;
the parameters will improve with data.

### Future — Overnight / Globex session support

Session gate is a hard clock gate (blocks before 8:30 CT and after 14:45 CT / 3:45 PM ET). Globex trades from
~17:00 CT Sunday. Extending to overnight would require new PHASES in `intraday-cycle.js` plus
calibration of thresholds for lower-liquidity conditions. Spread gate (>0.50) would provide
natural liquidity filtering.

### Contract rollover — action required March 16, 2026

MES H26 rolls to M26. `index.js` auto-selects via ROLLOVER_SCHEDULE. `config.js` fallback:
```javascript
defaultContractId: 'CON.F.US.MES.M26'
```

---

## Quick Verification

```bash
# Module load (offline)
node -e "require('./src/storage/db'); require('./src/engine/catalyst-filter'); require('./src/engine/finbert'); require('./src/engine/automation'); console.log('OK')"

# FinBERT inference smoke test
node -e "
require('./src/engine/finbert').classify('Non-Farm Payrolls beat expectations').then(r => {
  console.log('FinBERT:', r.sentiment, r.confidence);
});
"

# Catalyst v2 — taxonomy + live calendar
node -e "
const CF = require('./src/engine/catalyst-filter');
console.log('FED_DECISION:', CF.classifyEvent('Federal Reserve Interest Rate Decision').category);
console.log('CPI:', CF.classifyEvent('CPI m/m').category);
CF.isCatalystWindow(30).then(r => console.log('gate:', r.blocked ? 'BLOCKED' : 'clear', '| penalty:', r.penalty));
"

# False-negative analysis
node -e "
const db = require('./src/storage/db');
console.log('nearMissProfile:', db.getNearMissProfile());
console.log('falseNegRate:', db.getFalseNegativeRate(5));
"

# Unit tests (83 tests, all offline)
npm run test:unit

# Session phase
node -e "const ic=require('./src/engine/intraday-cycle'); console.log(ic.getCycleContext())"

# COT (live, cached 7d)
node -e "require('./src/engine/cot-data').getDealerNetPosition().then(console.log)"

# Cross-asset (live)
node -e "require('./src/engine/cross-asset').getCrossAssetContext([]).then(r=>console.log(r.nqDivergence.signal, r.riskSentiment.label))"

# Backtest
npm run backtest

# Full system
node index.js
```

---

## Session Trading Windows (CT)

| Phase | Time (CT) | Threshold Adj | Notes |
|---|---|---|---|
| PRE_MARKET | before 8:30 | +99 (blocked) | |
| OPEN_RUSH | 8:30–9:30 | +10 | volatile, wider stops |
| MIDMORNING | 9:30–11:00 | 0 | **prime window** |
| MIDDAY_CHOP | 11:00–13:00 | +15 | require stronger signal |
| CLOSE_RUSH | 13:00–14:45 | 0 | **prime window** |
| AFTER_HOURS | after 14:45 | +99 (blocked) | 3:45 PM ET cutoff |

---

## File Map

```
index.js                         startup: auth → accounts → contracts → automation loop
config.js                        ALL credentials hardcoded here

src/engine/
  automation.js       1509 loc   10s cycle loop: catalyst → session → bars → confidence → paths
  scalping-intelligence.js 955   5-layer + CATALYST confidence scorer; 9-signal direction vote
  catalyst-filter.js   405       v2: 12-category taxonomy + FinBERT + surprise + exponential decay
  finbert.js           213       FinBERT TRC2 ONNX: WordPiece tokenizer + onnxruntime-node
  macro-context.js     869       macro regime + COT + live VIX + passive flow calendar
  futures-mechanics.js 528       basis (live SPX) + delta + price discovery + 0DTE
  tick-precision.js    768       order flow from 1s bars OR quote buffer (Lee-Ready)
  cross-asset.js       520       NQ, Gold, BTC, Oil via Yahoo; CROSS_ASSET scoring layer
  realized-volatility.js 163     σ from log returns; vol regime; vol-proportional stops; RV/IV ratio
  intraday-cycle.js    142       CT session phase → threshold adjustment
  cot-data.js          138       CFTC weekly COT dealer positioning (7-day cache)

src/api/
  topstepx.js          483       REST client (curl via execSync — not fetch)
  quote-stream.js      184       SignalR live bid/ask + 300-quote rolling buffer
  claude.js             65       Anthropic API client

src/storage/
  db.js                781       JSON storage; analytics; false-negative analysis

src/auth/
  browser-login.js               Puppeteer login for errorCode 7 (pending agreements)

src/backtesting/
  backtest.js                    MICRO+CA replay backtester

model/finbert/
  pytorch_model.bin    418MB     TRC2 source weights (PyTorch pickle)
  onnx/model.onnx      418MB     converted ONNX — this is what runs at inference time
  vocab.txt            226KB     30,522-token BERT vocabulary
  config.json                    BertForSequenceClassification, 3 labels
  convert.js                     one-time ONNX conversion script (node model/finbert/convert.js)

data/
  trades.json                    trade history (~50 fields per record)
  near-misses.json               500-entry ring (cycles within 10pts of threshold)
  passed-scalps.json             200-entry ring (setups blocked after confidence cleared)
  settings.json                  session token, contract, VIX history, economic calendar cache

test/
  unit.js                        83-test offline suite (npm run test:unit)
```
