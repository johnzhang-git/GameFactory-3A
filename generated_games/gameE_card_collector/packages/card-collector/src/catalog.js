/**
 * The card catalogue: every collectible card, its rarity, and its economy.
 *
 * This module is deliberately free of three.js and the DOM, so it can be
 * imported and stepped by a headless `vitest` run. It owns the *rules* of
 * collection — what a card is, how rare it is, and what it earns — and
 * nothing about how any of that is drawn.
 *
 * The core loop is: buy a chest for COIN, open it to draw a card, hold
 * cards that periodically mint coins, spend those coins on more chests.
 * Duplicate draws upgrade the card, and each level multiplies its income.
 */

/** Rarity tiers, worst to best. Lower tiers are drawn more often. */
export const RARITY = Object.freeze({
  COMMON: 'common',
  UNCOMMON: 'uncommon',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary',
  MYTHIC: 'mythic',
  ANCIENT: 'ancient',
  ASTRAL: 'astral',
});

/** The economy: costs and income live here so UI and tests share one truth. */
export const ECONOMY = Object.freeze({
  CHEST_COST: 10,
  STARTING_COINS: 20,
  /** Seconds between each passive income tick of the whole collection. */
  INCOME_INTERVAL: 1,
  /** Multiplier per duplicate level beyond 1, applied to the base income. */
  LEVEL_MULTIPLIER: 1.5,
  /**
   * Lifetime passive income per one-coin chest-price rise. Uncapped.
   *
   * This is a *backstop*, not the pacing control. Measured: the price only
   * reaches 10s-of-income per chest after ~2h47m, so it never fires within a
   * 30-minute run. It exists to stop a player who never prestiges, not to
   * signal when they should. `PRESTIGE.PER_POINT` sets the run length.
   */
  COST_SCALE: 1000,
  /**
   * The level cap before any prestige. Each reset raises it by
   * `MAX_LEVEL_PER_PRESTIGE`, so later runs have more room to grow instead of
   * every run ending at the same fixed ceiling.
   */
  MAX_LEVEL_BASE: 5,
  /** Levels added to the cap per prestige. */
  MAX_LEVEL_PER_PRESTIGE: 1,
  /**
   * Copies for level `L` grow as `LEVEL_GROWTH_RATE^(L-1)`.
   *
   * Deliberately slower than doubling. With the cap now rising every prestige
   * it is unbounded, and at rate 2 the ladder reaches 16384 copies by Lv15 —
   * an unfinishable collection. At 1.5, Lv15 costs ~87 copies.
   */
  LEVEL_GROWTH_RATE: 1.5,
  /**
   * Coins refunded for drawing a duplicate of an already-maxed card, as a
   * multiple of that card's `baseIncome`. A maxed card has no upgrade left,
   * so its duplicates are converted to coin instead of being inert.
   */
  MAXED_DUPLICATE_COIN_MULTIPLIER: 3,
  /** A gold chest costs this multiple of the normal chest price. */
  GOLD_CHEST_MULTIPLIER: 3,
});

/**
 * Prestige (reset) rules. Unlockable rarities enter every chest's draw pool
 * once their cumulative prestige threshold is reached; the gold chest is a
 * premium draw with a rare-or-better floor.
 */
export const PRESTIGE = Object.freeze({
  /**
   * Lifetime income per prestige point, granted when the run is reset.
   *
   * This — not `COST_SCALE` — is what sets a run's length: the collection's
   * income stops growing within minutes, so time-to-prestige is just
   * `threshold * PER_POINT / income` once income caps.
   *
   * Climbing the level cap lifts the income ceiling, which would otherwise
   * make prestige arrive faster, so this moves with `MAX_LEVEL_BASE`: measured
   * first prestige (P3, unlocking Mythic) lands at ~33m13s over six seeds.
   * See ../DESIGN.md §7-§9.
   */
  PER_POINT: 250000,
  /** Cumulative prestige needed to unlock the gold chest. */
  GOLD_CHEST_AT: 5,
  /** Rarities that enter the draw pool at each prestige threshold. */
  RARITY_UNLOCKS: Object.freeze([
    { rarity: RARITY.MYTHIC, prestige: 3 },
    { rarity: RARITY.ANCIENT, prestige: 10 },
    { rarity: RARITY.ASTRAL, prestige: 20 },
  ]),
});

