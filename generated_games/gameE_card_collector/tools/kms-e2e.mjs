/**
 * Does a KMS-signed voucher actually mint on chain?
 *
 * This is the check that matters for the KMS work, and it cannot be a unit
 * test. The unit tests prove the DER conversion is correct in isolation; only
 * submitting the result to the deployed contract proves the converted
 * signature is one OpenZeppelin accepts.
 *
 * The stub KMS returns **DER**, exactly as the real service does. It is
 * deliberately not viem's signer: viem emits raw low-`s` signatures, so
 * stubbing with it would bypass the DER parsing and the `s` normalisation and
 * the whole exercise would be vacuous.
 *
 * The server is driven in-process with an injected key source, so nothing is
 * patched on disk and the real `createAwsKmsKeySource` path stays untouched.
 *
 * Usage (run from the project root; the script starts its own chain):
 *
 *   npx hardhat compile
 *   node tools/kms-e2e.mjs
 */

import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createKmsKeySource, verifyKeySource } from '../server/src/key-source.js';
import { startServer } from '../server/src/server.js';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8546';
const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a private chain for this run.
 *
 * Reusing a long-lived node makes the run depend on whatever previous runs
 * left behind — nonces in particular, which show up as "nonce too low" on the
 * second transaction and look like a bug in the code under test. A fresh node
 * per run makes the result mean something.
 */
const node = spawn('npx', ['hardhat', 'node', '--port', new URL(RPC).port], {
  cwd: process.cwd(),
  shell: true,
  stdio: 'ignore',
});
await waitFor(9000);

const provider = new ethers.JsonRpcProvider(RPC);
/**
 * The deployer sends two transactions back to back — the contract deploy and
 * the player's funding — so it needs the same nonce management the player
 * does. A plain Wallet caches the nonce from before the first send landed and
 * the second is rejected, which is exactly what happened here.
 */
const deployer = new ethers.NonceManager(
  new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider,
  ),
);

// The key the "KMS" holds. The server never sees it — only the DER it returns.
const KMS_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signerAccount = privateKeyToAccount(KMS_KEY);
const signerAddr = signerAccount.address;

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
console.log(`signer    ${signerAddr}`);

/** Minimal DER encoding of a positive INTEGER. */
function derInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = [...Buffer.from(hex, 'hex')];
  if (bytes[0] & 0x80) bytes = [0x00, ...bytes]; // DER integers are signed
  return [0x02, bytes.length, ...bytes];
}

/**
 * A stand-in KMS: signs a digest with a raw key, then returns DER.
 *
 * Mirrors what AWS does — the caller gets an opaque DER blob with no recovery
 * id and no `s` normalisation, which is the entire difficulty.
 */
const stubKms = {
  async sign(/** @type {Uint8Array} */ digestBytes) {
    const raw = await signerAccount.sign({
      hash: `0x${Buffer.from(digestBytes).toString('hex')}`,
    });
    const r = BigInt(`0x${raw.slice(2, 66)}`);
    const s = BigInt(`0x${raw.slice(66, 130)}`);
    // Note: `s` is passed through unmodified. A real KMS does the same, and
    // half the time that means a high `s` the contract would reject.
    const body = [...derInteger(r), ...derInteger(s)];
    return Uint8Array.from([0x30, body.length, ...body]);
  },
};

const keySource = createKmsKeySource({
  signerAddress: signerAddr,
  kind: 'kms-stub',
  sign: stubKms.sign,
});

// Exercises the same startup check the server runs.
await verifyKeySource(keySource);
console.log('key source verified');

const app = await startServer({
  port: 0,
  dbPath: ':memory:',
  chainId: 31337,
  contractAddress,
  keySource,
  verifyKeyOnBoot: true,
});
const base = `http://127.0.0.1:${app.port}`;
console.log(`server    ${base}`);

const player = ethers.Wallet.createRandom();
// Fund, and wait for the receipt before reading the player's nonce — a
// `getTransactionCount` racing the funding transaction returns 0 and the
// first mint is then rejected as a stale nonce.
await (
  await deployer.sendTransaction({ to: player.address, value: ethers.parseEther('1') })
).wait();

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

const challenge = await post('/auth/nonce', { address: player.address });
const message = [
  'localhost:5199 wants you to sign in with your Ethereum account:',
  player.address,
  '',
  'Sign in.',
  '',
  'URI: http://localhost:5199',
  'Version: 1',
  'Chain ID: 1',
  `Nonce: ${challenge.body.nonce}`,
  `Issued At: ${new Date().toISOString()}`,
].join('\n');
const session = await post('/auth/verify', {
  message,
  signature: await player.signMessage(message),
});
const token = session.body.token;
console.log(`signed in ${session.body.address}`);

for (let i = 0; i < 3; i += 1) {
  await post('/game/buy', {}, token);
  await post('/game/open', {}, token);
}

const issued = await post('/chain/vouchers', {}, token);
console.log(`vouchers  ${issued.body.vouchers.length}`);

// The player pays their own gas — the point of lazy minting.
//
// `NonceManager` is ethers' own answer to sending several transactions in a
// row: a bare Wallet reuses the nonce it cached before the first send landed,
// so the second transaction is rejected as "nonce too low". The browser path
// hit the same wall from the other side (see `session.claimAll`).
const funded = new ethers.NonceManager(new ethers.Wallet(player.privateKey, provider));

let minted = 0;
let failed = 0;
for (const voucher of issued.body.vouchers) {
  try {
    const tx = await funded.sendTransaction({
      to: voucher.transaction.to,
      data: voucher.transaction.data,
    });
    const receipt = await tx.wait();
    if (receipt.status === 1) minted += 1;
    else failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`  card ${voucher.tokenId}: REVERTED ${error.shortMessage ?? ''}`);
  }
}
console.log(`minted    ${minted} ok, ${failed} failed`);

for (const voucher of issued.body.vouchers) {
  const balance = await card.balanceOf(player.address, voucher.tokenId);
  console.log(
    `  card ${String(voucher.tokenId).padStart(2)} chain=${balance} voucher=${voucher.amount}`,
  );
}

const ok = failed === 0 && minted > 0;
console.log(`KMS-SIGNED VOUCHERS MINT ON CHAIN: ${ok ? 'YES' : 'NO'}`);

await new Promise((resolve) => app.server.close(resolve));
app.store.close();
node.kill();
process.exit(ok ? 0 : 1);
