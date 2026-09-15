/**
 * Invariant tests: properties that must hold no matter what the player does.
 *
 * The reentrancy suite checks one class of attack. This one probes the
 * contract's economic invariants — specifically the interaction between
 * `claimedBy` (a high-water mark) and ERC-1155 transfers, which the contract
 * permits and therefore has to tolerate.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');

const VOUCHER_TYPES = {
  Voucher: [
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

describe('invariants', function () {
  let backend;
  let player;
  let other;
  let card;
  let deadline;

  beforeEach(async function () {
    [, backend, player, other] = await ethers.getSigners();
    deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

    const Factory = await ethers.getContractFactory('CardCollector');
    card = await Factory.deploy(
      await backend.getAddress(),
      'https://example.test/{id}.json',
    );
    await card.waitForDeployment();
  });

  async function sign(voucher) {
    return backend.signTypedData(
      {
        name: 'CardCollector',
        version: '1',
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await card.getAddress(),
      },
      VOUCHER_TYPES,
      voucher,
    );
  }

  async function claim(to, tokenId, amount, nonce) {
    const voucher = { to, tokenId, amount, nonce, deadline };
    await card.connect(
      to === player.address ? player : other,
    ).redeem(voucher, await sign(voucher));
    return voucher;
  }

  it('never lets totalMinted disagree with what has been minted', async function () {
    await claim(player.address, 0, 3, 1);
    await claim(player.address, 0, 7, 2);
    await claim(other.address, 0, 2, 3);

    // Every mint is accounted for exactly once.
    expect(await card.totalMinted(0)).to.equal(9n);
    expect(await card.balanceOf(player.address, 0)).to.equal(7n);
    expect(await card.balanceOf(other.address, 0)).to.equal(2n);
  });

  it('documents that transfers strand the claimed high-water mark', async function () {
    // A real, if benign, limitation — demonstrated rather than asserted.
    //
    // `claimedBy` records the most a player has ever claimed for a card. It is
    // a high-water mark, so transferring cards away does not lower it. If the
    // player later draws more copies in-game, the server offers a voucher for
    // their new total, and the contract mints only the difference — which
    // leaves the player with fewer on chain than their in-game copy count.
    //
    // This is the price of allowing transfers while keying claims off a
    // monotonic counter. It is not exploitable (a player cannot mint more than
    // their largest signed total) and the loss is self-inflicted, but it is
    // worth knowing about before enabling a secondary market.
    await claim(player.address, 0, 5, 1);
    expect(await card.balanceOf(player.address, 0)).to.equal(5n);

    // Give them all away.
    await card
      .connect(player)
      .safeTransferFrom(player.address, other.address, 0, 5, '0x');
    expect(await card.balanceOf(player.address, 0)).to.equal(0n);
    // The high-water mark is untouched.
    expect(await card.claimedBy(player.address, 0)).to.equal(5n);

    // They draw more in-game and claim a voucher for the new total of 10.
    await claim(player.address, 0, 10, 2);

    // The contract mints 10 - 5 = 5, so the player holds 5 while the game
    // believes they hold 10. The difference is exactly what they transferred.
    expect(await card.balanceOf(player.address, 0)).to.equal(5n);
    expect(await card.claimedBy(player.address, 0)).to.equal(10n);
  });

  it('cannot mint more than the largest signed total, ever', async function () {
    // The core safety property. Any sequence of valid vouchers must leave the
    // balance at or below the largest `amount` the signer ever authorised for
    // that player and card.
    const amounts = [1, 4, 2, 8, 3, 8];
    let nonce = 1;
    for (const amount of amounts) {
      try {
        await claim(player.address, 5, amount, nonce++);
      } catch {
        // Vouchers that would not increase the total are rejected, which is
        // the guard doing its job.
      }
    }
    expect(await card.balanceOf(player.address, 5)).to.equal(8n);
  });

  it('keeps each card independent', async function () {
    await claim(player.address, 0, 5, 1);
    // A voucher for card 1 must not be able to reach card 0's claimed total.
    await claim(player.address, 1, 2, 2);
    expect(await card.balanceOf(player.address, 0)).to.equal(5n);
    expect(await card.balanceOf(player.address, 1)).to.equal(2n);
    expect(await card.claimedBy(player.address, 0)).to.equal(5n);
    expect(await card.claimedBy(player.address, 1)).to.equal(2n);
  });

  it('rejects a zero-amount voucher', async function () {
    // `amount > already` is strict, so a voucher for 0 can never mint.
    const voucher = { to: player.address, tokenId: 0, amount: 0, nonce: 1, deadline };
    await expect(
      card.connect(player).redeem(voucher, await sign(voucher)),
    ).to.be.revertedWith('nothing new to claim');
  });

  it('accepts a live deadline and rejects an elapsed one', async function () {
    // The exact boundary (`block.timestamp == deadline`) is not observable
    // from a test: the redemption transaction is mined in a *later* block, so
    // its timestamp is already past a deadline read from the current block.
    // Asserting the boundary would only be testing the harness's clock.
    const now = (await ethers.provider.getBlock('latest')).timestamp;

    const live = { to: player.address, tokenId: 0, amount: 1, nonce: 1, deadline: now + 60 };
    await card.connect(player).redeem(live, await sign(live));
    expect(await card.balanceOf(player.address, 0)).to.equal(1n);

    const elapsed = { to: player.address, tokenId: 1, amount: 1, nonce: 2, deadline: now - 1 };
    await expect(
      card.connect(player).redeem(elapsed, await sign(elapsed)),
    ).to.be.revertedWith('voucher expired');
  });

  it('rejects a voucher carrying a far-future deadline only if unused', async function () {
    // A long deadline is not itself a vulnerability — the nonce still makes
    // the voucher single-use — but it does widen the window in which a leaked
    // voucher is useful. Recorded here so the trade-off is explicit rather
    // than discovered later.
    const far = (await ethers.provider.getBlock('latest')).timestamp + 365 * 24 * 3600;
    const voucher = { to: player.address, tokenId: 0, amount: 1, nonce: 1, deadline: far };
    const signature = await sign(voucher);

    await card.connect(player).redeem(voucher, signature);
    await expect(
      card.connect(player).redeem(voucher, signature),
    ).to.be.revertedWith('voucher already used');
  });

  it('has an immutable signer and no way to redirect it', async function () {
    // The signer is the whole trust model. If it could be changed, a
    // compromised owner key would let an attacker mint without limit.
    expect(await card.signer()).to.equal(await backend.getAddress());
    // No setter exists; `signer` is `immutable`, so this is structural rather
    // than a policy the owner could change.
    expect(card.interface.getFunction('setSigner')).to.equal(null);
  });
});