/** Per-rarity visual and economic profile, indexed by `RARITY` value. */
export const RARITY_PROFILE = Object.freeze({
  [RARITY.COMMON]: {
    baseIncome: 1,
    color: 0x9aa3ad,
    label: 'Common',
    weight: 50,
  },
  [RARITY.UNCOMMON]: {
    baseIncome: 2,
    color: 0x4ade80,
    label: 'Uncommon',
    weight: 28,
  },
  [RARITY.RARE]: {
    baseIncome: 4,
    color: 0x38bdf8,
    label: 'Rare',
    weight: 15,
  },
  [RARITY.EPIC]: {
    baseIncome: 8,
    color: 0xc084fc,
    label: 'Epic',
    weight: 6,
  },
  [RARITY.LEGENDARY]: {
    baseIncome: 20,
    color: 0xfbbf24,
    label: 'Legendary',
    weight: 1,
  },
  [RARITY.MYTHIC]: {
    baseIncome: 40,
    color: 0xff5c8a,
    label: 'Mythic',
    weight: 0.6,
  },
  [RARITY.ANCIENT]: {
    baseIncome: 80,
    color: 0x9b5cff,
    label: 'Ancient',
    weight: 0.25,
  },
  [RARITY.ASTRAL]: {
    baseIncome: 150,
    color: 0x7dffd4,
    label: 'Astral',
    weight: 0.1,
  },
});

/** The base rarities a chest can roll before any prestige unlocks. */
export const RARITY_ORDER = Object.freeze([
  RARITY.COMMON,
  RARITY.UNCOMMON,
  RARITY.RARE,
  RARITY.EPIC,
  RARITY.LEGENDARY,
]);

/** Rarity rank, worst to best, for ordering and the gold chest's floor. */
export const RARITY_RANK = Object.freeze({
  [RARITY.COMMON]: 0,
  [RARITY.UNCOMMON]: 1,
  [RARITY.RARE]: 2,
  [RARITY.EPIC]: 3,
  [RARITY.LEGENDARY]: 4,
  [RARITY.MYTHIC]: 5,
  [RARITY.ANCIENT]: 6,
  [RARITY.ASTRAL]: 7,
});

/** The card names a chest can draw, keyed by rarity. */
export const CARD_POOL = Object.freeze({
  [RARITY.COMMON]: ['Slime', 'Goblin', 'Bat', 'Rat', 'Frog', 'Chick'],
  [RARITY.UNCOMMON]: ['Wolf', 'Boar', 'Hawk', 'Serpent', 'Fox'],
  [RARITY.RARE]: ['Golem', 'Gryphon', 'Treant', 'Lich'],
  [RARITY.EPIC]: ['Dragon', 'Phoenix', 'Kraken'],
  [RARITY.LEGENDARY]: ['Elder Wyrm'],
  [RARITY.MYTHIC]: ['Titan', 'Eidolon'],
  [RARITY.ANCIENT]: ['Primordial', 'Leviathan'],
  [RARITY.ASTRAL]: ['Celestial', 'Voidspawn'],
});

/**
 * A deterministic pseudo-random stream. Passed in by callers so a chest
 * draw is reproducible: the game passes one number stream per run, and
 * tests pass a fixed seed.
 *
 * @param {number} seed
 */
