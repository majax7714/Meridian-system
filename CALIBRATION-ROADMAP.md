# Calibration Roadmap — Pre-Live Parameter Validation
> **Created:** 2026-02-22
> **Scope:** Two pre-live data initiatives to ground-truth engine parameters before 50+ live trades accumulate.

---

## Why This Document Exists

The v18.6.0 engine has sound architecture but nearly every numerical parameter was set by
domain-knowledge intuition: decay half-lives, layer weights, confidence thresholds, convergence
ratios. These priors are reasonable starting points — they are not validated facts.

Two initiatives can replace intuition with published evidence and empirical fits before the system
has generated its own trade history. They are not a substitute for live data; they are a way to
enter live trading with better priors so the adaptive loops converge faster.

---

## Initiative A — Catalyst Decay Empirical Fitting

### What We're Solving

`catalyst-filter.js` uses 12 `decayHalf` values (15–120 minutes) that model how quickly the
market absorbs post-event noise. These were set by judgment:

```js
{ category: 'FED_DECISION',    decayHalf: 120, maxPenalty: 30 }
{ category: 'INFLATION_TIER1', decayHalf: 60,  maxPenalty: 25 }
{ category: 'EMPLOYMENT_TIER1',decayHalf: 45,  maxPenalty: 22 }
// ... etc
```

If FED_DECISION actually absorbs in 60 minutes not 120, we are blocking 60 extra minutes of
trading per FOMC day — at 8 per year that is ~8 hours of needlessly blocked time annually.
If CPI absorbs in 90 minutes not 60, we are entering too early during elevated noise.

### Data Sources

