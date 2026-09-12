# Meridian System v18.0.0

Autonomous futures scalping system for TopstepX (MES — Micro E-mini S&P 500).
Standalone Node.js. No Chrome extension. No proxy. No user interaction at runtime.

---

## Quick Start

```bash
npm install
node index.js
```

Press `Ctrl+C` to stop. Daily metrics (trades / wins / P&L) are printed on exit.

**Node.js version:** avoid 25 — `better-sqlite3` fails to compile. 18–22 LTS works. This project uses JSON file storage, so any modern version is fine in practice.

---

## Architecture

### 2-Path Hybrid Engine

**Path A — Momentum Scalp**
5-layer confidence ≥ dynamic base threshold (+ session phase adjustment) → tick-perfect limit entry with bracket SL/TP.

**Path B — VWAP Mean Reversion**
Price displaced ≥ 1σ from VWAP + no catalyst → fade back toward VWAP.

### Dynamic Base Threshold

Base threshold scales with available TICK data — prevents the TICK layer's 30-pt ceiling from silently blocking trades when 1s bars are sparse:

| TICK data source | Path A base | Path B base |
|---|---|---|
| 1s bars (≥ 60 bars) | 55 | 45 |
| Quote buffer (≥ 10 quotes) | 52 | 43 |
| No TICK data | 48 | 40 |

Session phase adjustments are added on top (e.g. MIDDAY_CHOP +15, OPEN_RUSH +10).

### Cycle Flow (every 10 seconds)

```
1.  Catalyst gate     → skip if HIGH-impact news ±30 min
2.  Session gate      → skip PRE_MARKET / AFTER_HOURS (CT)
3.  Fetch bars        → 1s / 1m / 5m / 15m via curl
4.  Realized σ        → vol regime + vol-proportional stop sizing
5.  Live quote        → SignalR bid/ask snapshot (null if disconnected)
6.  Quote buffer      → rolling 300-quote window for order flow + spread trend
7.  Macro context     → regime + COT signal (1-hour cache)
8.  Cross-asset       → NQ/Gold/BTC/Oil divergence signals
9.  Futures context   → basis / delta / price discovery (each cycle)
10. Confidence score  → 5-layer 0–100 score
11. Path A check      → confidence ≥ dynamic base + phase adjustment
12. Path B check      → VWAP displaced ≥ 1σ, confidence ≥ dynamic base B
```

### 5-Layer Confidence Scorer

| Layer | Max Pts | Notes |
|---|---|---|
| MACRO | 15 (+3 COT) | Passive flow regime + COT dealer percentile |
| FUTURES | 25 | Basis arbitrage + delta imbalance + price discovery |
| MICRO | 25 | 5m/15m trend strength + alignment + volume |
| TICK | 30 | Order flow, momentum, acceleration + live spread score |
| EXECUTION | 18 | Vol regime (5) + VWAP alignment (8) + spread (5) |
| CONVERGENCE | +10 bonus | Fast signals ≥ 75% agree on direction |

**Direction vote — 9 signals total:**
- Fast (5): 5m trend, 15m trend, futures delta, tick order flow, tick momentum
- Slow / tiebreaker (4): COT dealer, VIX trend, NQ divergence, risk sentiment composite

Macro/CA signals break ties when TICK bars are absent; they don't inflate the convergence bonus (which uses fast signals only).

### Vol-Proportional Stops (MES, tick = $1.25)

| Regime | σ range | Stop ticks | Target ticks |
|---|---|---|---|
| LOW | < 0.15% | 2–3 | 4–6 |
| MEDIUM | 0.15–0.4% | 3–5 | 6–10 |
| HIGH | 0.4–0.8% | 5–8 | 10–16 |
| SPIKE | > 0.8% | ≤ 10 | ≤ 20 |

### Session Trading Windows (CT)

| Phase | Time (CT) | Threshold Adj | Status |
|---|---|---|---|
| PRE_MARKET | before 8:30 | +99 (blocked) | no trading |
| OPEN_RUSH | 8:30–9:30 | +10 | volatile |
| MIDMORNING | 9:30–11:00 | 0 | **prime window** |
| MIDDAY_CHOP | 11:00–13:00 | +15 | require stronger signal |
| CLOSE_RUSH | 13:00–14:45 | 0 | **prime window** |
| AFTER_HOURS | after 14:45 | +99 (blocked) | 3:45 PM ET cutoff |

