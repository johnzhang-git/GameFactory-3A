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
  PRESTIGE,
  RARITY_RANK,
  cardIncome,
  chestCostAt,
  levelForCopies,
  maxedDuplicateCoins,
  maxLevelAt,
  prestigeGain,
} from './catalog.js';

/** A collected card: identity plus how many duplicates have been drawn. */
export class CardInstance {
  /**
   * @param {string} name
   * @param {string} rarity
   * @param {number} [copies]
   * @param {number} [maxLevel] the cap this card was drawn under
   */
  constructor(name, rarity, copies = 1, maxLevel = maxLevelAt(0)) {
    this.name = name;
    this.rarity = rarity;
    /** How many times the chest has drawn this card (including the first). */
    this.copies = copies;
    /**
     * The level cap in force when this card entered the collection.
     *
     * A card cannot outgrow the cap it was drawn under: prestige raises the
     * cap for *future* runs, and prestige also clears the collection, so a
     * card's cap is constant for its whole life. Fixing it here keeps
     * `level` from depending on state the card itself does not own.
     */
    this.maxLevel = maxLevel;
  }

  /** Upgrade by one duplicate. */
  addDuplicate() {
    this.copies += 1;
  }

  /** True once no further duplicate can raise this card's level. */
  get isMaxed() {
    return this.level >= this.maxLevel;
  }

  /** The card's level, derived from how many copies it has. */
  get level() {
    return levelForCopies(this.copies, this.maxLevel - ECONOMY.MAX_LEVEL_BASE);
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
    /** Cumulative prestige points banked across resets. */
    this.prestige = options.prestige ?? 0;
    /** How many runs have been reset. Raises the level cap each time. */
    this.prestigeCount = options.prestigeCount ?? 0;
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
    return chestCostAt(this._stats.totalIncome, this.baseChestCost);
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

  /** The gold chest price: the normal chest price times a fixed multiple. */
  goldChestCost() {
    return this.currentChestCost() * ECONOMY.GOLD_CHEST_MULTIPLIER;
  }

  /** True once the gold chest has been unlocked by prestige. */
  isGoldChestUnlocked() {
    return this.prestige >= PRESTIGE.GOLD_CHEST_AT;
  }

  /** True when the gold chest is unlocked and affordable. */
  canBuyGoldChest() {
    return this.isGoldChestUnlocked() && this.coins >= this.goldChestCost();
  }

  /**
   * Buy a gold chest. Fails unless it is unlocked and affordable. Returns
   * true on success.
   */
  buyGoldChest() {
    if (!this.isGoldChestUnlocked()) return false;
    const cost = this.goldChestCost();
    if (this.coins < cost) return false;
    this.coins -= cost;
    this.coinsSpent += cost;
    this.chestsBought += 1;
    return true;
  }

  /**
   * The prestige points the current run would grant, based on lifetime
   * income. Reading this does not reset anything.
   */
  prestigeGain() {
    return prestigeGain(this._stats.totalIncome);
  }

  /**
   * Reset the run for prestige: bank the current run's prestige points,
   * then clear the collection, coins, counters, and lifetime income. Returns
   * the points granted.
   */
  prestigeReset() {
    const gain = this.prestigeGain();
    this.prestige += gain;
    this.prestigeCount += 1;
    this.cards.clear();
    this.coins = ECONOMY.STARTING_COINS;
    this.chestsBought = 0;
    this.chestsOpened = 0;
    this.uniqueCards = 0;
    this.coinsEarned = 0;
    this.coinsSpent = 0;
    this._incomeAccumulator = 0;
    this._stats = { totalIncome: 0, totalDraws: 0, totalNewCards: 0 };
    return gain;
  }

  /** The level cap for cards drawn in the current run. */
  maxLevel() {
    return maxLevelAt(this.prestigeCount);
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
    const rarityRank = (rarity) => RARITY_RANK[rarity] ?? -1;
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
    const isMaxed = !isNew && card.isMaxed;
    let coinsAwarded = 0;
    if (isNew) {
      card = new CardInstance(name, rarity, 1, this.maxLevel());
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
      prestige: this.prestige,
      prestigeCount: this.prestigeCount,
      maxLevel: this.maxLevel(),
      prestigeGain: this.prestigeGain(),
      goldChestCost: this.goldChestCost(),
      goldChestUnlocked: this.isGoldChestUnlocked(),
      canBuyGoldChest: this.canBuyGoldChest(),
    };
  }
}
