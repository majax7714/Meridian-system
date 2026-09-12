// COT (Commitment of Traders) Data Engine
// Downloads CFTC Traders in Financial Futures (TFF) data weekly.
// Extracts Dealer/Intermediary net positioning for S&P 500 futures as a
// macro-level sentiment signal: DEALERS_LONG / DEALERS_SHORT / DEALERS_NEUTRAL
//
// Data source: CFTC Public Reporting Environment (Socrata API)
// Update frequency: Fridays ~3:30 PM ET with prior Tuesday's close data
// Cache TTL: 7 days (stored in db.js settings as JSON)

const { execSync } = require('child_process');
const db = require('../storage/db');

const CACHE_KEY = 'cotData';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// CFTC Socrata API — TFF report, S&P 500 Consolidated rows (JSON), newest 10 weeks
// Column names are lowercase_with_underscores in the Socrata API.
// %24 = $  (Socrata SoQL prefix), %26 = &, %25 = %
const COT_URL = [
  'https://publicreporting.cftc.gov/resource/gpe5-46if.json',
  '?%24where=contract_market_name%20like%20\'%25S%26P%20500%20Consolidated%25\'',
  '&%24limit=52',
  '&%24order=report_date_as_yyyy_mm_dd%20DESC'
].join('');

// ─── Fetch & Cache ────────────────────────────────────────────────────────────

/**
 * Fetch latest COT data from CFTC (or from cache if fresh).
 * Returns parsed result object, or null on failure.
 *
 * Column names from Socrata API are lowercase_with_underscores:
 *   dealer_positions_long_all, dealer_positions_short_all
 *   report_date_as_yyyy_mm_dd, contract_market_name
 */
async function fetchLatestCOT() {
  // Check cache
  const cached = db.getSetting(CACHE_KEY);
  if (cached) {
    const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
    if (parsed.fetchedAt && (Date.now() - parsed.fetchedAt) < CACHE_TTL) {
      return parsed;
    }
  }

  // Fetch fresh (JSON endpoint — no CSV parsing needed)
  try {
    const curlCmd = `curl -s --max-time 20 "${COT_URL}"`;
    const body = execSync(curlCmd, { encoding: 'utf8' });

    if (!body || body.trim().length < 10) {
      throw new Error('Empty response from CFTC');
    }

    const rows = JSON.parse(body);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('No rows in CFTC response');
    }

    // Use the most recent row (already sorted DESC)
    const row = rows[0];

    const dealerLong  = parseInt(row.dealer_positions_long_all  || 0, 10);
    const dealerShort = parseInt(row.dealer_positions_short_all || 0, 10);
    const reportDate  = (row.report_date_as_yyyy_mm_dd || '').substring(0, 10) || 'Unknown';

    const net = dealerLong - dealerShort;

    // Keep rolling history of all returned rows for percentile calculation
    const history = rows
      .map(r => parseInt(r.dealer_positions_long_all || 0, 10) - parseInt(r.dealer_positions_short_all || 0, 10))
      .filter(n => n !== 0);

    const result = {
      net,
      dealerLong,
      dealerShort,
      reportDate,
      history,
      fetchedAt: Date.now()
    };

    db.setSetting(CACHE_KEY, JSON.stringify(result));
    return result;

  } catch (err) {
    console.warn('[COT] Fetch failed:', err.message, '— returning neutral');
    return null;
  }
}

// ─── Signal Derivation ────────────────────────────────────────────────────────

/**
 * Compute percentile of `value` within `history` array.
 * 0 = lowest ever seen, 1 = highest ever seen
 */
function percentileOf(value, history) {
  if (!history || history.length < 2) return 0.5;
  const sorted = [...history].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= value).length;
  return rank / sorted.length;
}

/**
 * Fetch COT data and return dealer positioning signal.
 * Cached for 7 days.
 *
 * @returns {Promise<{net: number, signal: string, percentile: number, reportDate: string}>}
 */
async function getDealerNetPosition() {
  const data = await fetchLatestCOT();

  if (!data) {
    return { net: 0, signal: 'DEALERS_NEUTRAL', percentile: 0.5, reportDate: 'N/A' };
  }

  const pct = percentileOf(data.net, data.history);

  let signal;
  if (pct >= 0.70)      signal = 'DEALERS_LONG';   // net long ≥ 70th pctile → bullish
  else if (pct <= 0.30) signal = 'DEALERS_SHORT';  // net long ≤ 30th pctile → bearish
  else                  signal = 'DEALERS_NEUTRAL';

  return {
    net:        data.net,
    signal,
    percentile: parseFloat(pct.toFixed(2)),
    reportDate: data.reportDate
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fetchLatestCOT,
  getDealerNetPosition
};
