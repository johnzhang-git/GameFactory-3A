/**
 * Server-side randomness for chest draws.
 *
 * `catalog.js` ships a seeded PRNG so that a draw is reproducible in a test.
 * That is precisely the wrong property on a server: the seed used to come from
 * the client, so a player who knew it could predict every rarity they would
 * roll — and, with the draw loop in the browser, could simply reroll until the
 * result suited them.
 *
 * The draw rules are untouched; only the number source changes.
 */

import { randomBytes } from 'node:crypto';

/**
 * A `[0, 1)` generator backed by the platform CSPRNG.
 *
 * Values are pulled from a buffer in 4-byte chunks so a burst of draws costs
 * one syscall per refill rather than one per roll.
 *
 * @param {number} [poolBytes]
 * @returns {() => number}
 */
export function createCryptoRandom(poolBytes = 4096) {
  let pool = randomBytes(poolBytes);
  let offset = 0;

  return function next() {
    if (offset + 4 > pool.length) {
      pool = randomBytes(poolBytes);
      offset = 0;
    }
    const value = pool.readUInt32BE(offset);
    offset += 4;
    // 2**32 is exclusive, so this lands in [0, 1).
    return value / 4294967296;
  };
}