export function createSeededRandom(seed = 1) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return function next() {
    // Mulberry32 — good enough for a loot roll, and identical everywhere.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Roll a rarity for a chest draw.
 *
 * @param {() => number} random a `[0,1)` generator
 * @returns {string} a `RARITY` value
 */
export function rollRarity(random, pool = RARITY_ORDER) {
  const total = pool.reduce(
    (sum, rarity) => sum + RARITY_PROFILE[rarity].weight,
    0,
  );
  const roll = random() * total;
  let cumulative = 0;
  for (const rarity of pool) {
    cumulative += RARITY_PROFILE[rarity].weight;
    if (roll < cumulative) return rarity;
  }
  return pool[0];
}

/**
 * Pick a card identity for a drawn rarity.
 *
 * @param {() => number} random
 * @param {string} rarity
 * @returns {string} a card name from `CARD_POOL`
 */
export function pickCardName(random, rarity) {
  const pool = CARD_POOL[rarity];
  const index = Math.min(
    pool.length - 1,
    Math.floor(random() * pool.length),
  );
  return pool[index];
}

/**
 * The level cap at a given prestige count.
 *
 * Each reset adds `MAX_LEVEL_PER_PRESTIGE` levels, so a later run has more
 * headroom than an earlier one — this is what makes prestige deepen the
 * collection rather than just restarting it.
 *
 * @param {number} [prestigeCount] runs completed so far
 * @returns {number} the highest reachable level
 */
export function maxLevelAt(prestigeCount = 0) {
  return (
    ECONOMY.MAX_LEVEL_BASE +
    ECONOMY.MAX_LEVEL_PER_PRESTIGE * Math.max(0, prestigeCount)
  );
}

/**
 * Copies (including the first) needed to reach each level, indexed by
 * level - 1. Level `L` needs `round(LEVEL_GROWTH_RATE^(L-1))` copies, forced
 * strictly increasing so slow growth rates cannot collide after rounding.
 *
 * @param {number} [prestigeCount] runs completed so far, which sets the depth
 * @returns {number[]} one threshold per reachable level
 */
export function levelThresholds(prestigeCount = 0) {
  const cap = maxLevelAt(prestigeCount);
  const rate = ECONOMY.LEVEL_GROWTH_RATE;
  const thresholds = [];
  let value = 1;
  for (let i = 0; i < cap; i += 1) {
    if (i === 0) {
      thresholds.push(1);
    } else {
      thresholds.push(
        Math.max(Math.round(value), thresholds[i - 1] + 1),
      );
    }
    value *= rate;
  }
  return thresholds;
}

/**
 * The level a card has reached for a given number of copies.
 *
 * A card with 1 copy is Lv1; each further level costs progressively more
 * duplicates, so the collection's long-term goal ("max every card") runs far
 * deeper than the short-term goal ("collect one of each").
 *
 * `prestigeCount` is required to resolve the cap; callers that track a run
 * pass their own, and omitting it assumes a fresh save.
 *
 * @param {number} copies including the first
 * @param {number} [prestigeCount] runs completed so far
 * @returns {number} a level in [1, maxLevelAt(prestigeCount)]
 */
export function levelForCopies(copies, prestigeCount = 0) {
  const thresholds = levelThresholds(prestigeCount);
  let level = 1;
  for (let i = 0; i < thresholds.length; i += 1) {
    if (copies >= thresholds[i]) level = i + 1;
  }
  return level;
}

/**
 * The per-level income of a card, in whole coins per income tick.
 *
 * Level 1 is the base. Higher levels scale by `LEVEL_MULTIPLIER`, but a
 * straight `floor(base * mult^(level-1))` eats low-rarity upgrades — a
 * common card at base 1 goes `floor(1 * 1.5) = 1`, so level 2 earns the
 * same as level 1 and the upgrade reads as dead. The linear floor
 * `base + (level - 1)` guarantees every level gains at least one coin,
 * while higher-rarity cards keep their exponential growth.
 *
 * @param {string} rarity
 * @param {number} level
 */
export function cardIncome(rarity, level) {
  const base = RARITY_PROFILE[rarity].baseIncome;
  const exponential = base * Math.pow(ECONOMY.LEVEL_MULTIPLIER, level - 1);
  return Math.max(base + (level - 1), Math.floor(exponential));
}

/**
 * Coins refunded for drawing a duplicate of an already-maxed card.
 *
 * A card at `MAX_LEVEL` cannot level up again, so a further duplicate would
 * otherwise be silently inert. It is instead refunded as coin scaled by the
 * card's rarity, which keeps late-game draws meaningful.
 *
 * @param {string} rarity
 * @returns {number} whole coins
 */
export function maxedDuplicateCoins(rarity) {
  return (
    RARITY_PROFILE[rarity].baseIncome * ECONOMY.MAXED_DUPLICATE_COIN_MULTIPLIER
  );
}

/**
 * The chest price as lifetime passive income grows.
 *
 * Uncapped linear growth: every `COST_SCALE` coins of lifetime income raise
 * the price by one. Early on income is tiny, so the price barely moves; once
 * the collection nears its income ceiling the price keeps climbing and
 * eventually outruns it — the signal to prestige.
 *
 * @param {number} totalIncome lifetime passive income
 * @param {number} [base] starting chest price
 * @returns {number} whole coins
 */
export function chestCostAt(totalIncome, base = ECONOMY.CHEST_COST) {
  return base + Math.floor(totalIncome / ECONOMY.COST_SCALE);
}

/**
 * The rarities available to a chest draw at a given prestige.
 *
 * The base five rarities are always present; each unlockable rarity joins
 * the pool once the cumulative prestige reaches its threshold.
 *
 * @param {number} prestige cumulative prestige points
 * @returns {string[]} a `RARITY` value per available tier
 */
export function availableRarities(prestige) {
  const pool = [...RARITY_ORDER];
  for (const { rarity, prestige: required } of PRESTIGE.RARITY_UNLOCKS) {
    if (prestige >= required) pool.push(rarity);
  }
  return pool;
}

/**
 * The gold chest's draw pool: every available rarity at or above rare.
 *
 * @param {number} prestige cumulative prestige points
 * @returns {string[]} a `RARITY` value per available rare-or-better tier
 */
export function goldChestPool(prestige) {
  return availableRarities(prestige).filter(
    (rarity) => RARITY_RANK[rarity] >= RARITY_RANK[RARITY.RARE],
  );
}

/**
 * The prestige points a run grants from lifetime income, before reset.
 *
 * @param {number} totalIncome lifetime passive income
 * @returns {number} whole prestige points
 */
export function prestigeGain(totalIncome) {
  return Math.floor(totalIncome / PRESTIGE.PER_POINT);
}

/** A human-readable card id from a name. */
export function cardIdFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
