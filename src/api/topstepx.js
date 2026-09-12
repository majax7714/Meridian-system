// TopstepX REST API client
// Replaces all background.js API logic — calls api.topstepx.com directly from Node.js

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const config = require('../../config');
const db = require('../storage/db');

const BASE = config.topstepx.apiBase;

// ─── Low-level request helper ────────────────────────────────────────────────
// Uses curl (proven to work with TopstepX), same as proxy-server.js lines 110-117
// Falls back to node-fetch if curl fails

async function curlRequest(endpoint, method, body, token) {
  const url = `${BASE}${endpoint}`;
  const tempFile = path.join('/tmp', `tsx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    let jsonBody;
    // History API requires exact field order (proxy-server.js lines 259-290)
    if (endpoint === '/api/History/retrieveBars' && body) {
      jsonBody =
        '{\n' +
        `  "contractId": "${body.contractId}",\n` +
        `  "live": ${body.live},\n` +
        `  "startTime": "${body.startTime}",\n` +
        `  "endTime": "${body.endTime}",\n` +
        `  "unit": ${body.unit},\n` +
        `  "unitNumber": ${body.unitNumber},\n` +
        `  "limit": ${body.limit},\n` +
        `  "includePartialBar": ${body.includePartialBar}\n` +
        '}';
    } else {
      jsonBody = body ? JSON.stringify(body) : '{}';
    }

    fs.writeFileSync(tempFile, jsonBody);

    let cmd;
    if (token) {
      cmd =
        `curl -s -X ${method} '${url}' ` +
        `-H 'Authorization: Bearer ${token}' ` +
        `-H 'accept: text/plain' ` +
        `-H 'Content-Type: application/json' ` +
        `--data @${tempFile}`;
    } else {
      cmd =
        `curl -s -X ${method} '${url}' ` +
        `-H 'accept: text/plain' ` +
        `-H 'Content-Type: application/json' ` +
        `--data @${tempFile}`;
    }

    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    // TopstepX returns empty body for some endpoints (e.g. cancel confirms with 200 + no body).
    // Treat empty response as success sentinel rather than crashing on JSON.parse('').
    if (!output || output.trim() === '') return { success: true, _emptyBody: true };
    return JSON.parse(output);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
}

// ─── Authentication ───────────────────────────────────────────────────────────

async function attemptApiKeyLogin(username) {
  try {
    const data = await curlRequest('/api/Auth/loginKey', 'POST', {
      userName: username,
      apiKey: config.topstepx.apiKey
    });

    if (data.token && data.success === true && data.errorCode === 0) {
      db.setSetting('sessionToken', data.token);
      db.setSetting('tokenTimestamp', Date.now());
      db.setSetting('authUsername', username);
      console.log(`[Auth] ✅ Authenticated as ${username}`);
      return { success: true, token: data.token };
    }

    console.log(`[Auth] ❌ Login failed for ${username}: errorCode=${data.errorCode} msg=${data.errorMessage}`);
    return { success: false, errorCode: data.errorCode, errorMessage: data.errorMessage };
  } catch (err) {
    console.error(`[Auth] Exception for ${username}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Authenticate with TopstepX API key.
 * Returns { success, token, errorCode } — caller checks errorCode===7 for browser login needed.
 */
async function authenticate() {
  const usernames = [
    config.topstepx.username,
    config.topstepx.altUsername
  ].filter(Boolean);

  for (const u of usernames) {
    const result = await attemptApiKeyLogin(u);
    if (result.success) return result;
    // errorCode 7 = must complete agreements via web UI — bubble it up
    if (result.errorCode === 7) return result;
  }

  return { success: false, error: 'All username variants failed' };
}

/**
 * Decode JWT expiry (seconds since epoch) from token payload.
 * Returns 0 if malformed.
 */
function jwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return decoded.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get cached session token, re-authenticating if missing or expiring within 10 minutes.
 */
async function getSessionToken() {
  const token = db.getSetting('sessionToken');

  if (token) {
    const exp = jwtExpiry(token);
    const nowSec = Math.floor(Date.now() / 1000);
    const remainingSec = exp - nowSec;

    if (exp === 0 || remainingSec > 600) {
      // Valid (or no exp field — assume valid)
      return token;
    }

    // Token expiring in < 10 minutes — refresh proactively
    console.log(`[Auth] Token expiring in ${remainingSec}s — refreshing proactively`);
    db.setSetting('sessionToken', null);
  }

  const result = await authenticate();
  return result.token || null;
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

async function getAccounts() {
  const token = await getSessionToken();
  if (!token) throw new Error('No session token');

  const result = await curlRequest('/api/Account/search', 'POST', { onlyActiveAccounts: true }, token);

  let accounts = [];
  if (Array.isArray(result))                        accounts = result;
  else if (result.data && Array.isArray(result.data)) accounts = result.data;
  else if (result.accounts && Array.isArray(result.accounts)) accounts = result.accounts;
  else if (result.success === false) throw new Error(result.errorMessage || `errorCode: ${result.errorCode}`);

  return accounts;
}

async function getActiveAccount() {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.isActive) || accounts[0];
  if (!account) throw new Error('No active account found');
  return account;
}

// ─── Contracts ────────────────────────────────────────────────────────────────

async function getContracts() {
  const token = await getSessionToken();
  if (!token) throw new Error('No session token');

  const result = await curlRequest('/api/Contract/available', 'POST', { live: false }, token);

  if (Array.isArray(result)) return result;
  if (result.data && Array.isArray(result.data)) return result.data;
  if (result.contracts && Array.isArray(result.contracts)) return result.contracts;
  return [];
}

// ─── Historical Bars ──────────────────────────────────────────────────────────

// Interval map — same as background.js lines 4769-4776
const INTERVAL_MAP = {
  '1s':  { timeUnit: 1, unitNumber: 1 },
  '1m':  { timeUnit: 2, unitNumber: 1 },
  '5m':  { timeUnit: 2, unitNumber: 5 },
  '15m': { timeUnit: 2, unitNumber: 15 },
  '1h':  { timeUnit: 3, unitNumber: 1 },
  '4h':  { timeUnit: 3, unitNumber: 4 }
};

function lookbackMinutes(timeUnit, unitNumber, count) {
  // 3x buffer (same as background.js lines 4794-4807)
  if (timeUnit === 1) return Math.ceil((count * unitNumber * 3.0) / 60);
  if (timeUnit === 2) return Math.ceil(count * unitNumber * 3.0);
  if (timeUnit === 3) return Math.ceil(count * unitNumber * 60 * 3.0);
  return Math.ceil(count * unitNumber * 24 * 60 * 3.0);
}

/**
 * Fetch bars for multiple timeframes sequentially.
 * requests: [{ interval: '5m', count: 60 }, ...]
 * Returns: { success, bars15m, bars5m, bars1m, bars1s, ... }
 */
async function fetchBars(requests) {
  const token = await getSessionToken();
  if (!token) return { success: false, error: 'No session token' };

  const contractId = db.getSetting('selectedContractId') || config.trading.defaultContractId;
  const now = new Date();
  const endTime = now.toISOString();
  const results = {};

  for (const req of requests) {
    const interval = req.interval;
    const count = req.count || 40;
    const mapping = INTERVAL_MAP[interval];

    if (!mapping) {
      console.warn(`[Bars] Unknown interval: ${interval}`);
      results[interval] = [];
      continue;
    }

    const { timeUnit, unitNumber } = mapping;
    const startDate = new Date(now);
    startDate.setMinutes(startDate.getMinutes() - lookbackMinutes(timeUnit, unitNumber, count));

    const body = {
      contractId,
      live: false,
      startTime: startDate.toISOString(),
      endTime,
      unit: timeUnit,
      unitNumber,
      limit: count,
      includePartialBar: true
    };

    try {
      const data = await curlRequest('/api/History/retrieveBars', 'POST', body, token);
      const raw = data.data?.bars || data.bars || [];
      // Normalize short field names (t/o/h/l/c/v) → long names (time/open/high/low/close/volume)
      // All engine modules expect the long names; the API returns short names.
      const bars = raw.slice(-count).map(b => ({
        time:   b.t ?? b.time,
        open:   b.o ?? b.open,
        high:   b.h ?? b.high,
        low:    b.l ?? b.low,
        close:  b.c ?? b.close,
        volume: b.v ?? b.volume ?? 0
      }));
      results[interval] = bars;
      console.log(`[Bars] ${interval}: ${results[interval].length} bars`);
    } catch (err) {
      console.error(`[Bars] Error fetching ${interval}:`, err.message);
      results[interval] = [];
    }
  }

  return {
    success: true,
    bars15m: results['15m'] || [],
    bars5m:  results['5m']  || [],
    bars1m:  results['1m']  || [],
    bars1s:  results['1s']  || [],
    bars1h:  results['1h']  || [],
    bars4h:  results['4h']  || []
  };
}

// ─── Historical Range (Backtesting) ──────────────────────────────────────────

/**
 * Fetch a large block of historical bars for backtesting.
 * Returns oldest-first array of { time, ts, open, high, low, close, volume }.
 *
 * @param {object} opts
 * @param {string} opts.interval    - '5m'|'15m'|'1h' etc.
 * @param {number} opts.count       - Number of bars to fetch (max ~5000)
 * @param {string} [opts.contractId] - Override contract ID
 */
async function fetchHistoricalRange({ interval = '5m', count = 2000, contractId = null }) {
  const token = await getSessionToken();
  if (!token) throw new Error('No session token');

  const cId      = contractId || db.getSetting('selectedContractId') || config.trading.defaultContractId;
  const mapping  = INTERVAL_MAP[interval];
  if (!mapping) throw new Error(`fetchHistoricalRange: unknown interval ${interval}`);

  const { timeUnit, unitNumber } = mapping;
  const now       = new Date();
  const endTime   = now.toISOString();
  const startDate = new Date(now);
  startDate.setMinutes(startDate.getMinutes() - lookbackMinutes(timeUnit, unitNumber, count));
  const startTime = startDate.toISOString();

  const body = {
    contractId:       cId,
    live:             false,
    startTime,
    endTime,
    unit:             timeUnit,
    unitNumber,
    limit:            count,
    includePartialBar: false
  };

  console.log(`[BarsHistorical] Fetching ${count} × ${interval} bars (${startDate.toISOString().substring(0,16)} → now)...`);

  const data = await curlRequest('/api/History/retrieveBars', 'POST', body, token);
  const raw  = data.data?.bars || data.bars || [];

  // Normalize field names and add epoch ts for cross-instrument alignment
  const bars = raw.map(b => ({
    time:   b.t ?? b.time,
    ts:     new Date(b.t ?? b.time).getTime(),
    open:   b.o ?? b.open,
    high:   b.h ?? b.high,
    low:    b.l ?? b.low,
    close:  b.c ?? b.close,
    volume: b.v ?? b.volume ?? 0
  }));

  // Return oldest-first for chronological backtest replay
  // (TopstepX returns newest-first like fetchBars; reverse to get oldest-first)
  bars.reverse();

  console.log(`[BarsHistorical] ✅ ${bars.length} bars fetched for ${cId}`);
  return bars;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Place a limit order with stop-loss and take-profit brackets.
 * order: { direction: 'long'|'short', price, stopLoss, takeProfit, contract, size }
 */
async function placeLimitOrder(order) {
  try {
    const token = await getSessionToken();
    if (!token) throw new Error('No session token');

    const { direction, price, stopLoss, takeProfit, contract, size } = order;
    const contractSize = size || 1;
    const tickSize = (contract && contract.tickSize) || config.trading.tickSize;

    const account = await getActiveAccount();

    // TopstepX bracket tick rules:
    //   Both stopLossBracket.ticks and takeProfitBracket.ticks are SIGNED offsets from entry:
    //     LONG:  SL below entry → negative ticks (e.g. -8);  TP above entry → positive ticks
    //     SHORT: SL above entry → positive ticks (e.g. +8);  TP below entry → negative ticks
    //   Minimum absolute distance: 4 ticks.
    const slTicksRaw = Math.round((stopLoss - price) / tickSize);   // negative for LONG, positive for SHORT
    const slTicks = direction === 'long'
      ? Math.min(-4, slTicksRaw)   // LONG: must be ≤ -4
      : Math.max( 4, slTicksRaw);  // SHORT: must be ≥ +4
    const tpTicks = Math.round((takeProfit - price) / tickSize);     // signed: positive for LONG, negative for SHORT

    const payload = {
      accountId: parseInt(account.id),
      contractId: (contract && contract.id) || config.trading.defaultContractId,
      type: 1,                              // Limit
      side: direction === 'long' ? 0 : 1,  // 0=Buy, 1=Sell
      size: contractSize,
      limitPrice: parseFloat(parseFloat(price).toFixed(2)),
      stopPrice: null,
      trailPrice: null,
      customTag: null,
      stopLossBracket:   { ticks: slTicks, type: 4 }, // 4=Stop
      takeProfitBracket: { ticks: tpTicks, type: 1 }  // 1=Limit
    };

    console.log(`[Order] Placing ${direction.toUpperCase()} @ ${price} | SL:${stopLoss} TP:${takeProfit} (sl${slTicks}t tp${tpTicks}t)`);

    const result = await curlRequest('/api/Order/place', 'POST', payload, token);
    console.log('[Order] Place API response:', JSON.stringify(result));

    // TopstepX may return an orderId even on rejection (it assigns the ID before validation).
    // Always check success:false first to surface the errorMessage clearly.
    if (result.success === false) {
      console.error(`[Order] ❌ Order rejected by broker: ${result.errorMessage} (errorCode=${result.errorCode})`);
      return { success: false, error: result.errorMessage, errorCode: result.errorCode };
    }

    const orderId = result.orderId || result.id;
    if (!orderId) {
      // If the API didn't return an orderId we cannot track this order at all.
      // Log the full response to help diagnose the field name mismatch.
      console.error('[Order] CRITICAL: No orderId in API response:', JSON.stringify(result));
      return { success: false, error: 'API did not return an orderId — order may or may not have been placed. Check broker manually.' };
    }

    return {
      success: true,
      orderId,
      result
    };
  } catch (err) {
    console.error('[Order] Place error:', err.message);
    return { success: false, error: err.message };
  }
}

// TopstepX order status codes (numeric)
// Confirmed via /api/Order/search response: status is an integer, not a string.
const ORDER_STATUS = {
  WORKING:   1, // Active in order book
  FILLED:    2, // Fully filled
  CANCELLED: 3, // Cancelled
  REJECTED:  5  // Rejected (e.g. outside market hours, insufficient margin)
  // 4 = partial fill or other intermediate state observed in practice
};

/**
 * Check whether an order has been filled.
 * Uses POST /api/Order/search (the GET /api/Order/{id} endpoint returns empty body).
 * Returns { success, filled, fillPrice, status, statusCode }
 */
async function checkOrderStatus(orderId) {
  try {
    const token = await getSessionToken();
    if (!token) throw new Error('No session token');

    const account = await getActiveAccount();
    const since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(); // last 8h window
    const data = await curlRequest('/api/Order/search', 'POST', {
      accountId:      parseInt(account.id),
      startTimestamp: since
    }, token);

    const orders = data.orders || [];
    // TopstepX may use 'id' or 'orderId' as the ID field — check both.
    const order = orders.find(o =>
      String(o.id)      === String(orderId) ||
      String(o.orderId) === String(orderId)
    );

    if (!order) {
      // Order not found in recent window — assume still working (not yet filled)
      console.log(`[Order] ${orderId} not found in search window — treating as working`);
      return { success: true, filled: false, status: null, statusCode: null };
    }

    // Fill detection: use status code 2 OR volume/price fields (API may use different names).
    const filledByStatus = order.status === 2;
    const filledQty   = order.fillVolume || order.filledQty  || order.executedQty  || order.cumQty  || 0;
    const filledAt    = order.filledPrice || order.avgPrice   || order.averagePrice || order.executionPrice || null;
    const filledByFields = filledQty > 0 && filledAt != null;
    const filled      = filledByStatus || filledByFields;
    const fillPrice   = filledAt || null;

    console.log(`[Order] ${orderId} status=${order.status} filled=${filled} fillPrice=${fillPrice ?? 'none'} (qty=${filledQty})`);

    return { success: true, filled, fillPrice, status: order.status, statusCode: order.status };
  } catch (err) {
    console.error('[Order] Status check error:', err.message);
    return { success: false, filled: false, error: err.message };
  }
}

/**
 * Close an open position with a market order.
 * direction: 'long'|'short' — the direction of the OPEN position (we send the opposite).
 * size: number of contracts to close.
 */
async function closePosition({ contractId, direction, size }) {
  try {
    const token = await getSessionToken();
    if (!token) throw new Error('No session token');

    const account = await getActiveAccount();
    const cId = contractId || db.getSetting('selectedContractId') || config.trading.defaultContractId;

    // Closing a long → send a Sell (1); closing a short → send a Buy (0)
    const closeSide = direction === 'long' ? 1 : 0;

    const payload = {
      accountId:  parseInt(account.id),
      contractId: cId,
      type:       2,          // Market order
      side:       closeSide,
      size:       size || 1,
      limitPrice: null,
      stopPrice:  null,
      trailPrice: null,
      customTag:  'TIME_EXIT'
    };

    console.log(`[Order] Closing ${direction.toUpperCase()} position (market) × ${size || 1}`);

    const result = await curlRequest('/api/Order/place', 'POST', payload, token);
    return {
      success: true,
      orderId: result.orderId || result.id || 'UNKNOWN',
      result
    };
  } catch (err) {
    console.error('[Order] closePosition error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get all currently open positions for the active account.
 * Returns an array of position objects (may be empty if no open positions).
 * Returns null if the API call itself fails — callers must treat null as "unknown"
 * and should NOT assume the position is closed.
 *
 * Typical position fields: contractId, size, side ('long'|'short'), avgPrice.
 */
async function getOpenPositions() {
  try {
    const token = await getSessionToken();
    if (!token) throw new Error('No session token');

    const account = await getActiveAccount();
    const result = await curlRequest(
      '/api/Position/search',
      'POST',
      { accountId: parseInt(account.id) },
      token
    );

    // Normalise varying response shapes
    if (Array.isArray(result))                           return result;
    if (result.data && Array.isArray(result.data))       return result.data;
    if (result.positions && Array.isArray(result.positions)) return result.positions;
    // Unexpected shape but request succeeded — return empty
    return [];
  } catch (err) {
    console.error('[Positions] getOpenPositions error:', err.message);
    return null; // null = API failure; distinct from [] = no positions
  }
}

/**
 * Cancel an open order.
 */
async function cancelOrder(orderId) {
  try {
    const token = await getSessionToken();
    if (!token) throw new Error('No session token');

    const result = await curlRequest(`/api/Order/${orderId}/cancel`, 'POST', {}, token);

    // Inspect response — some brokers return { success: false } rather than throwing
    if (result && result.success === false) {
      console.error(`[Order] Cancel API returned failure for ${orderId}:`, result.errorMessage || JSON.stringify(result));
      return { success: false, error: result.errorMessage || 'API returned success=false' };
    }

    console.log(`[Order] Cancelled ${orderId}`);
    return { success: true };
  } catch (err) {
    console.error('[Order] Cancel error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  authenticate,
  getSessionToken,
  getAccounts,
  getActiveAccount,
  getContracts,
  fetchBars,
  fetchHistoricalRange,
  placeLimitOrder,
  closePosition,
  checkOrderStatus,
  cancelOrder,
  getOpenPositions
};
