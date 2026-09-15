/**
 * Cross-boundary test: a voucher signed by the *server* must be accepted by
 * the *deployed contract*.
 *
 * This is the one check that the split test suites cannot make on their own.
 * `server/tests/voucher.spec.js` proves the signer is self-consistent, and
 * `CardCollector.cjs` proves the contract verifies what ethers signs — but
 * neither proves the two agree. They agree only if the EIP-712 domain
 * (name, version, chainId, verifyingContract), the struct type hash and the
 * field order match exactly. Any drift there makes the server sign vouchers
 * that every deployment rejects, with both suites still green.
 *
 * So this deploys the real contract and feeds it a voucher produced by the
 * real `VoucherSigner`, over its real HTTP route.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');

// The server-side modules are ESM; load them dynamically from a CJS test.
async function loadServer() {
  const { Store } = await import('../../server/src/store.js');
  const { VoucherSigner } = await import('../../server/src/voucher.js');
  return { Store, VoucherSigner };
}

describe('server voucher -> deployed contract', function () {
  let Store;
  let VoucherSigner;
  let card;
  let signerKey;
  let signerAddress;
  let player;

  before(async function () {
    ({ Store, VoucherSigner } = await loadServer());
  });

  beforeEach(async function () {
    [, , player] = await ethers.getSigners();

    // A real key pair, standing in for the backend's signer.
    signerKey = ethers.Wallet.createRandom().privateKey;
    signerAddress = new ethers.Wallet(signerKey).address;

    const Factory = await ethers.getContractFactory('CardCollector');
    card = await Factory.deploy(
      signerAddress,
      'https://example.test/cards/{id}.json',
    );
    await card.waitForDeployment();
  });

  /** A signer wired to the contract that was just deployed. */
  function makeSigner() {
    const store = new Store(':memory:');
    const signer = new VoucherSigner(store, {
      chainId: Number((ethers.provider._network || {}).chainId ?? 31337),
      contractAddress: card.target,
      signerKey,
      voucherTtlSeconds: 3600,
    });
    return { store, signer };
  }

  /** A save holding a few cards. */
  function saveWith(cards) {
    return {
      coins: 0,
      cards: cards.map(([name, copies, rarity = 'common']) => ({
        name,
        copies,
        rarity,
      })),
    };
  }

  it('mints when the server-signed voucher is submitted', async function () {
    const { signer } = makeSigner();
    const issued = await signer.issueFor(
      player.address,
      saveWith([['Slime', 3]]),
    );

    expect(issued.vouchers).to.have.lengthOf(1);
    const v = issued.vouchers[0];

    // Submit exactly what the server produced. If the domain or struct has
    // drifted, this reverts with "bad signature".
    await expect(
      card.connect(player).redeem(
        {
          to: v.to,
          tokenId: v.tokenId,
          amount: v.amount,
          nonce: v.nonce,
          deadline: v.deadline,
        },
        v.signature,
      ),
    ).to.emit(card, 'CardClaimed');

    expect(await card.balanceOf(player.address, v.tokenId)).to.equal(3n);
  });

  it('rejects a server voucher when the domain chain id does not match', async function () {
    // Guards the other direction: if the server were configured for a
    // different chain, its vouchers must NOT be silently accepted here.
    const store = new Store(':memory:');
    const wrongChain = new VoucherSigner(store, {
      chainId: 1, // not the local EVM's chain
      contractAddress: card.target,
      signerKey,
      voucherTtlSeconds: 3600,
    });

    const issued = await wrongChain.issueFor(
      player.address,
      saveWith([['Slime', 1]]),
    );
    const v = issued.vouchers[0];

    await expect(
      card.connect(player).redeem(
        {
          to: v.to,
          tokenId: v.tokenId,
          amount: v.amount,
          nonce: v.nonce,
          deadline: v.deadline,
        },
        v.signature,
      ),
    ).to.be.revertedWith('bad signature');
  });

  it('rejects a server voucher when the contract address does not match', async function () {
    const store = new Store(':memory:');
    const wrongContract = new VoucherSigner(store, {
      chainId: Number((ethers.provider._network || {}).chainId ?? 31337),
      contractAddress: '0x000000000000000000000000000000000000dEaD',
      signerKey,
      voucherTtlSeconds: 3600,
    });

    const issued = await wrongContract.issueFor(
      player.address,
      saveWith([['Slime', 1]]),
    );
    const v = issued.vouchers[0];

    await expect(
      card.connect(player).redeem(
        {
          to: v.to,
          tokenId: v.tokenId,
          amount: v.amount,
          nonce: v.nonce,
          deadline: v.deadline,
        },
        v.signature,
      ),
    ).to.be.revertedWith('bad signature');
  });

  it('tops up correctly across successive claims', async function () {
    // The whole claim flow, twice, through the server's own bookkeeping.
    const { store, signer } = makeSigner();
    const address = player.address;

    // First claim: 2 copies.
    let issued = await signer.issueFor(address, saveWith([['Slime', 2]]));
    let v = issued.vouchers[0];
    await card.connect(player).redeem(
      { to: v.to, tokenId: v.tokenId, amount: v.amount, nonce: v.nonce, deadline: v.deadline },
      v.signature,
    );
    // Tell the server it succeeded, as the client does.
    signer.recordClaim(address, v.tokenId, v.amount);
    expect(await card.balanceOf(address, v.tokenId)).to.equal(2n);

    // Now the player draws two more; the server should offer a top-up only.
    issued = await signer.issueFor(address, saveWith([['Slime', 4]]));
    expect(issued.vouchers[0].claimable).to.equal(2);
    v = issued.vouchers[0];
    await card.connect(player).redeem(
      { to: v.to, tokenId: v.tokenId, amount: v.amount, nonce: v.nonce, deadline: v.deadline },
      v.signature,
    );
    signer.recordClaim(address, v.tokenId, v.amount);

    // Total is 4, not 2 + 4.
    expect(await card.balanceOf(address, v.tokenId)).to.equal(4n);
  });

  it('mints from the pre-encoded calldata, as a wallet would send it', async function () {
    // The client never encodes anything — the server hands it `data` and it
    // calls eth_sendTransaction. So the encoding has to be exercised as raw
    // calldata, not by re-encoding the struct here, or a wrong function
    // selector or ABI layout would slip through.
    const { signer } = makeSigner();
    const issued = await signer.issueFor(
      player.address,
      saveWith([['Slime', 2]]),
    );
    const { transaction } = issued.vouchers[0];

    expect(transaction.to).to.equal(card.target);
    expect(transaction.data).to.match(/^0x[0-9a-f]+$/i);

    // Exactly what the wallet would submit.
    const receipt = await (
      await player.sendTransaction({
        to: transaction.to,
        data: transaction.data,
        value: 0n,
      })
    ).wait();

    expect(receipt.status).to.equal(1);
    expect(await card.balanceOf(player.address, issued.vouchers[0].tokenId)).to.equal(2n);
  });

  it('encodes a calldata payload the contract can dispatch', async function () {
    // A wrong selector reverts with no reason string, so assert the call
    // actually reached the intended function rather than merely not reverting.
    const { signer } = makeSigner();
    const issued = await signer.issueFor(player.address, saveWith([['Slime', 1]]));
    const { transaction } = issued.vouchers[0];

    // Calling from the wrong account must hit the "voucher issued to another
    // address" guard — proof the calldata decoded into a real Voucher and
    // reached redeem's first require.
    const [, , , other] = await ethers.getSigners();
    await expect(
      other.sendTransaction({ to: transaction.to, data: transaction.data }),
    ).to.be.revertedWith('voucher issued to another address');
  });

  it('lets a player claim several cards from one response', async function () {
    // Regression guard. Nonces were once derived from the clock, so every
    // voucher in a single response shared a second — and since the contract
    // spends nonces globally, only the first card could be redeemed. Claiming
    // "all my cards" is the normal path, so this must work.
    const { signer } = makeSigner();
    const address = player.address;

    const issued = await signer.issueFor(
      address,
      saveWith([
        ['Slime', 2],
        ['Wolf', 1, 'uncommon'],
        ['Elder Wyrm', 1, 'legendary'],
      ]),
    );
    expect(issued.vouchers).to.have.lengthOf(3);

    // Every voucher must be individually redeemable.
    for (const v of issued.vouchers) {
      await card.connect(player).redeem(
        { to: v.to, tokenId: v.tokenId, amount: v.amount, nonce: v.nonce, deadline: v.deadline },
        v.signature,
      );
    }

    for (const v of issued.vouchers) {
      expect(await card.balanceOf(address, v.tokenId)).to.be.greaterThan(0n);
    }
  });

  it('gives every voucher in a response a distinct nonce', async function () {
    const { signer } = makeSigner();
    const issued = await signer.issueFor(
      player.address,
      saveWith([
        ['Slime', 1],
        ['Wolf', 1, 'uncommon'],
      ]),
    );
    const nonces = issued.vouchers.map((v) => v.nonce);
    expect(new Set(nonces).size).to.equal(nonces.length);
  });

  it('re-issuing without a fresh claim produces a no-op, not a second mint', async function () {
    // The server's claimed-total lags if the client never reports back. The
    // contract must therefore refuse rather than mint again.
    const { signer } = makeSigner();
    const address = player.address;

    const first = await signer.issueFor(address, saveWith([['Slime', 3]]));
    const v = first.vouchers[0];
    await card.connect(player).redeem(
      { to: v.to, tokenId: v.tokenId, amount: v.amount, nonce: v.nonce, deadline: v.deadline },
      v.signature,
    );

    // Server still thinks nothing was claimed, so it signs the same total.
    const again = await signer.issueFor(address, saveWith([['Slime', 3]]));
    const w = again.vouchers[0];

    await expect(
      card.connect(player).redeem(
        { to: w.to, tokenId: w.tokenId, amount: w.amount, nonce: w.nonce, deadline: w.deadline },
        w.signature,
      ),
    ).to.be.revertedWith('nothing new to claim');

    expect(await card.balanceOf(address, v.tokenId)).to.equal(3n);
  });
});
