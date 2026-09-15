/**
 * The card-collector game rules: the chest loop and the collection.
 *
 * This is the single authoritative simulation. It composes the economy
 * with a seeded chest randomizer, and exposes a public surface the UI can
 * subscribe to and command without ever touching three.js. No rendering,
 * no DOM, no framework here — just the rules, so a headless test can buy,
 * open, and wait out the income loop end to end.
 */

import {
  ECONOMY,
  availableRarities,
  createSeededRandom,
  goldChestPool,
  pickCardName,
  rollRarity,
} from './catalog.js';
import { CardCollectionEconomy } from './economy.js';

/** Game lifecycle states, for the HUD banner. */
export const GAME_PHASE = Object.freeze({
  IDLE: 'idle',
  /** A chest has been bought and is animating open; no new purchase yet. */
  OPENING: 'opening',
});

export class CardCollectorGame {
  /**
   * @param {{seed?: number, economy?: CardCollectionEconomy}} [options]
   */
  constructor(options = {}) {
    const seed = options.seed ?? 1;
    this.random = createSeededRandom(seed);
    this.economy = options.economy ?? new CardCollectionEconomy();
    this.phase = GAME_PHASE.IDLE;
    /** @type {import('./economy.js').ChestResult | null} */
    this.lastResult = null;
    /** @type {Set<Function>} */
    this._listeners = new Set();
  }

  /** Subscribe to every game change. Returns an unsubscribe function. */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    for (const listener of this._listeners) {
      try {
        listener(this);
      } catch (error) {
        // A broken listener must not take down the game loop.
        console.error('[card-collector] listener error', error);
      }
    }
  }

  /** Buy a chest if affordable. Returns true on success. */
  buyChest() {
    if (!this.economy.buyChest()) return false;
    this._emit();
    return true;
  }

  /** Buy a gold chest if unlocked and affordable. Returns true on success. */
  buyGoldChest() {
    if (!this.economy.buyGoldChest()) return false;
    this._emit();
    return true;
  }

  /**
   * Open an owned chest: roll a rarity and a card, then apply it.
   *
   * The draw pool is every rarity unlocked at the current prestige.
   *
   * @returns {import('./economy.js').ChestResult | null}
   */
  openChest() {
    return this._open(availableRarities(this.economy.prestige));
  }

  /**
   * Open a gold chest: same as `openChest`, but the draw pool is every
   * unlocked rarity at or above rare.
   *
   * @returns {import('./economy.js').ChestResult | null}
   */
  openGoldChest() {
    return this._open(goldChestPool(this.economy.prestige));
  }

  /** Roll against `pool`, apply the draw, and notify listeners. */
  _open(pool) {
    const rarity = rollRarity(this.random, pool);
    const name = pickCardName(this.random, rarity);
    this.lastResult = this.economy.applyDraw(name, rarity);
    this.phase = GAME_PHASE.IDLE;
    this._emit();
    return this.lastResult;
  }

  /**
   * Reset the run for prestige, banking the run's lifetime income as points.
   * Returns the prestige points granted.
   */
  prestige() {
    const gain = this.economy.prestigeReset();
    this.phase = GAME_PHASE.IDLE;
    this._emit();
    return gain;
  }

  /**
   * Advance the simulation by `deltaSeconds` and mint passive income.
   *
   * @param {number} deltaSeconds
   * @returns {number} coins minted this step
   */
  update(deltaSeconds) {
    const minted = this.economy.update(deltaSeconds);
    if (minted > 0) this._emit();
    return minted;
  }

  /** The full observable state, used by both the HUD and tests. */
  getState() {
    const economy = this.economy.getState();
    return {
      phase: this.phase,
      lastResult: this.lastResult ? this.lastResult.toJSON() : null,
      economy,
      collection: this.economy.collectionList().map((card) => ({
        name: card.name,
        rarity: card.rarity,
        level: card.level,
        // The cap this card was drawn under, so the UI can show "Lv3/7".
        maxLevel: card.maxLevel,
        copies: card.copies,
        incomePerTick: card.incomePerTick(),
      })),
    };
  }
}
