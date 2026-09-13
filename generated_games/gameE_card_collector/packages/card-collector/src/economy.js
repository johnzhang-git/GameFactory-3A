/**
 * The idle economy: coins, the chest shop, and passive income.
 *
 * Pure simulation, no rendering. `CardCollectorGame` drives it and is the
 * only place the two ideas (cards + coins) meet. Kept free of three.js so
 * a headless test can step it with an explicit delta and assert every
 * transition.
 *
 * Time is a *counter*, not wall-clock: `update(deltaSeconds)` advances the
 * passive-income timer by exactly `deltaSeconds`, so income ticks at a
 * fixed cadence whether the frame loop runs at 30 or 120 fps.
 */

import {
  ECONOMY,
  cardIncome,
  levelForCopies,
  maxedDuplicateCoins,
} from './catalog.js';

/** A collected card: identity plus how many duplicates have been drawn. */
export class CardInstance {
  /**
   * @param {string} name
   * @param {string} rarity
   * @param {number} [copies]
   */
  constructor(name, rarity, copies = 1) {
    this.name = name;
    this.rarity = rarity;
    /** How many times the chest has drawn this card (including the first). */
    this.copies = copies;
  }

  /** Upgrade by one duplicate. */
  addDuplicate() {
    this.copies += 1;
  }

  /** The card's level, derived from how many copies it has. */
  get level() {
    return levelForCopies(this.copies);
  }

  /** Income per income-tick at the current level. */
  incomePerTick() {
    return cardIncome(this.rarity, this.level);
  }
}

/** An immutable draw result, so a chest open can be logged and replayed. */
export class ChestResult {
  /**
   * @param {string} name
   * @param {string} rarity
   * @param {boolean} isNew
   * @param {number} levelAfter
   * @param {number} incomePerTick
   * @param {number} [coinsAwarded] coin refunded when this was a maxed duplicate
   */
  constructor(name, rarity, isNew, levelAfter, incomePerTick, coinsAwarded = 0) {
    this.name = name;
    this.rarity = rarity;
    this.isNew = isNew;
    this.levelAfter = levelAfter;
    this.incomePerTick = incomePerTick;
    this.coinsAwarded = coinsAwarded;
  }

  toJSON() {
    return {
      name: this.name,
      rarity: this.rarity,
      isNew: this.isNew,
      levelAfter: this.levelAfter,
      incomePerTick: this.incomePerTick,
      coinsAwarded: this.coinsAwarded,
    };
  }
}

export class CardCollectionEconomy {
  constructor(options = {}) {
    this.coins = options.coins ?? ECONOMY.STARTING_COINS;
    this.baseChestCost = options.chestCost ?? ECONOMY.CHEST_COST;
    this.incomeInterval = options.incomeInterval ?? ECONOMY.INCOME_INTERVAL;
    /** @type {Map<string, CardInstance>} keyed by card name. */
    this.cards = new Map();
    /** Chests purchased since the run began. */
    this.chestsBought = 0;
    /** Chests opened since the run began. */
    this.chestsOpened = 0;
    /** Distinct cards collected. */
    this.uniqueCards = 0;
    /** Coins earned from passive income (mints), not from anywhere else. */
    this.coinsEarned = 0;
    /** Total coins spent on chests. */
    this.coinsSpent = 0;
    this._incomeAccumulator = 0;
    this._stats = {
      totalIncome: 0,
      totalDraws: 0,
      totalNewCards: 0,
    };
  }

  /**
   * The current chest price: the base cost plus a per-opened-chest
   * increment, capped. The cap keeps late-game chests reachable instead of
   * letting the price outrun a finite collection's income forever.
   */
  currentChestCost() {
    const grown = this.baseChestCost + this.chestsOpened * ECONOMY.COST_GROWTH;
    return Math.min(grown, ECONOMY.COST_CAP);
  }

  /** True when the player can afford one more chest. */
  canBuyChest() {
    return this.coins >= this.currentChestCost();
  }

  /** Deduct the chest price. Returns true when the purchase succeeded. */
  buyChest() {
    const cost = this.currentChestCost();
    if (this.coins < cost) return false;
    this.coins -= cost;
    this.coinsSpent += cost;
    this.chestsBought += 1;
    return true;
  }

  /** Current income per tick summed across every owned card. */
  incomePerTick() {
    let total = 0;
    for (const card of this.cards.values()) {
      total += card.incomePerTick();
    }
    return total;
  }

  /** Cards ordered for display: rarity desc, then level desc, then name. */
  collectionList() {
    const rarityRank = (rarity) =>
      ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(rarity);
    return [...this.cards.values()].sort((a, b) => {
      const rarity = rarityRank(b.rarity) - rarityRank(a.rarity);
      if (rarity !== 0) return rarity;
      if (b.level !== a.level) return b.level - a.level;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Resolve a chest draw against the collection.
   *
   * @param {string} name
   * @param {string} rarity
   * @returns {ChestResult}
   */
  applyDraw(name, rarity) {
    let card = this.cards.get(name);
    const isNew = !card;
    const isMaxed = !isNew && card.level >= ECONOMY.MAX_LEVEL;
    let coinsAwarded = 0;
    if (isNew) {
      card = new CardInstance(name, rarity, 1);
      this.cards.set(name, card);
      this.uniqueCards += 1;
      this._stats.totalNewCards += 1;
    } else if (!isMaxed) {
      card.addDuplicate();
    } else {
      // A maxed card cannot level further, so refund the duplicate as coin.
      coinsAwarded = maxedDuplicateCoins(rarity);
      this.coins += coinsAwarded;
    }
    this.chestsOpened += 1;
    this._stats.totalDraws += 1;
    return new ChestResult(
      name,
      rarity,
      isNew,
      card.level,
      card.incomePerTick(),
      coinsAwarded,
    );
  }

  /**
   * Advance the economy by `deltaSeconds` and mint any income that fell
   * due. Returns the number of coins minted this step, so the game can
   * show a floating "+N" without re-deriving it.
   *
   * @param {number} deltaSeconds
   * @returns {number}
   */
  update(deltaSeconds) {
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    this._incomeAccumulator += delta;
    let minted = 0;
    const income = this.incomePerTick();
    if (income > 0 && this.incomeInterval > 0) {
      const ticks = Math.floor(this._incomeAccumulator / this.incomeInterval);
      if (ticks > 0) {
        this._incomeAccumulator -= ticks * this.incomeInterval;
        minted = ticks * income;
        this.coins += minted;
        this.coinsEarned += minted;
        this._stats.totalIncome += minted;
      }
    }
    return minted;
  }

  /** Snapshot of every observable number, for HUD and tests. */
  getState() {
    return {
      coins: this.coins,
      chestCost: this.currentChestCost(),
      chestsBought: this.chestsBought,
      chestsOpened: this.chestsOpened,
      uniqueCards: this.uniqueCards,
      totalCards: this.cards.size,
      incomePerTick: this.incomePerTick(),
      coinsEarned: this.coinsEarned,
      coinsSpent: this.coinsSpent,
      totalIncome: this._stats.totalIncome,
      totalDraws: this._stats.totalDraws,
      totalNewCards: this._stats.totalNewCards,
      canBuyChest: this.canBuyChest(),
    };
  }
}