| Source | Content | Access |
|---|---|---|
| FRED API (free) | Historical economic releases — actuals, forecasts, previous | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL` |
| Econoday / faireconomy.media | Calendar history with surprise values | Already used by catalyst-filter.js |
| Yahoo Finance 5m historical | ES front-month (^GSPC or ES=F) at 5m resolution | Max 60 days per request; chain requests for multi-year history |
| CME Group settlement prices | ES daily OHLCV | Public, free via quandl/stooq |

### Methodology

For each event category, across all events in 2022–2025:

```
1. Define baseline σ: realized vol in the 60 minutes BEFORE the event (pre-window)
2. Measure σ in post-event windows: [0-5m], [5-15m], [15-30m], [30-60m], [60-90m], [90-120m]
3. Normalize each window: σ_window / σ_baseline = "noise ratio"
4. Fit the decay curve: noise_ratio(t) = 1 + A × exp(-λ × t)
5. Solve for λ: half-life = ln(2) / λ
6. Average across all events in the category (weighted by |surprise|)
```

**Surprise-stratified fit:** Run once for high-surprise events (|surprise| > 0.3) and once for
low-surprise events (|surprise| < 0.1). The difference tells you whether the current
`surpriseMultiplier` (1.0–1.5×) is calibrated correctly.

### Deliverable

A revised TAXONOMY block with empirically fitted `decayHalf` values, alongside confidence
intervals showing the range across events. Example output format:

```
FED_DECISION:     observed half-life 87m (±24m), current: 120m → REVISE DOWN to 90m
INFLATION_TIER1:  observed half-life 52m (±18m), current: 60m  → KEEP
EMPLOYMENT_TIER1: observed half-life 31m (±12m), current: 45m  → REVISE DOWN to 30m
```

### Implementation Plan

**Phase 1 — Data collection script** (`tools/fetch-catalyst-history.js`)
- Pull FRED series for CPI (CPIAUCSL), PCE (PCEPI), NFP (PAYEMS), GDP (GDP) with release dates
- Pull ES 5m bars from Yahoo Finance for each event date ±2 hours
- Save to `data/calibration/events-{category}.json`

**Phase 2 — Decay fitting script** (`tools/fit-decay-curves.js`)
- For each event, compute pre-window σ baseline and post-window σ ratios
- Fit exponential via least-squares (simple gradient descent or closed-form)
- Output fitted `decayHalf` per category with confidence interval

**Phase 3 — Apply to catalyst-filter.js**
- Replace hardcoded values with fitted values
- Add comment with data source and fit date so future revisions are traceable

**Estimated build time:** 1 session (data collection is the longest part — Yahoo rate limits 5m
history to ~60-day windows so ES history requires chained requests)

### Expected Impact

If the current `decayHalf` values are off by 1.5–2×, correcting them could:
- Unlock 30–60 additional tradeable minutes per major event week
- Reduce false-negative rate (near-misses that were blocked unnecessarily)
- Improve post-event trade quality (current entries may still be in noise zone)

---

## Initiative B — Academic Literature Synthesis

### What We're Solving

Several engine parameters were set without reference to published findings that directly measure
what we're trying to estimate. Academic finance has decades of data on ES/SPY intraday behavior
around scheduled macro events.

### Key Literature and Findings

#### B1. FOMC Pre-Announcement Drift

**Lucca & Moench (2015)** — "The Pre-FOMC Announcement Drift" (Journal of Finance)
- ES/SPY gains an average of ~50 basis points in the 24 hours *before* FOMC announcements
- Effect is concentrated in the period starting ~3pm ET the day before
- Implication for this system:
  - The pre-event `preWindow: 60m` for FED_DECISION might be too conservative
  - The drift is *before* the announcement — our hard block may be preventing legitimate
    pre-FOMC momentum trades in the 2–4 hour window before, not just the final 60m
  - Consider: `preWindow: 30m` hard block + a FOMC_PRE_DRIFT signal that adds to BULLISH
    direction bias in the 4h window before (long-only tilt)

**Parameter implication:** `FED_DECISION.preWindow` from 60m → 30m hard block,
with optional FOMC pre-drift signal (new direction signal, not a gate)

#### B2. Post-NFP Announcement Drift

**Savor & Wilson (2013)** — "Risk and Return in Equilibrium" (AFA)
- Markets earn statistically significant excess returns on FOMC, CPI, and employment
  announcement days vs non-announcement days (Sharpe ratio ~3× higher)
- The post-announcement price discovery period for NFP is approximately 20–40 minutes
- Returns after the first 40 minutes post-NFP revert toward random walk behavior

**Parameter implication:**
- `EMPLOYMENT_TIER1.decayHalf: 45m` → consistent with literature (20–40m discovery period)
- `EMPLOYMENT_TIER1.postWindow: 45m` is borderline — extending to 60m post would be
  conservative but better covers the full discovery window

#### B3. CPI / Inflation Announcement Behavior

**Gürkaynak, Sack & Swanson (2005)** — asset pricing around FOMC + macro releases
- CPI surprises produce immediate, persistent price moves in equities and bonds
- The volatility clustering after CPI persists 45–75 minutes on average
- Hot inflation prints (positive surprise for CPI = bearish for ES) show stronger
  persistence than cold prints — asymmetric effect

**Parameter implication:**
- `INFLATION_TIER1.decayHalf: 60m` → directionally correct; hot surprise warrants longer decay
- Current `surpriseMultiplier` (1.0–1.5×) may be too weak for hot inflation — consider 1.0–2.0×
  for INVERSE category events since the effect is asymmetric and stronger on beats

#### B4. VIX Mean Reversion Speed

**Whaley (2009)** — "Understanding the VIX" (Journal of Portfolio Management)
- VIX spikes (>5pt single-day moves) revert with a half-life of approximately 3–5 trading days
- Implication: single-session VIX spikes don't persist into next session meaningfully
- Our VIX rolling slope (last 3 readings, 1-hour updates) is measuring intraday VIX change —
  appropriate; the multi-day reversion is not relevant at the scalping timeframe

**Parameter implication:** VIX slope threshold (>0.3 RISING, <-0.3 FALLING) is reasonable;
no change needed

#### B5. Realized vs Implied Vol Premium

**Carr & Wu (2008)** — "Variance Risk Premiums" (Review of Financial Studies)
- Implied vol (VIX) systematically exceeds realized vol by ~3–5 vol points on average
- This implies the RV/IV ratio is structurally biased below 1.0 in normal markets
- Current cutoffs: RANGING (ratio < 0.7), TRENDING (ratio > 1.3)

**Parameter implication:**
- The systematic IV > RV premium means our RANGING threshold (< 0.7) may fire too rarely
- Consider: RANGING when ratio < 0.8 (accounting for the 3–5pt structural premium)
- This would classify more environments as RANGING, making Path B (mean reversion) active more often
- This is the most actionable finding from the literature for this engine

#### B6. Intraday Patterns in ES

**Admati & Pfleiderer (1988)** — strategic trading theory (predicts U-shaped intraday volume)
Confirmed empirically across multiple papers:
- Volume and vol highest in first 30–90 minutes after open (OPEN_RUSH) and last 60 minutes (CLOSE_RUSH)
- MIDDAY_CHOP (11am–1pm CT) has 40–60% lower volume than open/close periods

**Parameter implication:**
- Current threshold adjustments (OPEN_RUSH +10, MIDDAY_CHOP +15, CLOSE_RUSH 0) are correctly
  directioned — academia confirms the shape
- The MIDDAY_CHOP +15 adjustment may be slightly aggressive; literature suggests vol drops but
  not as severely as +15 threshold implies. Consider +10 for MIDDAY_CHOP.

### Synthesis Table — Recommended Parameter Adjustments

| Parameter | Current | Literature Basis | Recommended |
|---|---|---|---|
| `FED_DECISION.preWindow` | 60m | Lucca & Moench (2015): drift starts earlier | 30m hard block + consider pre-drift signal |
| `EMPLOYMENT_TIER1.postWindow` | 45m | Savor & Wilson (2013): discovery ~20-40m | 60m (more conservative, covers full window) |
| `INFLATION_TIER1.surpriseMultiplier` | 1.0–1.5× | Gürkaynak (2005): asymmetric hot print effect | 1.0–2.0× for INVERSE events |
| `RV/IV RANGING cutoff` | ratio < 0.7 | Carr & Wu (2008): structural IV premium ~3–5pt | ratio < 0.8 |
| `MIDDAY_CHOP threshold adj` | +15 | Admati & Pfleiderer (1988) + empirical papers | +10 to +12 |

### Implementation Plan

**No code required** for this initiative — it produces a parameter change list.

1. Fetch the 6 papers (SSRN / Google Scholar, all freely available)
2. Extract the specific empirical numbers relevant to our parameters
3. Map each finding to a specific parameter in the codebase
4. Implement the 5 parameter changes in the table above
5. Document the academic basis in DEVELOPMENT-STATUS.md

**Estimated time:** 2–3 hours of reading + 30 minutes of parameter edits

---

## Sequencing

| Order | Initiative | Effort | Impact | Dependencies |
|---|---|---|---|---|
| 1 | B — Literature synthesis | 3 hours | Medium-high | None |
| 2 | A — Decay empirical fit | 1 session | High | Yahoo Finance rate limits |
| 3 | Go live with 1 MES | — | Real signal | Both A + B complete |

Do B first — it's faster, requires no data infrastructure, and some findings (RANGING cutoff,
MIDDAY_CHOP adj) are immediately actionable.

Do A second — the empirical fits will override the literature-derived decay values with actual
ES-specific measurements, making A more precise than B for catalyst parameters.

Go live as soon as both are complete. The adaptive loops (`getAdaptiveRegimeAdjustments`,
`getSignalReliability`, `getFalseNegativeRate`) cannot be fed by any offline data source —
they require the system's own real-time decisions tagged with outcomes.

---

## What This Does NOT Replace

- Live trade data for adaptive calibration (the learning pipeline)
- Signal reliability per named signal (requires live `allSignals` + outcomes)
- False-negative rate estimation with enough trades (currently `hasEnoughData = false`)
- Empirical validation of the confidence threshold itself (55/52/48)
- Path A vs Path B differentiated edge (requires tagged live trades)

The calibration initiatives reduce uncertainty in the parameters we *can* pre-validate.
They cannot substitute for the 30–50 live trades needed to validate the core hypothesis
(does the confidence score predict outcomes at the chosen threshold?).
