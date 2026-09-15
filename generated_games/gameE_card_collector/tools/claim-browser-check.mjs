/**
 * Browser check for the claim flow.
 *
 * `wallet.js`'s `ensureChain` and `sendTransaction` are the least-covered code
 * in the project, and the gap is structural rather than an oversight:
 *
 *   - the session tests inject hooks, which *replace* those functions;
 *   - `chain-e2e.mjs` speaks HTTP and ethers directly, never through them;
 *   - `browser-check.mjs` runs against an unconfigured server, so the claim
 *     button stays disabled and neither function is reached.
 *
 * So the two functions that decide whether the player's transaction is correct
 * had no coverage at all. Only a real page with an injected provider can
 * exercise them.
 *
 * Usage (from the project root):
 *
 *   npx hardhat node --port 8546 &
 *   npx vite --port 5199 &          # proxies /auth and /game to :8787
 *   npx hardhat compile
 *   node tools/claim-browser-check.mjs
 *
 * The dev server proxies /auth and /game to whatever `API_URL` points at
 * (default http://127.0.0.1:8787) — see vite.config.js and A3GAME_API_URL.
 *
 * Env: CHROME_PATH to reuse an already-installed Chromium.
 */

import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { tokenIdFor } from '../packages/card-collector/src/catalog.js';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8546';
const VITE_URL = process.env.URL_BASE ?? 'http://127.0.0.1:5199';
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';
const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = new ethers.JsonRpcProvider(RPC);
const deployer = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  provider,
);
const SIGNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signerAddr = new ethers.Wallet(SIGNER_KEY).address;

const artifact = JSON.parse(
  fs.readFileSync(
    '.hardhat/artifacts/contracts/CardCollector.sol/CardCollector.json',
    'utf8',
  ),
);
const card = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer)
  .deploy(signerAddr, 'https://example.test/{id}.json');
await card.waitForDeployment();
const contractAddress = await card.getAddress();
console.log(`contract  ${contractAddress}`);

// Refuse to run against someone else's server.
//
// A stale server on this port holds a *different* contract address, and the
// spawn below would then fail to bind and silently do nothing — so the page
// talks to the old server, mints on the old contract, and this script reports
// a false failure against a contract nothing ever touched. That cost real
// debugging time once; it should not be possible a second time.
const existing = await fetch(`${API_URL}/health`).catch(() => null);
if (existing?.ok) {
  console.error(
    `Something is already serving ${API_URL}. Stop it first — it will hold a\n` +
      'different contract address than the one this run deploys, and the\n' +
      'results will not mean anything.',
  );
  process.exit(1);
}

// The server has to know the contract address, which only exists after the
// deploy above — so this script owns the server's lifetime rather than asking
// the operator to sequence two commands around a value they cannot know yet.
const serverPort = new URL(API_URL).port || '8787';
const server = spawn('node', ['server/src/index.js'], {
  cwd: process.cwd(),
  shell: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    DB_PATH: ':memory:',
    PORT: serverPort,
    CHAIN_ID: '31337',
    CHAIN_CONTRACT_ADDRESS: contractAddress,
    CHAIN_SIGNER_KEY: SIGNER_KEY,
  },
});
await waitFor(3500);

