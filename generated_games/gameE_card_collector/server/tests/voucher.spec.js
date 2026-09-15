/**
 * Voucher signing tests.
 *
 * The important one is the last block: a voucher the server signs is fed to
 * the *real contract* running on a local EVM, and must actually mint. A
 * signature test that only checks "the server can verify its own signature"
 * would pass while the deployed contract rejected every voucher — the domain,
 * the type hash and the field order all have to agree with the Solidity side,
 * and only the Solidity side can settle that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CARD_IDS, tokenIdFor } from '@a3game/card-collector/rules';
import { VoucherSigner } from '../src/voucher.js';
import { Store } from '../src/store.js';

const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
/**
 * A well-formed player address.
 *
 * `issueFor` signs EIP-712 data, and the signer validates the address it is
 * asked to bind — so the issuing tests need a real 20-byte hex value, not a
 * convenient placeholder. Lookup-only tests can keep using anything.
 */
const PLAYER = '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199';

/** A save holding `copies` of `cardName`. */
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

describe('card identity', () => {
  it('maps names to ids consistently', () => {
    for (const [index, name] of CARD_IDS.entries()) {
      expect(tokenIdFor(name)).toBe(index);
    }
  });

  it('has no duplicate ids', () => {
    // A duplicate would make two different cards claim the same token.
    expect(new Set(CARD_IDS).size).toBe(CARD_IDS.length);
  });

  it('returns -1 for a name that is not a card', () => {
    expect(tokenIdFor('NotACard')).toBe(-1);
  });
});

describe('VoucherSigner', () => {
  let store;
  let signer;

  beforeEach(() => {
    store = new Store(':memory:');
    signer = new VoucherSigner(store, {
      chainId: 31337,
      contractAddress: CONTRACT,
      signerKey: SIGNER_KEY,
      voucherTtlSeconds: 3600,
    });
  });

  afterEach(() => store.close());

  it('reports itself configured when chain settings are present', () => {
    expect(signer.configured).toBe(true);
    expect(signer.signerAddress).toBe(
      privateKeyToAccount(SIGNER_KEY).address,
    );
  });

  it('explains what is missing when unconfigured', () => {
    const bare = new VoucherSigner(store, {});
    expect(bare.configured).toBe(false);
    // The reason is shown to players and logged for operators, so it should
    // name the variable rather than just saying "unavailable".
    expect(bare.misconfiguredReason).toContain('CHAIN_SIGNER_KEY');
  });

  it('lists every held card with what remains to claim', () => {
    const claimable = signer.claimableFor(
      '0xabc',
      saveWith([
        ['Slime', 3],
        ['Elder Wyrm', 1, 'legendary'],
      ]),
    );

    expect(claimable).toHaveLength(2);
    expect(claimable[0]).toMatchObject({
      tokenId: tokenIdFor('Slime'),
      copies: 3,
      claimed: 0,
      claimable: 3,
    });
  });

  it('subtracts what has already been claimed', () => {
    store.recordClaim('0xabc', tokenIdFor('Slime'), 2);
    const [slime] = signer.claimableFor('0xabc', saveWith([['Slime', 5]]));
    expect(slime).toMatchObject({ copies: 5, claimed: 2, claimable: 3 });
  });

  it('reports nothing claimable when the chain is already up to date', () => {
    store.recordClaim('0xabc', tokenIdFor('Slime'), 5);
    const [slime] = signer.claimableFor('0xabc', saveWith([['Slime', 5]]));
    expect(slime.claimable).toBe(0);
  });

  it('never reports a negative claimable when the chain is ahead', () => {
    // Can happen if a card is somehow minted out of band; it must not produce
    // a negative amount that would be signed into a voucher.
    store.recordClaim('0xabc', tokenIdFor('Slime'), 9);
    const [slime] = signer.claimableFor('0xabc', saveWith([['Slime', 2]]));
    expect(slime.claimable).toBe(0);
  });

  it('ignores names that are not cards', () => {
    const claimable = signer.claimableFor('0xabc', saveWith([['Bogus', 1]]));
    expect(claimable).toEqual([]);
  });

  it('signs a voucher stating the total, not an increment', async () => {
    store.recordClaim(PLAYER, tokenIdFor('Slime'), 2);
    const issued = await signer.issueFor(PLAYER, saveWith([['Slime', 5]]));

    expect(issued.vouchers).toHaveLength(1);
    // `amount` is the running total; the contract mints the difference.
    expect(issued.vouchers[0].amount).toBe(5);
    expect(issued.vouchers[0].claimable).toBe(3);
    expect(issued.vouchers[0].signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('skips cards with nothing left to claim', async () => {
    store.recordClaim(PLAYER, tokenIdFor('Slime'), 5);
    const issued = await signer.issueFor(PLAYER, saveWith([['Slime', 5]]));
    expect(issued.vouchers).toEqual([]);
  });

  it('issues a voucher per card independently', async () => {
    const issued = await signer.issueFor(
      PLAYER,
      saveWith([
        ['Slime', 1],
        ['Elder Wyrm', 2, 'legendary'],
      ]),
    );
    expect(issued.vouchers.map((v) => v.tokenId).sort()).toEqual(
      [tokenIdFor('Slime'), tokenIdFor('Elder Wyrm')].sort(),
    );
  });

  it('refuses to issue when unconfigured', async () => {
    const bare = new VoucherSigner(store, {});
    await expect(bare.issueFor('0xabc', saveWith([['Slime', 1]]))).rejects.toThrow(
      /not available/,
    );
  });

  it('only ever moves a claimed total upward', () => {
    // A stale or malicious client reporting a lower total must not erase
    // progress, which would let it re-claim the same copies.
    store.recordClaim('0xabc', tokenIdFor('Slime'), 5);
    store.recordClaim('0xabc', tokenIdFor('Slime'), 2);
    expect(store.claimedTotals('0xabc')[tokenIdFor('Slime')]).toBe(5);
  });

  it('rejects an out-of-range card id from a client', () => {
    expect(() => signer.recordClaim('0xabc', 9999, 1)).toThrow(/unknown card/);
    expect(() => signer.recordClaim('0xabc', -1, 1)).toThrow(/unknown card/);
  });

  it('rejects a nonsensical amount from a client', () => {
    expect(() => signer.recordClaim('0xabc', 0, -5)).toThrow(/non-negative/);
    expect(() => signer.recordClaim('0xabc', 0, 1.5)).toThrow(/non-negative/);
  });

  it('normalises the address so claims follow the player', () => {
    store.recordClaim('0xABC', tokenIdFor('Slime'), 3);
    const [slime] = signer.claimableFor('0xabc', saveWith([['Slime', 3]]));
    expect(slime.claimed).toBe(3);
  });
});

// The cross-boundary check — a voucher signed by *this* module being accepted
// by the *deployed* contract — lives in contracts/test/VoucherIntegration.cjs.
// It cannot live here because it needs an EVM, and it must not be faked here:
// signing and verifying with our own code proves only self-consistency, while
// the real risk is that the EIP-712 domain or field order disagrees with the
// Solidity. Only the contract can settle that.
