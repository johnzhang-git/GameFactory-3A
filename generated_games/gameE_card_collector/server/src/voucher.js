/**
 * Off-chain claim authorisation: EIP-712 vouchers.
 *
 * This is where the "studio pays nothing" property of the whole design lives.
 * The server never sends a transaction. It signs a statement saying "this
 * address is entitled to N of card K", and the player submits it themselves
 * and pays the gas. If the player never claims, nothing is ever minted and
 * nothing is ever spent.
 *
 * The voucher is deliberately absolute rather than incremental: it states the
 * player's *total* holdings of that card, not an amount to add. The contract
 * mints the difference against what it has already issued. That makes a
 * re-issued or replayed voucher harmless — it can only ever top up to the
 * stated total — which is a far easier property to reason about than
 * accumulating deltas.
 */

import { randomBytes } from 'node:crypto';
import { CARD_IDS, tokenIdFor } from '@a3game/card-collector/rules';
import { encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HttpError } from './errors.js';

/** The EIP-712 domain and struct, matching `contracts/CardCollector.sol`. */
const VOUCHER_TYPES = {
  Voucher: [
    { name: 'to', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/**
 * Just the `redeem` entry, not the whole compiled ABI.
 *
 * The server builds the transaction calldata (see `encodeClaim`), so this is
 * the only piece of the ABI it needs to know about.
 */
const REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'voucher',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
];

/**
 * Encode the `redeem` call for one voucher.
 *
 * The encoding happens here, not in the browser, on purpose. `redeem` takes a
 * tuple and a dynamic `bytes`, so hand-encoding it client-side means getting
 * ABI head/tail layout and a Keccak function selector right — a class of bug
 * that produces a valid-looking transaction which the contract rejects. The
 * server already has viem and owns the contract address, so it is both the
 * cheaper and the safer place to do it. The browser's job shrinks to
 * "send these bytes to this address".
 *
 * @param {{to: string, tokenId: number, amount: number, nonce: string,
 *          deadline: number}} voucher
 * @param {string} signature
 */
export function encodeClaim(voucher, signature) {
  return encodeFunctionData({
    abi: REDEEM_ABI,
    functionName: 'redeem',
    args: [
      {
        to: voucher.to,
        tokenId: BigInt(voucher.tokenId),
        amount: BigInt(voucher.amount),
        nonce: BigInt(voucher.nonce),
        deadline: BigInt(voucher.deadline),
      },
      signature,
    ],
  });
}

export class VoucherSigner {
  /**
   * @param {import('./store.js').Store} store
   * @param {{chainId?: number, contractAddress?: string, signerKey?: string,
   *          voucherTtlSeconds?: number}} config
   */
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.account = config.signerKey
      ? privateKeyToAccount(config.signerKey)
      : null;
  }

  /** True when the server can actually issue vouchers. */
  get configured() {
    return Boolean(
      this.account && this.config.contractAddress && this.config.chainId,
    );
  }

  /** The address players' vouchers must be signed by, or null. */
  get signerAddress() {
    return this.account?.address ?? null;
  }

  /** Why issuance is unavailable, phrased for an operator reading a log. */
  get misconfiguredReason() {
    if (!this.account) return 'CHAIN_SIGNER_KEY is not set';
    if (!this.config.contractAddress) return 'CHAIN_CONTRACT_ADDRESS is not set';
    if (!this.config.chainId) return 'CHAIN_ID is not set';
    return null;
  }

  /** The EIP-712 domain this server signs under. */
  domain() {
    return {
      name: 'CardCollector',
      version: '1',
      chainId: this.config.chainId,
      verifyingContract: this.config.contractAddress,
    };
  }

  /**
   * Build (but do not sign) the voucher for one card.
   *
   * @param {string} address the player, who must be the one to submit it
   * @param {number} tokenId
   * @param {number} amount the player's total holdings as the server sees them
   */
  buildVoucher(address, tokenId, amount) {
    const now = Math.floor(Date.now() / 1000);
    return {
      to: address,
      tokenId,
      amount,
      /**
       * A random 256-bit nonce, not a timestamp.
       *
       * A clock-derived nonce collides: issuing vouchers for several cards is
       * a synchronous loop, so every voucher in one response would carry the
       * same second. The contract spends nonces globally, so the player could
       * redeem only the first and the rest would be rejected as replays.
       *
       * Randomness also survives a restart, where a counter would have to be
       * persisted and rewound carefully to avoid reuse.
       */
      nonce: BigInt(`0x${randomBytes(32).toString('hex')}`).toString(),
      deadline: now + this.config.voucherTtlSeconds,
    };
  }

  /**
   * List every card the player holds and how much of it they could claim.
   *
   * A card is claimable when the player's copy count exceeds what the server
   * has already recorded as claimed for it.
   *
   * @param {string} address
   * @param {object} save the player's save, as stored
   */
  claimableFor(address, save) {
    const claimed = this.store.claimedTotals(address);
    return (save?.cards ?? [])
      .map((card) => {
        const tokenId = tokenIdFor(card.name);
        if (tokenId < 0) return null;
        const alreadyClaimed = claimed[tokenId] ?? 0;
        return {
          tokenId,
          name: card.name,
          rarity: card.rarity,
          copies: card.copies,
          claimed: alreadyClaimed,
          claimable: Math.max(0, card.copies - alreadyClaimed),
        };
      })
      .filter(Boolean);
  }

  /**
   * Sign vouchers for everything the player can currently claim.
   *
   * Returns one voucher per card that has something new, ready for the client
   * to submit. Nothing is written to the chain here, and the claimed totals
   * are *not* advanced — they move only when the player tells us the mint
   * succeeded, so a voucher that is never submitted does not cost the player
   * the ability to claim later.
   *
   * @param {string} address
   * @param {object} save
   */
  async issueFor(address, save) {
    if (!this.configured) {
      throw new HttpError(
        503,
        `card claiming is not available (${this.misconfiguredReason})`,
      );
    }

    const claimable = this.claimableFor(address, save).filter(
      (entry) => entry.claimable > 0,
    );

    const vouchers = [];
    for (const entry of claimable) {
      const voucher = this.buildVoucher(address, entry.tokenId, entry.copies);
      const signature = await this.account.signTypedData({
        domain: this.domain(),
        types: VOUCHER_TYPES,
        primaryType: 'Voucher',
        message: voucher,
      });
      vouchers.push({
        ...voucher,
        signature,
        card: { name: entry.name, rarity: entry.rarity },
        claimable: entry.claimable,
        /**
         * A ready-to-send transaction, so the client never has to encode.
         *
         * `to` is the contract and `from` is filled in by the wallet. This is
         * what the client passes to `eth_sendTransaction`.
         */
        transaction: {
          to: this.config.contractAddress,
          data: encodeClaim(voucher, signature),
          value: '0x0',
        },
      });
    }

    return {
      contractAddress: this.config.contractAddress,
      chainId: this.config.chainId,
      signer: this.signerAddress,
      vouchers,
    };
  }

  /**
   * Record that a voucher was minted, so the next issue tops up from there.
   *
   * The client reports the outcome because the server does not watch the
   * chain. This is a convenience, not a trust boundary: the *contract*
   * enforces cumulative totals, so a client that lies to us here cannot mint
   * anything it was not already entitled to.
   *
   * @param {string} address
   * @param {number} tokenId
   * @param {number} amount the total now held on chain
   */
  recordClaim(address, tokenId, amount) {
    if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= CARD_IDS.length) {
      throw new HttpError(400, 'unknown card id');
    }
    if (!Number.isInteger(amount) || amount < 0) {
      throw new HttpError(400, 'amount must be a non-negative integer');
    }
    this.store.recordClaim(address, tokenId, amount);
    return { ok: true, tokenId, amount };
  }
}

export { CARD_IDS, tokenIdFor };
