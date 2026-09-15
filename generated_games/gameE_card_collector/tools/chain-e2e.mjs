/**
 * End-to-end over a real local chain: deploy the contract, point the server at
 * it, and mint through the actual voucher flow.
 *
 * This is the only check that exercises every layer at once — contract, server
 * signing, HTTP, and the encoded calldata. Each layer has its own tests, but
 * nothing else proves they are wired to each other.
 *
 * Usage (run from the project root):
 *
 *   npx hardhat node --port 8546 &        # a real chain to mint on
 *   npx hardhat compile                   # so the artifact exists
 *   node tools/chain-e2e.mjs
 *
 * It deploys a fresh contract, starts a server pointed at it on an unused
 * port, funds a throwaway player (they pay their own gas — that is the point
 * of lazy minting), plays a few chests, claims, and then reads the balances
 * back off the chain. Exits non-zero if any mint fails, any balance disagrees
 * with its voucher, or a second claim re-issues what was already minted.
 */

import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import fs from 'node:fs';

const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8546');
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
const address = await card.getAddress();
console.log(`deployed  ${address}`);

const PORT = '8790';
const server = spawn('node', ['server/src/index.js'], {
  cwd: process.cwd(), shell: true, stdio: 'ignore',
  env: {
    ...process.env,
    DB_PATH: ':memory:',
    PORT,
    CHAIN_ID: '31337',
    CHAIN_CONTRACT_ADDRESS: address,
    CHAIN_SIGNER_KEY: SIGNER_KEY,
  },
});
await waitFor(3500);

const player = ethers.Wallet.createRandom();
// The player pays their own gas — that is the point of lazy minting — so the
// test funds them the way a real player's wallet already would be funded.
await (
  await deployer.sendTransaction({ to: player.address, value: ethers.parseEther('1') })
).wait();

const base = `http://127.0.0.1:${PORT}`;
const post = async (path, body, token) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (path, token) => {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

// --- sign in ---------------------------------------------------------------
const { body: challenge } = await post('/auth/nonce', { address: player.address });
const message = [
  'localhost:5199 wants you to sign in with your Ethereum account:',
  player.address,
  '',
  'Sign in to the card collector.',
  '',
  'URI: http://localhost:5199',
  'Version: 1',
  'Chain ID: 1',
  `Nonce: ${challenge.nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join('\n');
const session = await post('/auth/verify', {
  message,
  signature: await player.signMessage(message),
});
const token = session.body.token;
console.log(`signed in ${session.body.address}`);

// --- play so there is something to own -------------------------------------
for (let i = 0; i < 4; i += 1) {
  await post('/game/buy', {}, token);
  await post('/game/open', {}, token);
}
const state = await get('/game/state', token);
console.log(`holding   ${state.body.collection.length} cards`);

// --- claim -----------------------------------------------------------------
const claimable = await get('/chain/claimable', token);
const totalClaimable = claimable.body.cards.reduce((sum, c) => sum + c.claimable, 0);
console.log(`claimable ${totalClaimable} copies | available: ${claimable.body.available}`);
if (claimable.body.reason) console.log(`reason    ${claimable.body.reason}`);

const issued = await post('/chain/vouchers', {}, token);
console.log(`vouchers  ${issued.body.vouchers.length}`);

const connected = new ethers.Wallet(player.privateKey, provider);
let nonce = await provider.getTransactionCount(player.address);
let failures = 0;
for (const voucher of issued.body.vouchers) {
  const tx = await connected.sendTransaction({
    to: voucher.transaction.to,
    data: voucher.transaction.data,
    nonce: nonce++,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) failures += 1;
  await post('/chain/claimed', { tokenId: voucher.tokenId, amount: voucher.amount }, token);
}
console.log(`minted    ${issued.body.vouchers.length - failures} ok, ${failures} failed`);

// --- verify on chain -------------------------------------------------------
let mismatches = 0;
for (const voucher of issued.body.vouchers) {
  const balance = await card.balanceOf(player.address, voucher.tokenId);
  if (Number(balance) !== voucher.amount) mismatches += 1;
  console.log(
    `  card ${String(voucher.tokenId).padStart(2)} ${voucher.card.name.padEnd(11)}` +
      ` chain=${balance} voucher=${voucher.amount}`,
  );
}

// A second claim with nothing new must be a no-op, not a second mint.
const again = await post('/chain/vouchers', {}, token);
console.log(`re-claim  ${again.body.vouchers.length} vouchers (expect 0)`);

const ok = failures === 0 && mismatches === 0 && again.body.vouchers.length === 0;
console.log(`CLAIM WORKS END TO END: ${ok ? 'YES' : 'NO'}`);

server.kill();
process.exit(ok ? 0 : 1);
