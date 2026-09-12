// Quote Stream — Real-Time Bid/Ask via SignalR
// Connects to TopstepX/ProjectX market hub for live quote data.
// Hub URL: https://rtc.topstepx.com/hubs/market
// Falls back gracefully when disconnected: getLatestQuote() returns null.
//
// @microsoft/signalr is already installed in package.json.

const signalR = require('@microsoft/signalr');

// ─── State ────────────────────────────────────────────────────────────────────

let connection  = null;
let latestQuote = null;
let contractId  = null;
let running     = false;

const QUOTE_BUFFER_SIZE = 300;
let quoteBuffer = [];

const MARKET_HUB_URL = 'https://rtc.topstepx.com/hubs/market';

// ─── Connection Management ────────────────────────────────────────────────────

/**
 * Start the SignalR quote stream for the given contract.
 * Automatically reconnects on disconnect.
 *
 * @param {string} cId    - Contract ID (e.g. 'CON.F.US.MES.H26')
 * @param {string} token  - Session token from topstepx.authenticate()
 */
async function start(cId, token) {
  if (running) return;
  contractId = cId;
  running = true;

  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${MARKET_HUB_URL}?access_token=${token}`, {
      skipNegotiation: false,
      transport: signalR.HttpTransportType.WebSockets
    })
    .withAutomaticReconnect([1000, 3000, 10000, 30000])
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  // Quote handler — ProjectX market hub fires 'GatewayQuote' with two args:
  // arg0 = contractId (string), arg1 = quote object with bestBid/bestAsk fields
  connection.on('GatewayQuote', (_cid, data) => {
    if (!data) return;
    const bid = parseFloat(data.bestBid ?? 0);
    const ask = parseFloat(data.bestAsk ?? 0);
    if (bid <= 0 || ask <= 0) return;

    const quote = {
      bid,
      ask,
      spread:    parseFloat((ask - bid).toFixed(4)),
      mid:       parseFloat(((bid + ask) / 2).toFixed(4)),
      last:      parseFloat(data.lastPrice ?? 0),
      timestamp: Date.now()
    };
    latestQuote = quote;
    quoteBuffer.push(quote);
    if (quoteBuffer.length > QUOTE_BUFFER_SIZE) quoteBuffer.shift();
  });

  connection.onreconnected(() => {
    console.log('[QuoteStream] Reconnected — resubscribing...');
    _subscribe();
  });

  connection.onclose((err) => {
    if (err) console.warn('[QuoteStream] Connection closed:', err.message);
  });

  try {
    await connection.start();
    console.log('[QuoteStream] Connected to market hub');
    await _subscribe();
  } catch (err) {
    console.warn('[QuoteStream] Failed to connect:', err.message, '— live quotes unavailable');
    running = false;
  }
}

async function _subscribe() {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return;
  try {
    // Standard ProjectX market hub subscription method
    await connection.invoke('SubscribeContractQuotes', contractId);
    console.log(`[QuoteStream] Subscribed to quotes for ${contractId}`);
  } catch (err) {
    console.warn('[QuoteStream] Subscribe failed:', err.message);
    // Try alternative method name
    try {
      await connection.invoke('SubscribeQuotes', contractId);
    } catch {
      console.warn('[QuoteStream] Alternative subscribe also failed — live quotes unavailable');
    }
  }
}

/**
 * Stop the SignalR connection.
 */
async function stop() {
  running = false;
  if (connection) {
    try { await connection.stop(); } catch { /* ignore */ }
    connection = null;
  }
  latestQuote = null;
  quoteBuffer = [];
}

/**
 * Reconnect with a fresh token (e.g. after session token refresh).
 * Stops the existing connection, resets state, then starts fresh.
 *
 * @param {string} cId    - Contract ID
 * @param {string} token  - New session token
 */
async function reconnect(cId, token) {
  console.log('[QuoteStream] Reconnecting with refreshed token...');
  await stop();
  // Brief pause before reconnect to allow clean teardown
  await new Promise(r => setTimeout(r, 1000));
  await start(cId, token);
}

// ─── Quote Access ─────────────────────────────────────────────────────────────

/**
 * Get the most recently received quote.
 * Returns null if not connected or no quote received yet.
 * Callers should fall back to bar high/low approximation when null.
 *
 * @returns {{ bid: number, ask: number, spread: number, mid: number, timestamp: number } | null}
 */
function getLatestQuote() {
  if (!latestQuote) return null;
  // Stale after 30 seconds (market may be closed)
  if (Date.now() - latestQuote.timestamp > 30000) return null;
  return latestQuote;
}

/**
 * Returns milliseconds since the last quote was received.
 * Returns Infinity if no quote has ever been received.
 */
function getQuoteAge() {
  if (!latestQuote) return Infinity;
  return Date.now() - latestQuote.timestamp;
}

/**
 * Whether the stream is currently connected.
 */
function isConnected() {
  return !!(connection && connection.state === signalR.HubConnectionState.Connected);
}

/**
 * Returns quotes received within the last windowMs milliseconds, newest-first.
 * Defaults to the last 60 seconds.
 *
 * @param {number} windowMs - Lookback window in milliseconds (default 60000)
 * @returns {Array<{bid,ask,spread,mid,last,timestamp}>}
 */
function getQuoteBuffer(windowMs = 60000) {
  const cutoff = Date.now() - windowMs;
  return quoteBuffer.filter(q => q.timestamp >= cutoff).reverse();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  start,
  stop,
  reconnect,
  getLatestQuote,
  getQuoteAge,
  getQuoteBuffer,
  isConnected
};
