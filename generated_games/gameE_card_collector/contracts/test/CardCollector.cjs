/**
 * Contract tests, executed against a real EVM (Hardhat's in-process node).
 *
 * The interesting cases are the ways a voucher can be abused, so those get the
 * most attention: replay, theft, forgery, and expiry. Each is a real attack
 * that a lazy-mint design invites if the signature does not bind enough.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');

const BASE_URI = 'https://example.test/cards/{id}.json';
const TOKEN_SLIME = 0;
const TOKEN_WYRM = 24;

/** The EIP-712 struct the contract verifies. Must match `CardCollector.sol`. */
const VOUCHER_TYPES = {
  Voucher: [
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

describe('CardCollector', function () {
  let owner;
  let backend; // the voucher signer
  let player;
  let attacker;
  let card;

  /** A voucher for `amount` of `tokenId`, expiring well in the future. */
  async function voucherFor(to, { tokenId = TOKEN_SLIME, amount = 1, nonce = 1, deadline } = {}) {
    const block = await ethers.provider.getBlock('latest');
    return {
      to,
      tokenId,
      amount,
      nonce,
      deadline: deadline ?? block.timestamp + 3600,
    };
  }

  /**
   * Sign a voucher with a specific contract address in the EIP-712 domain.
   *
   * The domain binds the chain and contract, so a voucher signed for one
   * deployment must not be valid on another.
   */
  async function signWith(signer, voucher, verifyingContract) {
    const domain = {
      name: 'CardCollector',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract,
    };
    return signer.signTypedData(domain, VOUCHER_TYPES, voucher);
  }

  beforeEach(async function () {
    [owner, backend, player, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('CardCollector');
    card = await Factory.deploy(await backend.getAddress(), BASE_URI);
    await card.waitForDeployment();
  });

  describe('deployment', function () {
    it('stores the voucher signer', async function () {
      expect(await card.signer()).to.equal(await backend.getAddress());
    });

    it('rejects a zero signer, which would make every forged voucher pass', async function () {
      const Factory = await ethers.getContractFactory('CardCollector');
      await expect(
        Factory.deploy(ethers.ZeroAddress, BASE_URI),
      ).to.be.revertedWith('signer required');
    });

    it('starts with no supply', async function () {
      expect(await card.totalMinted(TOKEN_SLIME)).to.equal(0n);
    });
  });

  describe('redeeming', function () {
    it('mints the card to the player who claims it', async function () {
      const voucher = await voucherFor(player.address, { amount: 3 });
      const sig = await signWith(
        backend,
        voucher,
        await card.getAddress(),
      );

      await expect(card.connect(player).redeem(voucher, sig))
        .to.emit(card, 'CardClaimed')
        .withArgs(player.address, TOKEN_SLIME, 3n, 1n);

      expect(await card.balanceOf(player.address, TOKEN_SLIME)).to.equal(3n);
      expect(await card.claimedBy(player.address, TOKEN_SLIME)).to.equal(3n);
      expect(await card.totalMinted(TOKEN_SLIME)).to.equal(3n);
    });

    it('mints only the difference on a later, larger claim', async function () {
      const first = await voucherFor(player.address, { amount: 2, nonce: 1 });
      await card
        .connect(player)
        .redeem(first, await signWith(backend, first, await card.getAddress()));

      const second = await voucherFor(player.address, { amount: 5, nonce: 2 });
      await expect(
        card
          .connect(player)
          .redeem(second, await signWith(backend, second, await card.getAddress())),
      )
        .to.emit(card, 'CardClaimed')
        .withArgs(player.address, TOKEN_SLIME, 3n, 2n);

      // Total is the voucher's amount, not the sum of both vouchers.
      expect(await card.balanceOf(player.address, TOKEN_SLIME)).to.equal(5n);
    });

    it('rejects a voucher that would not increase holdings', async function () {
      const first = await voucherFor(player.address, { amount: 4, nonce: 1 });
      await card
        .connect(player)
        .redeem(first, await signWith(backend, first, await card.getAddress()));

      // Same amount again: nothing new. Surfaced as an error so a server/client
      // desync is visible rather than silently no-opped.
      const stale = await voucherFor(player.address, { amount: 4, nonce: 2 });
      await expect(
        card
          .connect(player)
          .redeem(stale, await signWith(backend, stale, await card.getAddress())),
      ).to.be.revertedWith('nothing new to claim');
    });

    it('tracks separate cards independently', async function () {
      const a = await voucherFor(player.address, { tokenId: TOKEN_SLIME, amount: 2, nonce: 1 });
      await card.connect(player).redeem(a, await signWith(backend, a, await card.getAddress()));

      const b = await voucherFor(player.address, { tokenId: TOKEN_WYRM, amount: 1, nonce: 2 });
      await card.connect(player).redeem(b, await signWith(backend, b, await card.getAddress()));

      expect(await card.balanceOf(player.address, TOKEN_SLIME)).to.equal(2n);
      expect(await card.balanceOf(player.address, TOKEN_WYRM)).to.equal(1n);
    });
  });

  describe('abuse resistance', function () {
    it('rejects a replayed voucher', async function () {
      const voucher = await voucherFor(player.address, { amount: 1 });
      const sig = await signWith(backend, voucher, await card.getAddress());

      await card.connect(player).redeem(voucher, sig);
      // The nonce is spent, so the identical call must fail.
      await expect(
        card.connect(player).redeem(voucher, sig),
      ).to.be.revertedWith('voucher already used');
    });

    it('rejects a voucher issued to someone else', async function () {
      // The attacker obtains a valid voucher addressed to the player.
      const voucher = await voucherFor(player.address, { amount: 1 });
      const sig = await signWith(backend, voucher, await card.getAddress());

      await expect(
        card.connect(attacker).redeem(voucher, sig),
      ).to.be.revertedWith('voucher issued to another address');
    });

    it('rejects a voucher signed by anyone but the backend', async function () {
      const voucher = await voucherFor(player.address, { amount: 100 });
      const forged = await signWith(attacker, voucher, await card.getAddress());

      await expect(
        card.connect(player).redeem(voucher, forged),
      ).to.be.revertedWith('bad signature');
    });

    it('rejects a voucher whose fields were altered after signing', async function () {
      const voucher = await voucherFor(player.address, { amount: 1 });
      const sig = await signWith(backend, voucher, await card.getAddress());

      // Same signature, inflated amount.
      const tampered = { ...voucher, amount: 1000 };
      await expect(
        card.connect(player).redeem(tampered, sig),
      ).to.be.revertedWith('bad signature');
    });

    it('rejects an expired voucher', async function () {
      const block = await ethers.provider.getBlock('latest');
      const voucher = await voucherFor(player.address, {
        amount: 1,
        deadline: block.timestamp - 1,
      });
      const sig = await signWith(backend, voucher, await card.getAddress());

      await expect(
        card.connect(player).redeem(voucher, sig),
      ).to.be.revertedWith('voucher expired');
    });

    it('rejects a voucher signed for a different deployment', async function () {
      // Domain separation: a voucher for one contract must not work on another.
      const Factory = await ethers.getContractFactory('CardCollector');
      const other = await Factory.deploy(await backend.getAddress(), BASE_URI);
      await other.waitForDeployment();

      const voucher = await voucherFor(player.address, { amount: 1 });
      const sigForOther = await signWith(
        backend,
        voucher,
        await other.getAddress(),
      );

      await expect(
        card.connect(player).redeem(voucher, sigForOther),
      ).to.be.revertedWith('bad signature');
    });

    it('rejects a voucher for a different chain id', async function () {
      const voucher = await voucherFor(player.address, { amount: 1 });
      const wrongChain = await backend.signTypedData(
        {
          name: 'CardCollector',
          version: '1',
          chainId: 999999,
          verifyingContract: await card.getAddress(),
        },
        VOUCHER_TYPES,
        voucher,
      );

      await expect(
        card.connect(player).redeem(voucher, wrongChain),
      ).to.be.revertedWith('bad signature');
    });
  });

  describe('metadata', function () {
    it('returns the base uri verbatim, leaving {id} for the client', async function () {
      // OpenZeppelin's ERC1155 does NOT expand `{id}` — marketplaces and
      // wallets do that. Asserting the literal string keeps that documented
      // behaviour honest, so nothing downstream assumes the contract expands
      // it and fetches a URL containing a raw placeholder.
      expect(await card.uri(TOKEN_WYRM)).to.equal(
        'https://example.test/cards/{id}.json',
      );
    });

    it('lets the owner update the base uri', async function () {
      await card.setUri('https://cdn.test/{id}');
      expect(await card.uri(TOKEN_SLIME)).to.equal('https://cdn.test/{id}');
    });

    it('refuses a uri change from a non-owner', async function () {
      // Left open, this would let anyone repoint every card's metadata at a
      // phishing page.
      await expect(
        card.connect(attacker).setUri('https://evil.test/{id}'),
      ).to.be.revertedWithCustomError(card, 'OwnableUnauthorizedAccount');
    });
  });

  describe('transfers', function () {
    it('allows a player to transfer a card they own', async function () {
      const voucher = await voucherFor(player.address, { amount: 2 });
      await card
        .connect(player)
        .redeem(voucher, await signWith(backend, voucher, await card.getAddress()));

      // Standard ERC-1155 behaviour. Transfers are not disabled: the contract
      // is a plain token, and restricting them would be a policy the game
      // cannot enforce anyway once the token is out.
      await card
        .connect(player)
        .safeTransferFrom(player.address, attacker.address, TOKEN_SLIME, 1, '0x');

      expect(await card.balanceOf(attacker.address, TOKEN_SLIME)).to.equal(1n);
      expect(await card.balanceOf(player.address, TOKEN_SLIME)).to.equal(1n);
    });
  });
});
