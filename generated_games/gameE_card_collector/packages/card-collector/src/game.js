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
  /** The player holds at least one bought-but-unopened chest. */
  OPENING: 'opening',
});

/** Every event kind `onChange` listeners can receive. */
export const GAME_EVENT = Object.freeze({
  /** A chest was purchased. */
  CHEST_BOUGHT: 'chest_bought',
  /** A chest was opened and a card drawn. */
  CHEST_OPENED: 'chest_opened',
  /** Passive income was banked. */
  INCOME_MINTED: 'income_minted',
  /** The run was reset for prestige. */
  PRESTIGE: 'prestige',
});

export class CardCollectorGame {
  /**
   * @param {{seed?: number, economy?: CardCollectionEconomy}} [options]
   */
  constructor(options = {}) {
    const seed = options.seed ?? 1;
    this.random = createSeededRandom(seed);
    this.economy = options.economy ?? new CardCollectionEconomy();
    /** @type {import('./economy.js').ChestResult | null} */
    this.lastResult = null;
    /** @type {Set<Function>} */
    this._listeners = new Set();
  }

  /**
   * The lifecycle phase, derived rather than stored.
   *
   * Deriving it means the phase can never disagree with the counters that
   * define it: hold an unopened chest and the game is OPENING, open it and
   * the game is IDLE, with no bookkeeping in between to get wrong.
   */
  get phase() {
    return this.economy.chestsBought > this.economy.chestsOpened
      ? GAME_PHASE.OPENING
      : GAME_PHASE.IDLE;
  }

  /**
   * Subscribe to every game event. Returns an unsubscribe function.
   *
   * The listener receives `(game, event, detail)`, where `event` is one of
   * `GAME_EVENT` and `detail` is event-specific (the draw result, the coins
   * minted, or the points granted). Listeners that only need "something
   * changed" can ignore the extra arguments.
   */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(event, detail = null) {
    for (const listener of this._listeners) {
      try {
        listener(this, event, detail);
      } catch (error) {
        // A broken listener must not take down the game loop.
        console.error('[card-collector] listener error', error);
      }
    }
  }

  /** Buy a chest if affordable. Returns true on success. */
  buyChest() {
    if (!this.economy.buyChest()) return false;
    this._emit(GAME_EVENT.CHEST_BOUGHT);
    return true;
  }

  /** Buy a gold chest if unlocked and affordable. Returns true on success. */
  buyGoldChest() {
    if (!this.economy.buyGoldChest()) return false;
    this._emit(GAME_EVENT.CHEST_BOUGHT);
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
    this._emit(GAME_EVENT.CHEST_OPENED, this.lastResult);
    return this.lastResult;
  }

  /**
   * Reset the run for prestige, banking the run's lifetime income as points.
   * Returns the prestige points granted.
   */
  prestige() {
    const gain = this.economy.prestigeReset();
    this._emit(GAME_EVENT.PRESTIGE, gain);
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
    if (minted > 0) this._emit(GAME_EVENT.INCOME_MINTED, minted);
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
