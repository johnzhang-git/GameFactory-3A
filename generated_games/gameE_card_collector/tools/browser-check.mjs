/**
 * Browser check: does the wallet connect flow actually work in a real page?
 *
 * The node-level tests fake `window.ethereum` in Node, which cannot catch
 * anything about how the client is wired into the page — including whether the
 * API paths resolve at all. This drives a real Chromium instead.
 *
 * Signing is delegated to Node over `exposeFunction`, so the page holds a
 * provider but no key material.
 *
 * This check exists because the unit tests passed while the feature was
 * broken: boot never read the stored session token, so a reload silently
 * dropped the player back to a fresh local game. Only a real page showed it.
 *
 * Needs the backend and a dev server running:
 *
 *   node server/src/index.js &      # :8787
 *   npx vite --port 5199 &          # proxies /auth and /game to :8787
 *   node tools/browser-check.mjs
 *
 * Env: URL_BASE (default http://127.0.0.1:5199); CHROME_PATH to use an
 * already-installed Chromium instead of the build Playwright expects.
 */

import { chromium } from 'playwright';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const URL_BASE = process.env.URL_BASE ?? 'http://127.0.0.1:5199';
const account = privateKeyToAccount(generatePrivateKey());

// The installed Playwright expects a newer browser build than the one on this
// box; point it at the Chromium that is actually present rather than pulling
// another ~150MB download.
const executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch(
  executablePath ? { executablePath } : {},
);
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

// The wallet lives in the page, but the signature is produced in Node.
await page.exposeFunction('__nodeSign', async (message) => {
  return account.signMessage({ message });
});

await page.addInitScript(
  ({ address }) => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return window.__nodeSign(params[0]);
        throw new Error(`unexpected method ${method}`);
      },
    };
  },
  { address: account.address },
);

await page.goto(URL_BASE, { waitUntil: 'load' });

// The game boots asynchronously; wait for the HUD button it creates.
await page.waitForSelector('[data-game-action="connect_wallet"]', {
  timeout: 30000,
});
console.log('game booted, wallet button present');

const statusBefore = await page.textContent('[data-wallet-status]');
console.log('status before connect:', statusBefore.trim());

// --- connect -----------------------------------------------------------------
await page.click('[data-game-action="connect_wallet"]');
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-wallet-status]')
      ?.textContent?.includes('…'),
  { timeout: 30000 },
);
const statusAfter = await page.textContent('[data-wallet-status]');
console.log('status after connect: ', statusAfter.trim());

// The server normalises addresses to lowercase, so compare on that basis
// rather than against the checksummed form the wallet reports.
const lower = account.address.toLowerCase();
const short = `${lower.slice(0, 6)}…${lower.slice(-4)}`;
console.log(
  'shows the connected address:',
  statusAfter.trim() === short ? 'YES' : `NO (expected ${short})`,
);

// --- play, then confirm it reached the server --------------------------------
await page.evaluate(() => {
  const buy = document.querySelector('[data-game-action="buy_chest"]');
  buy.click();
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.querySelector('[data-game-action="open_chest"]').click();
});
await page.waitForTimeout(800);

const hudStats = await page.evaluate(() => {
  // The HUD renders text nodes; grab the whole overlay.
  return document.querySelector('#a3game-hud')?.innerText ?? '';
});
console.log('hud contains "1 opened":', /1 opened/.test(hudStats) ? 'YES' : 'NO');

// --- reload: the session must restore without re-signing ---------------------
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-wallet-status]', { timeout: 30000 });
await page.waitForTimeout(2500);

const statusReload = await page.textContent('[data-wallet-status]');
console.log('status after reload:  ', statusReload.trim());
console.log(
  'session restored without re-signing:',
  statusReload.trim() === short ? 'YES' : 'NO',
);

const hudReload = await page.evaluate(
  () => document.querySelector('#a3game-hud')?.innerText ?? '',
);
console.log('collection survived reload:', /1 opened/.test(hudReload) ? 'YES' : 'NO');

console.log('console errors:', errors.length ? errors.slice(0, 5) : '(none)');

await browser.close();
