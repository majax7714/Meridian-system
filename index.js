// Meridian System — Standalone Node.js Entry Point
// Run with: node index.js

const topstepx    = require('./src/api/topstepx');
const browserLogin = require('./src/auth/browser-login');
const db          = require('./src/storage/db');
const config      = require('./config');
const Automation  = require('./src/engine/automation');

// ── Contract rollover schedule ─────────────────────────────────────────────────
// After each rolloverDate the stated contract becomes the front month.
// Add a row here each time CME announces the next contract.
const ROLLOVER_SCHEDULE = [
  { rolloverDate: new Date(2026, 2, 16),  contractId: 'CON.F.US.MES.M26' }, // Mar 16 → Jun 2026
  { rolloverDate: new Date(2026, 5, 15),  contractId: 'CON.F.US.MES.U26' }, // Jun 15 → Sep 2026
  { rolloverDate: new Date(2026, 8, 14),  contractId: 'CON.F.US.MES.Z26' }, // Sep 14 → Dec 2026
  { rolloverDate: new Date(2026, 11, 14), contractId: 'CON.F.US.MES.H27' }, // Dec 14 → Mar 2027
];

/**
 * Return the contract ID that should be active on `now` based on the
 * rollover schedule.  Falls back to config.trading.defaultContractId (H26)
 * for any date before the first scheduled rollover.
 */
function getExpectedContractId(now = new Date()) {
  // Normalize to local-date midnight so comparison is consistent regardless of
  // whether `now` came from new Date() (local) or new Date('YYYY-MM-DD') (UTC).
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let active = config.trading.defaultContractId;
  for (const r of ROLLOVER_SCHEDULE) {
    if (today >= r.rolloverDate) {
      active = r.contractId;
    } else {
      break; // remaining entries are in the future
    }
  }
  return active;
}

/**
 * Pick the correct front-month MES contract from the list returned by the API.
 * Tries exact match on the expected contract ID first; falls back to the
 * alphabetically-first MES contract (which is chronologically earliest).
 *
 * @param {Array}  contracts - array of contract objects from topstepx.getContracts()
 * @param {Date}   [now]     - injectable for testing; defaults to today
 * @returns {{ contract: object, contractId: string } | null}
 */
function selectFrontMonthMES(contracts, now = new Date()) {
  const targetId = getExpectedContractId(now);

  // Exact match
  const exact = contracts.find(c => c.id === targetId);
  if (exact) return { contract: exact, contractId: targetId };

  // Fallback: any contract whose ID contains '.MES.', sorted alphabetically
  // (CON.F.US.MES.H26 < CON.F.US.MES.M26 < … — alphabetical ≈ chronological)
  const mes = contracts
    .filter(c => (c.id || '').includes('.MES.'))
    .sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  if (mes.length > 0) {
    console.warn(`[Init] ⚠️  Target contract ${targetId} not found — using fallback: ${mes[0].id}`);
    return { contract: mes[0], contractId: mes[0].id };
  }

  // Nothing MES-specific found
  const first = contracts[0];
  if (first) {
    console.warn(`[Init] ⚠️  No MES contracts found — defaulting to first available: ${first.id}`);
    return { contract: first, contractId: first.id };
  }

  return null;
}

/**
 * Warn if a rollover is coming up within WARN_DAYS days.
 */
function checkRolloverWarning(now = new Date()) {
  const WARN_DAYS = 7;
  for (const r of ROLLOVER_SCHEDULE) {
    const daysUntil = (r.rolloverDate - now) / (1000 * 60 * 60 * 24);
    if (daysUntil > 0 && daysUntil <= WARN_DAYS) {
      console.warn(
        `[Init] ⚠️  CONTRACT ROLLOVER in ${daysUntil.toFixed(1)} days ` +
        `(${r.rolloverDate.toDateString()}) — front month switches to ${r.contractId}`
      );
      return;
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Meridian System v18.0.0');
  console.log('='.repeat(60));

  // ── Step 1: Initialize database ─────────────────────────────────────────────
  console.log('\n[Init] Initializing database...');
  const dbTest = db.getSetting('initialized');
  if (!dbTest) {
    db.setSetting('initialized', true);
    console.log('[Init] Database created fresh');
  } else {
    console.log('[Init] Database loaded');
  }

  // ── Step 2: Rollover warning ─────────────────────────────────────────────────
  checkRolloverWarning();

  // ── Step 3: Authenticate ────────────────────────────────────────────────────
  console.log('\n[Init] Authenticating with TopstepX...');
  let authResult = await topstepx.authenticate();

  if (!authResult.success && authResult.errorCode === 7) {
    console.log('[Init] errorCode 7 — agreements pending, launching browser login...');
    const loginResult = await browserLogin.login();

    if (loginResult.success) {
      console.log('[Init] Browser login complete, retrying API auth...');
      authResult = await topstepx.authenticate();
    } else {
      console.error('[Init] Browser login failed:', loginResult.error);
      process.exit(1);
    }
  }

  if (!authResult.success) {
    console.error('[Init] Authentication failed:', authResult.error || authResult.errorMessage);
    console.error('[Init] Please check credentials in config.js');
    process.exit(1);
  }

  console.log('[Init] ✅ Authenticated successfully');

  // ── Step 4: Load account ────────────────────────────────────────────────────
  console.log('\n[Init] Loading account...');
  try {
    const account = await topstepx.getActiveAccount();
    db.setSetting('activeAccountId', account.id);
    console.log(`[Init] ✅ Account: ${account.id} (${account.accountName || account.name || 'Active'})`);
  } catch (err) {
    console.error('[Init] Failed to load account:', err.message);
    console.warn('[Init] Continuing — order placement may fail without a valid account ID');
  }

  // ── Step 5: Select front-month MES contract ─────────────────────────────────
  console.log('\n[Init] Loading contracts...');
  try {
    const contracts = await topstepx.getContracts();
    const selection = selectFrontMonthMES(contracts);

    if (selection) {
      db.setSetting('selectedContractId', selection.contractId);
      db.setSetting('selectedContractName',
        selection.contract.description ||
        selection.contract.name        ||
        selection.contract.symbol      ||
        selection.contractId
      );
      console.log(`[Init] ✅ Contract: ${selection.contractId}`);

      // Warn if the chosen contract differs from what config says
      if (selection.contractId !== config.trading.defaultContractId) {
        console.warn(
          `[Init] ℹ️  Active contract (${selection.contractId}) differs from ` +
          `config default (${config.trading.defaultContractId}) — rollover has occurred`
        );
      }
    } else {
      console.warn('[Init] No contracts found — using config default');
      db.setSetting('selectedContractId', config.trading.defaultContractId);
    }
  } catch (err) {
    console.error('[Init] Failed to load contracts:', err.message);
    console.warn('[Init] Using default contract from config.js');
    db.setSetting('selectedContractId', config.trading.defaultContractId);
  }

  // ── Step 6: Start automation ─────────────────────────────────────────────────
  console.log('\n[Init] Starting scalping automation...');
  console.log('[Init] Press Ctrl+C to stop\n');

  await Automation.start();

  // Graceful shutdown (SIGINT/SIGTERM) is handled by automation.js which also
  // cancels any open limit order before exiting. index.js does not register its
  // own SIGINT handler to avoid racing with the async cancel in automation.js.
}

// ── Exports (for rollover tests) ───────────────────────────────────────────────
module.exports = { getExpectedContractId, selectFrontMonthMES, checkRolloverWarning };

// Only run when invoked directly (not when require()'d by tests)
if (require.main === module) {
  main().catch(err => {
    console.error('[Fatal]', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
