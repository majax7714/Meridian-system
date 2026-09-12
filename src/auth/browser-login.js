// Puppeteer-based browser login for TopstepX
// Handles errorCode 7: "Please log into the ProjectX platform and complete required agreements"
// Credentials from login-autofill.js

const puppeteer = require('puppeteer');
const config = require('../../config');

const LOGIN_URL = config.topstepx.loginUrl || 'https://app.topstepx.com';
const EMAIL    = config.topstepx.username;
const PASSWORD = config.topstepx.password;

// Selectors to try for each field
const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  'input#username',
  'input#email',
  'input[type="text"]'
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input#password'
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button.login',
  'input[type="submit"]'
];

// Text patterns that indicate agreement/terms dialogs
const AGREEMENT_TEXTS = [
  /agree/i, /accept/i, /continue/i, /i understand/i, /confirm/i, /ok/i, /got it/i
];

async function login() {
  console.log('[BrowserLogin] Launching browser to complete TopstepX agreements...');

  const browser = await puppeteer.launch({
    headless: false,          // Visible so agreements can render properly
    defaultViewport: null,
    args: ['--start-maximized']
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Navigate to login page
    console.log(`[BrowserLogin] Navigating to ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    // Find and fill email
    const emailField = await findElement(page, EMAIL_SELECTORS);
    if (!emailField) throw new Error('Could not find email/username field');
    await emailField.click({ clickCount: 3 });
    await emailField.type(EMAIL, { delay: 50 });
    console.log('[BrowserLogin] Email filled');

    // Find and fill password
    const passwordField = await findElement(page, PASSWORD_SELECTORS);
    if (!passwordField) throw new Error('Could not find password field');
    await passwordField.click({ clickCount: 3 });
    await passwordField.type(PASSWORD, { delay: 50 });
    console.log('[BrowserLogin] Password filled');

    // Submit
    const submitBtn = await findElement(page, SUBMIT_SELECTORS);
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    console.log('[BrowserLogin] Login submitted, waiting for navigation...');

    // Wait for redirect after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
      console.log('[BrowserLogin] Navigation timeout — continuing anyway');
    });

    // Accept any agreement modals
    await acceptPendingAgreements(page);

    // Give the platform a moment to process
    await sleep(3000);

    console.log('[BrowserLogin] ✅ Browser login complete, closing browser');
    return { success: true };

  } catch (err) {
    console.error('[BrowserLogin] Error:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

async function acceptPendingAgreements(page) {
  console.log('[BrowserLogin] Scanning for agreement dialogs...');
  let accepted = 0;

  // Try up to 5 rounds in case multiple dialogs appear sequentially
  for (let round = 0; round < 5; round++) {
    await sleep(2000);

    const buttons = await page.$$('button, input[type="button"], input[type="submit"], a[role="button"]');
    let clicked = false;

    for (const btn of buttons) {
      try {
        const text = await page.evaluate(el => el.textContent || el.value || '', btn);
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        }, btn);

        if (isVisible && AGREEMENT_TEXTS.some(re => re.test(text.trim()))) {
          console.log(`[BrowserLogin] Clicking agreement button: "${text.trim()}"`);
          await btn.click();
          accepted++;
          clicked = true;
          await sleep(1000);
          break;
        }
      } catch { /* element may have gone stale */ }
    }

    if (!clicked) break; // No more dialogs found
  }

  if (accepted > 0) {
    console.log(`[BrowserLogin] Accepted ${accepted} agreement(s)`);
  } else {
    console.log('[BrowserLogin] No agreement dialogs found');
  }
}

async function findElement(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch { /* continue */ }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { login };