---

## File Map

```
Meridian-system/
├── index.js                     Entry point — auth → account → contract → loop
├── config.js                    Credentials (from env vars) + trading constants
│
├── src/
│   ├── api/
│   │   ├── topstepx.js          REST client (curl/execSync — not node-fetch)
│   │   ├── claude.js            Anthropic API client
│   │   └── quote-stream.js      SignalR live quotes + 300-quote rolling buffer
│   │
│   ├── auth/
│   │   └── browser-login.js     Puppeteer login (handles errorCode 7)
│   │
│   ├── engine/
│   │   ├── automation.js        MAIN LOOP — Path A + Path B, all decisions
│   │   ├── scalping-intelligence.js  5-layer scorer + 9-signal direction vote
│   │   ├── macro-context.js     Regime + passive flow calendar + COT + live VIX
│   │   ├── futures-mechanics.js Basis (live SPX) + delta + price discovery + 0DTE
│   │   ├── tick-precision.js    1s bars OR quote buffer → order flow + momentum
│   │   ├── cross-asset.js       NQ / Gold / BTC / Oil divergence (Yahoo Finance)
│   │   ├── realized-volatility.js    σ, vol regime, vol-proportional stops
│   │   ├── intraday-cycle.js    CT session phase → threshold + volume expectation
│   │   ├── catalyst-filter.js   Economic calendar gate (faireconomy.media, 4hr cache)
│   │   └── cot-data.js          CFTC COT dealer positioning (52-week, 7-day cache)
│   │
│   ├── storage/
│   │   └── db.js                JSON file storage (settings / summaries / trades)
│   │
│   └── backtesting/
│       └── backtest.js          MICRO+CA replay backtester
│
├── data/                        Auto-created at runtime
│   ├── settings.json            Session token, contract, account ID
│   ├── summaries.json           Cached daily summaries
│   └── trades.json              Trade history (used for win-rate-by-phase logging)
│
└── learning-data/               Persistent pattern storage (JSON, grows over time)
    ├── general-knowledge.json
    ├── macro-events.json
    └── time-based.json
```

---

## Configuration (`config.js`)

Credentials are read from environment variables: `TOPSTEPX_USERNAME`, `TOPSTEPX_ALT_USERNAME`,
`TOPSTEPX_PASSWORD`, `TOPSTEPX_API_KEY`, `ANTHROPIC_API_KEY`.