const health = await fetch(`${API_URL}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`Server did not come up on ${API_URL}.`);
  server.kill();
  process.exit(1);
}

const player = ethers.Wallet.createRandom();
await (
  await deployer.sendTransaction({ to: player.address, value: ethers.parseEther('1') })
).wait();
const connected = new ethers.Wallet(player.privateKey, provider);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

// Signing happens in Node, so the page holds a provider but no key material.
await page.exposeFunction('__nodeSignMessage', (message) =>
  player.signMessage(message),
);
// The fake wallet really sends: a stub returning a made-up hash would let the
// page "succeed" while nothing reached the chain, which is precisely the class
// of bug this check exists to catch.
await page.exposeFunction('__nodeSendTransaction', async (tx) => {
  const sent = await connected.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: 0n,
    ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }),
  });
  await sent.wait();
  return sent.hash;
});
await page.exposeFunction('__nodeTransactionCount', (address) =>
  provider.getTransactionCount(address, 'pending'),
);

await page.addInitScript(({ address }) => {
  window.__chainSwitchAttempts = 0;
  window.__currentChain = 1;
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return [address];
      // Report the wrong chain first so `ensureChain` takes its switch branch;
      // otherwise only the early-return path is ever exercised.
      if (method === 'eth_chainId') return `0x${window.__currentChain.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        window.__chainSwitchAttempts += 1;
        window.__currentChain = Number.parseInt(params[0].chainId, 16);
        return null;
      }
      if (method === 'personal_sign') return window.__nodeSignMessage(params[0]);
      if (method === 'eth_getTransactionCount') {
        const count = await window.__nodeTransactionCount(params[0]);
        return `0x${count.toString(16)}`;
      }
      if (method === 'eth_sendTransaction') {
        return window.__nodeSendTransaction({
          to: params[0].to,
          data: params[0].data,
          nonce: params[0].nonce ? Number.parseInt(params[0].nonce, 16) : undefined,
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}, { address: player.address });

await page.goto(VITE_URL, { waitUntil: 'load' });
await page.waitForSelector('[data-game-action="connect_wallet"]', { timeout: 30000 });

await page.click('[data-game-action="connect_wallet"]');
await page.waitForFunction(
  () => document.querySelector('[data-wallet-status]')?.textContent?.includes('…'),
  { timeout: 30000 },
);
console.log(`connected ${(await page.textContent('[data-wallet-status]')).trim()}`);

// Play so there is something to own. The opening wallet holds only 20 coins,
// so buy while affordable rather than a fixed number of times — a fixed count
// would click a disabled button once the coins run out.
for (let i = 0; i < 10; i += 1) {
  const canBuy = await page.evaluate(
    () => !document.querySelector('[data-game-action="buy_chest"]').disabled,
  );
  if (!canBuy) break;
  await page.click('[data-game-action="buy_chest"]');
  await waitFor(150);
  await page.click('[data-game-action="open_chest"]');
  await waitFor(400);
}
const opened = await page.evaluate(
  () => window.__A3GAME_CARD_COLLECTOR__?.getState()?.economy?.chestsOpened ?? 0,
);
console.log(`opened    ${opened} chests`);
if (opened === 0) {
  console.error('nothing was opened; the claim path cannot be exercised');
  await browser.close();
  server.kill();
  process.exit(1);
}

// The button must reflect the server's claimable count, which only happens if
// /chain/claimable is reachable through the dev-server proxy.
await page.waitForFunction(
  () => {
    const btn = document.querySelector('[data-game-action="claim_cards"]');
    return btn && /Claim \d+ to wallet/.test(btn.textContent) && !btn.disabled;
  },
  { timeout: 20000 },
);
console.log(
  `claim button "${(await page.textContent('[data-game-action="claim_cards"]')).trim()}"`,
);

await page.click('[data-game-action="claim_cards"]');
await waitFor(3000);

// The outcome carries the failure reason; without printing it a broken claim
// looks identical to a slow one.
const outcome = await page.evaluate(
  () => window.__A3GAME_CARD_COLLECTOR__?.chain?.lastOutcome ?? null,
);
console.log(`outcome   ${JSON.stringify(outcome)}`);

// Poll the chain rather than the DOM: the balance landing is the real
// assertion, and it does not race with the button's label.
const state = await page.evaluate(() => window.__A3GAME_CARD_COLLECTOR__?.getState());
const expected = state.collection;
let onChain = 0n;
for (let attempt = 0; attempt < 40; attempt += 1) {
  onChain = 0n;
  for (const entry of expected) {
    onChain += await card.balanceOf(player.address, tokenIdFor(entry.name));
  }
  if (onChain > 0n) break;
  await waitFor(500);
}

let expectedTotal = 0;
for (const entry of expected) {
  const balance = await card.balanceOf(player.address, tokenIdFor(entry.name));
  expectedTotal += entry.copies;
  console.log(`  ${entry.name.padEnd(12)} game=${entry.copies} chain=${balance}`);
}

const switched = (await page.evaluate(() => window.__chainSwitchAttempts)) > 0;
const matched = Number(onChain) === expectedTotal && expectedTotal > 0;

console.log(`chain switch requested: ${switched}`);
console.log(`CLAIM IN BROWSER: ${switched && matched ? 'YES' : 'NO'}`);
if (!switched) console.log('  (ensureChain never asked the wallet to switch)');
if (!matched) console.log(`  game total=${expectedTotal} chain total=${onChain}`);
if (errors.length) console.log('console errors:', errors.slice(0, 3));

await browser.close();
server.kill();
process.exit(switched && matched ? 0 : 1);
