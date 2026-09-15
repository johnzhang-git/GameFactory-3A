/**
 * Adversarial test: can `redeem` be re-entered?
 *
 * `_mint` calls `onERC1155Received` when the recipient is a contract, which is
 * a real external call *after* the state writes. The contract's own comment
 * claims "effects before interactions" protects it; this checks whether that
 * claim actually holds, rather than trusting the comment.
 *
 * Two attacks are attempted:
 *
 *  1. Re-enter `redeem` with the *same* voucher. If the nonce guard or the
 *     claimed-total guard were applied after the mint, this would double-mint.
 *
 *  2. Re-enter with a *different* voucher for the same card, which is the more
 *     interesting case: the outer call has already written `claimedBy`, so a
 *     re-entrant claim should see the updated total and mint only the
 *     difference.
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

describe('reentrancy', function () {
  let backend;
  let card;
  let attackerContract;
  let deadline;

  beforeEach(async function () {
    [, backend] = await ethers.getSigners();
    const block = await ethers.provider.getBlock('latest');
    deadline = block.timestamp + 3600;

    const Factory = await ethers.getContractFactory('CardCollector');
    card = await Factory.deploy(
      await backend.getAddress(),
      'https://example.test/{id}.json',
    );
    await card.waitForDeployment();

    const Attacker = await ethers.getContractFactory('ReentrantClaimer');
    attackerContract = await Attacker.deploy(await card.getAddress());
    await attackerContract.waitForDeployment();
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

  it('cannot double-mint by re-entering with the same voucher', async function () {
    const voucher = {
      to: await attackerContract.getAddress(),
      tokenId: 0,
      amount: 5,
      nonce: 1,
      deadline,
    };
    const signature = await sign(voucher);

    // The attacker re-enters redeem with the identical voucher during the
    // mint callback.
    await attackerContract.setAttack(voucher, signature);
    await attackerContract.attack(voucher, signature);

    // The nonce is spent and the claimed total is already 5, so the re-entrant
    // call must have reverted. Either way the balance must be exactly 5.
    const balance = await card.balanceOf(voucher.to, 0);
    expect(balance).to.equal(5n);
    expect(await card.totalMinted(0)).to.equal(5n);
  });

  it('mints only the difference when re-entering with a larger voucher', async function () {
    // Outer claim: 5. Re-entrant claim for the same card: 9. If `claimedBy`
    // were written after the mint, the inner call would see 0 and mint 9 more,
    // for a total of 14.
    const outer = {
      to: await attackerContract.getAddress(),
      tokenId: 1,
      amount: 5,
      nonce: 10,
      deadline,
    };
    const inner = { ...outer, amount: 9, nonce: 11 };

    await attackerContract.setAttack(inner, await sign(inner));
    await attackerContract.attack(outer, await sign(outer));

    const balance = await card.balanceOf(outer.to, 1);
    // 5 from the outer call, then 9 more from the inner — but the inner must
    // see `claimedBy == 5` and mint exactly 4. 5 + 4 = 9, the inner voucher's
    // stated total. Anything above 9 means the guard was bypassed.
    expect(balance).to.equal(9n);
    expect(await card.claimedBy(outer.to, 1)).to.equal(9n);
  });

  it('cannot exceed the largest signed total by chaining re-entries', async function () {
    // A claimer that re-enters on every callback would recurse; bounded here
    // to a few hops so the test terminates, but the invariant is what matters:
    // the balance never exceeds the largest total any voucher authorised.
    // The address has to be resolved before the map: an `await` inside a
    // non-async callback is a syntax error, not a rejected promise.
    const attackerAddress = await attackerContract.getAddress();
    const vouchers = [2, 4, 6].map((amount, i) => ({
      to: attackerAddress,
      tokenId: 2,
      amount,
      nonce: 100 + i,
      deadline,
    }));

    const signatures = [];
    for (const v of vouchers) signatures.push(await sign(v));

    await attackerContract.setChain(vouchers, signatures);
    await attackerContract.attack(vouchers[0], signatures[0]);

    const balance = await card.balanceOf(vouchers[0].to, 2);
    const largest = 6n;
    expect(balance).to.be.lessThanOrEqual(largest);
  });
});