FinBERT weights are not committed (too large for GitHub). Download `pytorch_model.bin` from
[ProsusAI/finbert](https://huggingface.co/ProsusAI/finbert) into `model/finbert/`, then run
`node model/finbert/convert.js` to produce `model/finbert/onnx/model.onnx`.

| Setting | Value |
|---|---|
| Contract | CON.F.US.MES.H26 (auto-rolls per ROLLOVER_SCHEDULE in index.js) |
| Tick size | 0.25 pts |
| Tick value | $1.25 |
| Loop frequency | 10 s |
| Max daily trades | 10 |
| Max daily loss | $500 |
| Catalyst pre-window | 30 min |
| Catalyst post-window | 15 min |
| COT cache TTL | 7 days |
| Calendar cache TTL | 4 hours |
| Macro context refresh | 1 hour |

---

## Known Gotchas

- **Auth errorCode 7** — pending TopstepX agreements; `browser-login.js` handles this automatically via Puppeteer
- **`confidence` is a string** — `calculateScalpingConfidence()` returns `confidence` as a string; always `parseFloat()`
- **Use curl, not fetch** — all TopstepX API calls use `execSync`/curl; `node-fetch` has auth issues
- **VIX/rates** — VIX is fetched live from Yahoo Finance (1-hour cache). Fed rate hardcoded at 4.50% in `macro-context.js`
- **Contract rollover** — MES H26 → M26 on March 16 2026. `index.js` auto-selects via ROLLOVER_SCHEDULE; `config.trading.defaultContractId` is a fallback only

---

## Testing Commands

```bash
# Module load check (offline)
node -e "require('./src/api/quote-stream'); require('./src/engine/tick-precision'); require('./src/engine/scalping-intelligence'); require('./src/engine/automation'); console.log('All modules load OK')"

# DB round-trip
node -e "const db=require('./src/storage/db'); db.setSetting('test','ok'); console.log(db.getSetting('test'))"

# Auth
npm run test:auth

# Session phase (current CT time)
node -e "const ic=require('./src/engine/intraday-cycle'); console.log(ic.getCycleContext())"

# Realized vol + stop sizing
node -e "
const rv=require('./src/engine/realized-volatility');
const bars=Array.from({length:25},(_,i)=>({close:5900+Math.random()*20}));
const s=rv.computeRealizedVol(bars);
console.log('sigma:', s.toFixed(5), '| regime:', rv.classifyVolRegime(s), '| stops:', rv.volProportionalStops(s,5900));
"

# Catalyst gate (live)
node -e "require('./src/engine/catalyst-filter').isCatalystWindow(30).then(console.log)"

# COT dealer signal (live, 7-day cache)
node -e "require('./src/engine/cot-data').getDealerNetPosition().then(console.log)"

# Cross-asset signals (live)
node -e "require('./src/engine/cross-asset').getCrossAssetContext([]).then(r=>console.log(r.nqDivergence.signal, r.riskSentiment.label))"

# Quote buffer — run during market hours
node -e "
const qs=require('./src/api/quote-stream');
const db=require('./src/storage/db');
(async()=>{
  const tok=db.getSetting('sessionToken');
  const cid=db.getSetting('selectedContractId')||'CON.F.US.MES.H26';
  await qs.start(cid, tok);
  await new Promise(r=>setTimeout(r,15000));
  const buf=qs.getQuoteBuffer();
  console.log('Buffer size:', buf.length, '| Sample:', buf[0]);
  qs.stop();
})();
"

# Backtest (MICRO + CA layers, 2000 bars)
npm run backtest

# Full system
node index.js
```

---

## Expected Cycle Log (healthy run)

```
[Automation] Threshold: 55 (base 55 — TICK-bars + phase 0)
[Scalping] Regime:PASSIVE | D:NEUTRAL | σ=0.002%(MED) | Phase:MIDMOR
         | Basis:FAIR | Delta:NEUTRAL | NQ:NQ_LEA Risk:BULLISH
         | Conf:62.3(B+) | Dir:LONG | Signal:YES | Day: 0T 0.0% $0.00
[Automation] ✅ PATH A: Momentum scalp (confidence=62.3 ≥ 55)

# When 1s bars absent but quote buffer has data:
[Automation] Threshold: 52 (base 52 — quote-buffer + phase 0)

# When no TICK data at all:
[Automation] Threshold: 48 (base 48 — no-tick + phase 0)
```

---

## Changelog

### v18.0.0 — 2026-02 (current)

- Complete rewrite: Chrome extension → standalone Node.js
- 5-layer confidence scorer (MACRO + FUTURES + MICRO + TICK + EXECUTION)
- 2-path hybrid engine (momentum scalp + VWAP mean reversion)
- Live VIX feed (Yahoo Finance, 1-hour cache)
- Live SPX spot for real futures basis (Yahoo Finance)
- COT dealer positioning (CFTC Socrata, 52-week history, 7-day cache)
- Cross-asset engine: NQ / Gold / BTC / Oil divergence signals
- Economic calendar hard gate (catalyst-filter.js)
- CT session phase gating + volume normalization (intraday-cycle.js)
- Vol-proportional stops via realized-volatility.js
- SignalR live quote stream + 300-quote rolling buffer
- Lee-Ready order flow classification from quote buffer (tick fallback)
- Spread trend scoring (TIGHTENING / STABLE / WIDENING)
- 9-signal direction vote: 5 fast (micro+tick) + 4 slow (macro/CA) tiebreakers
- Dynamic base threshold: 55 / 52 / 48 based on TICK data availability
- 0DTE gamma scoring (+3 pts during 3pm–4pm window)
- Daily trade count + loss limits enforced in automation loop
- Position time-based exit: market order via closePosition()
- SignalR token auto-refresh (JWT expiry decode + reconnect per cycle)
- Auto contract rollover (ROLLOVER_SCHEDULE in index.js)
- Trade history win-rate-by-phase logging (daily reset feedback loop)
- JSON file storage replacing IndexedDB (no SQLite dependency)
- Puppeteer browser login for errorCode 7 / pending agreements
- MICRO+CA replay backtester (backtest.js)
