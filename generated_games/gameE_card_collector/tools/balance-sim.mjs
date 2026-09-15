#!/usr/bin/env node
/**
 * Balance simulator for the card-collector economy (see ../DESIGN.md).
 *
 * Mirrors the rules in packages/card-collector/src/{catalog,economy}.js in a
 * standalone loop so balance parameters (COST_SCALE / PER_POINT / unlock
 * thresholds / prestige policy / chest choice) can be swept without editing
 * the frozen ECONOMY and PRESTIGE objects.
 *
 * The mirror is not trusted on faith: `checkFidelity()` drives the real
 * CardCollectorGame and this simulator with the same seed and the same greedy
 * policy, then asserts every observable number matches tick for tick. If the
 * mirror ever drifts from the shipped rules, the simulator refuses to report.
 *
 * Player policy matters as much as the parameters, so the run loop is driven
 * by a pluggable stop rule (`POLICIES`) rather than a fixed run length.
 *
 * Usage:
 *   node tools/balance-sim.mjs                            # full report
 *   node tools/balance-sim.mjs --minutes=30 --policy=unlock
 *   node tools/balance-sim.mjs --scale=120 --perPoint=20000
 *   node tools/balance-sim.mjs --maxLevelBase=5 --maxLevelPerPrestige=1 \
 *       --levelGrowthRate=1.6 --perPoint=400000
 *
 * The level ladder (`--maxLevelBase`, `--maxLevelPerPrestige`,
 * `--levelGrowthRate`) shapes the *growth* phase; `--perPoint` sets how long a
 * run lasts. They are separate concerns — see DESIGN.md §8-§9.
 */

import {
  CARD_POOL,
  ECONOMY,
  PRESTIGE,
  RARITY,
  RARITY_ORDER,
  RARITY_PROFILE,
  RARITY_RANK,
  availableRarities,
  cardIncome,
  chestCostAt,
  createSeededRandom,
  goldChestPool,
  levelForCopies,
  maxedDuplicateCoins,
  pickCardName,
  rollRarity,
} from '../packages/card-collector/src/catalog.js';
import { CardCollectorGame } from '../packages/card-collector/src/game.js';

const MAX_LEVEL = ECONOMY.MAX_LEVEL;

/** The size of the base collection: every card reachable before any prestige. */
const BASE_SET_SIZE = RARITY_ORDER.reduce(
  (sum, rarity) => sum + CARD_POOL[rarity].length,
  0,
);

/** Cumulative-prestige marks worth timing, with what each one unlocks. */
const MARKS = Object.freeze([3, 5, 10, 20]);

/** The first-run length DESIGN.md §3 targets, in seconds. */
const TARGET_RUN_SECONDS = 30 * 60;

/**
 * A chest costing this many seconds of income reads as "the wall".
 * DESIGN.md §3 calls the felt threshold "每箱要攒 10+ 秒", so 10s is the
 * design's own number; 30s is a harsher, more conservative reading.
 */
const DEFAULT_WALL_SECONDS = 10;

/** Active wall threshold; overridden by `--wall=`. */
let WALL_SECONDS = DEFAULT_WALL_SECONDS;

/** The shipped parameters, read from the real modules as the default config. */
const DEFAULTS = Object.freeze({
  chestCost: ECONOMY.CHEST_COST,
  startingCoins: ECONOMY.STARTING_COINS,
  incomeInterval: ECONOMY.INCOME_INTERVAL,
  costScale: ECONOMY.COST_SCALE,
  /**
   * Highest card level at prestige count 0. Each further prestige raises the
   * cap by `maxLevelPerPrestige`, so the collection has more room to grow in
   * later runs. `maxLevelPerPrestige: 0` reproduces a fixed cap.
   */
  maxLevelBase: ECONOMY.MAX_LEVEL_BASE,
  maxLevelPerPrestige: ECONOMY.MAX_LEVEL_PER_PRESTIGE,
  /**
   * Copies needed for level `L` is `levelGrowthRate^(L-1)`, rounded up to stay
   * strictly increasing. The shipped rate is deliberately sub-doubling: with
   * the cap rising every prestige it is unbounded, and doubling reaches
   * 16384 copies by Lv15.
   */
  levelGrowthRate: ECONOMY.LEVEL_GROWTH_RATE,
  /** Income multiplier per level beyond 1. */
  levelMultiplier: ECONOMY.LEVEL_MULTIPLIER,
  goldMultiplier: ECONOMY.GOLD_CHEST_MULTIPLIER,
  perPoint: PRESTIGE.PER_POINT,
  goldChestAt: PRESTIGE.GOLD_CHEST_AT,
  unlocks: PRESTIGE.RARITY_UNLOCKS.map((u) => ({ ...u })),
  /** 'normal' never buys gold chests; 'gold' prefers one when affordable. */
  chestPolicy: 'normal',
});

/** Every cumulative-prestige threshold that unlocks something, ascending. */
function unlockThresholds(params) {
  const all = [params.goldChestAt, ...params.unlocks.map((u) => u.prestige)];
  return [...new Set(all)].sort((a, b) => a - b);
}

/**
 * One save file: a run that can be reset by prestige while `prestige` and
 * `totalTime` carry across resets, exactly like `CardCollectionEconomy`.
 */
class Sim {
  /**
   * @param {typeof DEFAULTS} params
   * @param {number} seed
   */
  constructor(params, seed) {
    this.p = params;
    this.random = createSeededRandom(seed);
    /** Cumulative prestige points, banked across resets. */
    this.prestige = 0;
    /** How many times the run has been reset. Drives the level cap. */
    this.prestigeCount = 0;
    /** Wall-clock seconds elapsed across every run. */
    this.totalTime = 0;
    /**
     * Cumulative wall-clock seconds at which each mark was first crossed.
     * @type {Map<number, number>}
     */
    this.crossings = new Map();
    this.runs = 0;
    this._resetRun();
  }

  /** Clear one run's state, keeping prestige and total time. */
  _resetRun() {
    this.coins = this.p.startingCoins;
    /** @type {Map<string, {rarity: string, copies: number}>} */
    this.cards = new Map();
    this.totalIncome = 0;
    this.chestsOpened = 0;
    /** Duplicates of an already-maxed card, refunded as coin. */
    this.maxedDraws = 0;
    this.totalDraws = 0;
    this.runTime = 0;
    this._acc = 0;
  }

  // --- rules mirrored from catalog.js -------------------------------------

  /**
   * Chest price: base plus one coin per `costScale` of lifetime income.
   * Uncapped, so it grows without bound as a run stretches on.
   */
  cost() {
    return this.p.chestCost + Math.floor(this.totalIncome / this.p.costScale);
  }

  /** Rarities a normal chest can roll at the current cumulative prestige. */
  pool() {
    const pool = [...RARITY_ORDER];
    for (const { rarity, prestige } of this.p.unlocks) {
      if (this.prestige >= prestige) pool.push(rarity);
    }
    return pool;
  }

  /** Rarities a gold chest can roll: the pool at or above rare. */
  goldPool() {
    return this.pool().filter(
      (rarity) => RARITY_RANK[rarity] >= RARITY_RANK[RARITY.RARE],
    );
  }

  /** The current level cap: a base plus one per prestige performed. */
  get maxLevel() {
    return this.p.maxLevelBase + this.p.maxLevelPerPrestige * this.prestigeCount;
  }

  /**
   * Copies needed to reach each level, cumulative and geometric: level `i+1`
   * needs `round(rate^i)`. At `rate = 2` and a cap of 5 this is exactly
   * `ECONOMY.LEVEL_COPY_THRESHOLDS`, which is what lets the fidelity check
   * pass on default parameters.
   */
  levelThresholds() {
    const out = [];
    let value = 1;
    for (let i = 0; i < this.maxLevel; i += 1) {
      const threshold = Math.max(1, Math.round(value));
      // Rounding collides at slow growth rates; force it strictly increasing.
      out.push(i === 0 ? 1 : Math.max(threshold, out[i - 1] + 1));
      value *= this.p.levelGrowthRate;
    }
    return out;
  }

  /** The level a card has reached, given the current cap. */
  levelFor(copies) {
    const thresholds = this.levelThresholds();
    let level = 1;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (copies >= thresholds[i]) level = i + 1;
    }
    return level;
  }

  /**
   * Per-level income, mirroring `catalog.cardIncome`: a linear floor so low
   * rarities always gain at least one coin per level, and exponential growth
   * for the rest.
   */
  cardIncome(rarity, level) {
    const base = RARITY_PROFILE[rarity].baseIncome;
    const exponential = base * Math.pow(this.p.levelMultiplier, level - 1);
    return Math.max(base + (level - 1), Math.floor(exponential));
  }

  /** Total coins minted per income tick by every owned card. */
  incomePerTick() {
    let total = 0;
    for (const card of this.cards.values()) {
      total += this.cardIncome(card.rarity, this.levelFor(card.copies));
    }
    return total;
  }

  /** Seconds of passive income needed to afford the next chest. */
  secondsPerChest() {
    const income = this.incomePerTick();
    return income > 0 ? this.cost() / income : Infinity;
  }

  /** Points a prestige right now would bank. */
  prestigeGain() {
    return Math.floor(this.totalIncome / this.p.perPoint);
  }

  /** The cumulative prestige this run would end on if reset right now. */
  projectedPrestige() {
    return this.prestige + this.prestigeGain();
  }

  /** The next cumulative-prestige threshold not yet reached, or Infinity. */
  nextThreshold() {
    return (
      unlockThresholds(this.p).find((t) => t > this.prestige) ?? Infinity
    );
  }

  // --- mirrored from economy.js -------------------------------------------

  /** Resolve one draw against the collection, refunding maxed duplicates. */
  _draw(pool) {
    const rarity = rollRarity(this.random, pool);
    const name = pickCardName(this.random, rarity);
    this.chestsOpened += 1;
    this.totalDraws += 1;
    const card = this.cards.get(name);
    if (!card) {
      this.cards.set(name, { rarity, copies: 1 });
    } else if (this.levelFor(card.copies) < this.maxLevel) {
      card.copies += 1;
    } else {
      this.maxedDraws += 1;
      this.coins += maxedDuplicateCoins(rarity);
    }
  }

  /** Advance the income timer by `delta`, minting whatever fell due. */
  _step(delta) {
    this.totalTime += delta;
    this.runTime += delta;
    this._acc += delta;
    const income = this.incomePerTick();
    if (income > 0 && this.p.incomeInterval > 0) {
      const ticks = Math.floor(this._acc / this.p.incomeInterval);
      if (ticks > 0) {
        this._acc -= ticks * this.p.incomeInterval;
        const minted = ticks * income;
        this.coins += minted;
        this.totalIncome += minted;
      }
    }
  }

  /** Spend everything affordable on chests, in the configured policy. */
  _act() {
    let guard = 0;
    for (;;) {
      if ((guard += 1) > 100000) throw new Error('buy loop did not terminate');
      const normal = this.cost();
      const gold = normal * this.p.goldMultiplier;
      if (
        this.p.chestPolicy === 'gold' &&
        this.prestige >= this.p.goldChestAt &&
        this.coins >= gold
      ) {
        this.coins -= gold;
        this._draw(this.goldPool());
      } else if (this.coins >= normal) {
        this.coins -= normal;
        this._draw(this.pool());
      } else {
        return;
      }
    }
  }

  /** Record any cumulative-prestige mark newly crossed. */
  _recordCrossings() {
    const now = this.projectedPrestige();
    for (const mark of MARKS) {
      if (!this.crossings.has(mark) && now >= mark) {
        this.crossings.set(mark, this.totalTime);
      }
    }
  }

  /**
   * Play one run: open chests, mint income, and stop when `stop(this)` first
   * returns true (never before `minRunSeconds`). Then prestige. Returns the
   * run's summary.
   *
   * @param {{stop: (sim: Sim) => boolean, maxRunSeconds: number,
   *          minRunSeconds?: number, observe?: (sim: Sim) => void}} options
   */
  playRun({ stop, maxRunSeconds, minRunSeconds = 1, observe }) {
    this._resetRun();
    this.runs += 1;
    const prestigeBefore = this.prestige;
    this._act();
    let lastIncome = this.incomePerTick();
    /** Time of the most recent income increase; null if it never grew. */
    let lastIncreaseAt = null;

    // Grow until `stop` says otherwise, remembering *the last* increase.
    // An earlier version latched the first 30s stall, which under-reported
    // badly (it fired on a mid-run plateau and ignored later upgrades).
    while (this.runTime < maxRunSeconds) {
      this._step(this.p.incomeInterval);
      this._act();
      this._recordCrossings();
      if (observe) observe(this);

      const income = this.incomePerTick();
      if (income !== lastIncome) {
        lastIncome = income;
        lastIncreaseAt = this.runTime;
      }
      if (this.runTime >= minRunSeconds && stop(this)) break;
    }

    const cappedAt = lastIncreaseAt;
    const gain = this.prestigeGain();
    this.prestige += gain;
    this.prestigeCount += 1;
    this._recordCrossings();
    return {
      duration: this.runTime,
      gain,
      prestigeBefore,
      prestigeAfter: this.prestige,
      income: this.incomePerTick(),
      cost: this.cost(),
      totalIncome: this.totalIncome,
      secondsPerChest: this.secondsPerChest(),
      unique: this.cards.size,
      cappedAt,
      /** The level cap this run played under. */
      maxLevel: this.maxLevel,
      chestsOpened: this.chestsOpened,
      maxedDraws: this.maxedDraws,
    };
  }
}

// --- player policies -------------------------------------------------------

/**
 * Stop rules. Each is a plausible read on "when does the player hit prestige?"
 * They differ a lot, which is the point: the shipped economy has no single
 * obvious prestige moment, so the report shows the spread.
 */
const POLICIES = Object.freeze({
  /** Bank points the moment one exists. Resets constantly, rebuilds constantly. */
  eager: (sim) => sim.prestigeGain() >= 1,
  /** Rush the next unlock, then reset to enjoy it. */
  unlock: (sim) => sim.projectedPrestige() >= sim.nextThreshold(),
  /** Grind the run until income has stopped growing for 60s. */
  saturated: (sim, ctx) =>
    sim.incomePerTick() > 0 && sim.runTime - (ctx.stalledAt ?? 0) > 60,
  /** Reset on a fixed cadence. */
  timed: (sim, ctx) => sim.runTime >= (ctx.runSeconds ?? 600),
});

// --- reporting -------------------------------------------------------------

const mmss = (s) => {
  if (!Number.isFinite(s)) return '--';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0
    ? `${h}h${String(m).padStart(2, '0')}m`
    : `${m}m${String(sec).padStart(2, '0')}s`;
};

const num = (n, digits = 1) =>
  Number.isFinite(n) ? n.toFixed(digits) : 'inf';

function printRuns(label, runs) {
  console.log(`\n=== ${label} ===`);
  console.log(
    [
      'run',
      'start P',
      'duration',
      'growth',
      'Lv',
      'P gain',
      'cum P',
      'cards',
      'draws',
      'end inc/s',
      'sec/chest',
    ].join(' | '),
  );
  for (const [i, r] of runs.entries()) {
    console.log(
      [
        String(i + 1).padStart(3),
        String(r.prestigeBefore).padStart(7),
        mmss(r.duration).padStart(8),
        (r.cappedAt === null ? '--' : mmss(r.cappedAt)).padStart(7),
        String(r.maxLevel).padStart(2),
        String(r.gain).padStart(6),
        String(r.prestigeAfter).padStart(5),
        `${r.unique}/${BASE_SET_SIZE}`.padStart(5),
        String(r.chestsOpened).padStart(5),
        num(r.income).padStart(9),
        num(r.secondsPerChest).padStart(8),
      ].join(' | '),
    );
  }
}

/**
 * Play `sim` for `totalSeconds` of wall-clock under `policy`, resetting on the
 * policy's stop rule. Returns the run summaries.
 */
function play(params, seed, { policy, totalSeconds, maxRunSeconds = 6 * 3600 }) {
  const sim = new Sim(params, seed);
  const runs = [];
  let stalledAt = 0;
  const ctx = { stalledAt: 0, runSeconds: 600 };
  while (sim.totalTime < totalSeconds) {
    const incomeBefore = sim.incomePerTick();
    const budget = Math.min(maxRunSeconds, totalSeconds - sim.totalTime);
    runs.push(
      sim.playRun({
        maxRunSeconds: budget,
        minRunSeconds: 2,
        observe: (s) => {
          if (s.incomePerTick() > incomeBefore) ctx.stalledAt = s.runTime;
        },
        stop: (s) =>
          policy === 'saturated'
            ? s.runTime - ctx.stalledAt > 60
            : POLICIES[policy](s, ctx),
      }),
    );
    if (runs.length > 200) break;
  }
  return { sim, runs };
}

// --- fidelity check --------------------------------------------------------

/**
 * Prove the mirror matches the shipped rules: same seed, same greedy policy,
 * every observable compared after every tick. Throws on the first divergence.
 */
function checkFidelity(ticks = 1200) {
  const seed = 20260914;
  const game = new CardCollectorGame({ seed });
  const sim = new Sim(DEFAULTS, seed);

  const drain = (canBuy, buy, open) => {
    while (canBuy()) {
      buy();
      open();
    }
  };

  const compare = (i) => {
    const real = game.economy.getState();
    const mirror = {
      coins: sim.coins,
      chestCost: sim.cost(),
      chestsOpened: sim.chestsOpened,
      uniqueCards: sim.cards.size,
      incomePerTick: sim.incomePerTick(),
      totalIncome: sim.totalIncome,
    };
    for (const key of Object.keys(mirror)) {
      if (real[key] !== mirror[key]) {
        throw new Error(
          `fidelity mismatch at tick ${i}: ${key} real=${real[key]} sim=${mirror[key]}`,
        );
      }
    }
  };

  drain(
    () => game.economy.canBuyChest(),
    () => game.buyChest(),
    () => game.openChest(),
  );
  sim._act();
  compare(0);

  for (let i = 1; i <= ticks; i += 1) {
    game.update(DEFAULTS.incomeInterval);
    drain(
      () => game.economy.canBuyChest(),
      () => game.buyChest(),
      () => game.openChest(),
    );
    sim._step(DEFAULTS.incomeInterval);
    sim._act();
    compare(i);
  }
  return { ticks, draws: game.economy.chestsOpened };
}

/**
 * Sample income over a no-reset run and report both when it grew and when it
 * stopped.
 *
 * `stop` — the time of the last income increase — is the honest,
 * window-independent measure of a run's growth phase: past that point the
 * player can still open chests, but nothing they do raises income. The
 * fraction columns (`at50`/`at90`) are relative to the ceiling *reachable
 * within the sampled window*, so they move if you change the window; prefer
 * `stop` when comparing variants.
 */
function growthCurve(params, seed, seconds) {
  const sim = new Sim(params, seed);
  const samples = [];
  let lastIncome = 0;
  sim.playRun({
    stop: () => false,
    maxRunSeconds: seconds,
    observe: (s) => {
      const income = s.incomePerTick();
      if (income !== lastIncome) {
        samples.push({ t: s.runTime, income });
        lastIncome = income;
      }
    },
  });
  const final = sim.incomePerTick();
  const at = (fraction) => {
    const target = final * fraction;
    const hit = samples.find((s) => s.income >= target);
    return hit ? hit.t : null;
  };
  return {
    final,
    stop: samples.length ? samples[samples.length - 1].t : 0,
    at50: at(0.5),
    at90: at(0.9),
    upgrades: samples.length,
  };
}

// --- analytic helpers ------------------------------------------------------

/** Expected base income per draw for a rarity pool, ignoring leveling. */
function poolEV(pool) {
  const weight = pool.reduce((s, r) => s + RARITY_PROFILE[r].weight, 0);
  const value = pool.reduce(
    (s, r) => s + RARITY_PROFILE[r].baseIncome * RARITY_PROFILE[r].weight,
    0,
  );
  return value / weight;
}

/** Share of a pool's weight held by the prestige-only top tiers. */
function topTierShare(pool, threshold = RARITY.MYTHIC) {
  const rank = RARITY_RANK[threshold];
  const total = pool.reduce((s, r) => s + RARITY_PROFILE[r].weight, 0);
  const top = pool
    .filter((r) => RARITY_RANK[r] >= rank)
    .reduce((s, r) => s + RARITY_PROFILE[r].weight, 0);
  return top / total;
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    seed: 1,
    minutes: 30,
    policy: 'unlock',
    chestPolicy: 'normal',
    quiet: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'quiet') options.quiet = true;
    else if (key === 'policy') options.policy = value;
    else if (key === 'chests') options.chestPolicy = value;
    else if (key === 'seed') options.seed = Number(value);
    else if (key === 'minutes') options.minutes = Number(value);
    else if (key === 'wall') options.wall = Number(value);
    else if (key === 'scale') options.costScale = Number(value);
    else if (key === 'perPoint') options.perPoint = Number(value);
    else if (key === 'maxLevelBase') options.maxLevelBase = Number(value);
    else if (key === 'maxLevelPerPrestige')
      options.maxLevelPerPrestige = Number(value);
    else if (key === 'levelGrowthRate')
      options.levelGrowthRate = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.wall) WALL_SECONDS = options.wall;
  const horizon = options.minutes * 60;

  const fidelity = checkFidelity();
  console.log(
    `fidelity: OK — mirror matches CardCollectorGame over ${fidelity.ticks} ticks ` +
      `(${fidelity.draws} draws, seed-identical)`,
  );

  const params = {
    ...DEFAULTS,
    chestPolicy: options.chestPolicy,
    ...(options.costScale ? { costScale: options.costScale } : {}),
    ...(options.perPoint ? { perPoint: options.perPoint } : {}),
    ...(options.maxLevelBase ? { maxLevelBase: options.maxLevelBase } : {}),
    ...(options.maxLevelPerPrestige
      ? { maxLevelPerPrestige: options.maxLevelPerPrestige }
      : {}),
    ...(options.levelGrowthRate
      ? { levelGrowthRate: options.levelGrowthRate }
      : {}),
  };

  console.log(
    `\nparams: COST_SCALE=${params.costScale} PER_POINT=${params.perPoint} ` +
      `GOLD_CHEST_AT=${params.goldChestAt} chests=${params.chestPolicy} seed=${options.seed}`,
  );
  console.log(
    `unlocks: ${params.unlocks.map((u) => `${u.rarity}@P${u.prestige}`).join(', ')}`,
  );

  // 1. What the run actually looks like under the default policy.
  const chosen = play(params, options.seed, {
    policy: options.policy,
    totalSeconds: horizon,
  });
  printRuns(`policy=${options.policy} — first ${options.minutes} min`, chosen.runs);

  // 2. The core diagnostic: when does growth stop, and does the cost wall
  //    ever arrive? DESIGN.md §3 claims it lands at ~30 min.
  const probe = new Sim(params, options.seed);
  let fullSet = null;
  let wallAt = null;
  const probeSpan = Math.max(horizon, 12 * 3600);
  const firstRun = probe.playRun({
    stop: () => false,
    maxRunSeconds: probeSpan,
    observe: (s) => {
      if (!fullSet && s.cards.size >= BASE_SET_SIZE) {
        fullSet = { t: s.runTime, draws: s.totalDraws };
      }
      if (wallAt === null && s.secondsPerChest() >= WALL_SECONDS) {
        wallAt = s.runTime;
      }
    },
  });
  console.log(
    `\n=== diagnostic: growth ceiling and cost wall under COST_SCALE=${params.costScale} ===`,
  );
  console.log(
    `  full base set (${BASE_SET_SIZE} cards): ` +
      (fullSet ? `${mmss(fullSet.t)} after ${fullSet.draws} draws` : 'not reached'),
  );
  console.log(
    `  income first stopped growing: ` +
      (firstRun.cappedAt === null ? 'never' : mmss(firstRun.cappedAt)) +
      `  (ceiling ${num(firstRun.income)}/s)` +
      (firstRun.cappedAt !== null && firstRun.cappedAt > horizon
        ? `  [past the ${options.minutes}-min run, so growth covers the whole run]`
        : ''),
  );
  console.log(
    `  cost wall (a chest costs ${WALL_SECONDS}s of income) arrives at: ` +
      (wallAt === null ? `NOT within ${mmss(probeSpan)}` : mmss(wallAt)),
  );
  console.log(
    `  dP/dt once capped: ${num((firstRun.income / params.perPoint) * 60, 3)} P/min ` +
      `(identical no matter when the player resets — see the policy table)`,
  );
  console.log(
    `  chest cost at ${mmss(horizon)}: ${Math.round(chestCostAt(firstRun.totalIncome, params.chestCost))} ` +
      `vs income ${num(firstRun.income)}/s`,
  );

  // The closed form for the wall: once income is capped at I, cost grows at
  // I/COST_SCALE per second, so cost/income hits W at T = COST_SCALE*(I*W-10)/I.
  const cappedIncome = firstRun.income;
  const idealScale =
    cappedIncome > 0
      ? (cappedIncome * TARGET_RUN_SECONDS) /
        (cappedIncome * WALL_SECONDS - params.chestCost)
      : NaN;
  console.log(
    `  -> COST_SCALE that puts the wall at ${mmss(TARGET_RUN_SECONDS)}: ` +
      `${num(idealScale, 0)} (shipped: ${params.costScale})`,
  );

  // 3. Milestone timing across policies.
  console.log('\n=== cumulative wall-clock to reach each unlock, by policy ===');
  console.log(
    `  (horizon ${options.minutes} min; P3=mythic, P5=gold chest, P10=ancient, P20=astral)`,
  );
  for (const policy of ['eager', 'unlock', 'saturated', 'timed']) {
    const { sim } = play(params, options.seed, {
      policy,
      totalSeconds: horizon,
    });
    const reach = (mark) => {
      const t = sim.crossings.get(mark);
      return (t === undefined ? '--' : mmss(t)).padStart(8);
    };
    console.log(
      `  ${policy.padEnd(10)} P3=${reach(3)} P5=${reach(5)} P10=${reach(10)} P20=${reach(20)}` +
        `   end P=${String(sim.prestige).padStart(4)}  P/min=${num(sim.prestige / (sim.totalTime / 60), 3)}`,
    );
  }

  if (options.quiet) return;

  // 4. Parameter calibration. Two design goals must hold together:
  //      (a) the first prestige lands near the ~30 min target, and
  //      (b) the cost wall lands around there too, so it *is* the signal.
  //    Both are measured per cell, because they interact: a low COST_SCALE
  //    starves the player of chests long before the collection maxes.
  console.log(
    `\n=== calibration grid (policy=unlock): when does the FIRST prestige land,` +
      ` and when does the wall arrive? target=${mmss(TARGET_RUN_SECONDS)} ===`,
  );
  console.log(
    `  COST_SCALE  PER_POINT |  P3 (mythic)  wall@${WALL_SECONDS}s  income cap  P@30min`,
  );
  for (const costScale of [60, 120, 250, 500, 1000]) {
    for (const perPoint of [50000, 100000, 200000, 400000]) {
      const tuned = { ...params, costScale, perPoint };
      const { sim } = play(tuned, options.seed, {
        policy: 'unlock',
        totalSeconds: horizon,
      });
      // Probe the same parameters with no resets to time the wall cleanly.
      const probeSim = new Sim(tuned, options.seed);
      let wall = null;
      const probeRun = probeSim.playRun({
        stop: () => false,
        maxRunSeconds: Math.max(horizon, 12 * 3600),
        observe: (s) => {
          if (wall === null && s.secondsPerChest() >= WALL_SECONDS) {
            wall = s.runTime;
          }
        },
      });
      const p3 = sim.crossings.get(3);
      const flag =
        p3 !== undefined &&
        wall !== null &&
        Math.abs(p3 - wall) < 0.35 * Math.max(p3, wall)
          ? '  <== aligned'
          : '';
      console.log(
        `  ${String(costScale).padStart(10)}  ${String(perPoint).padStart(9)} | ` +
          `${(p3 === undefined ? '--' : mmss(p3)).padStart(11)}  ` +
          `${(wall === null ? '--' : mmss(wall)).padStart(8)}  ` +
          `${num(probeRun.income).padStart(9)}  ${String(sim.prestige).padStart(6)}${flag}`,
      );
    }
  }

  // 5. Chest value: is the gold chest worth its 3x price?
  console.log('\n=== gold chest value vs 3 normal chests (equal spend) ===');
  console.log(
    '  base-income EV ignores leveling; the top-tier share is what a maxed\n' +
      '  collection actually still needs, since duplicates of maxed cards refund.',
  );
  for (const prestige of [0, 3, 5, 10, 20]) {
    const normal = availableRarities(prestige);
    const gold = goldChestPool(prestige);
    console.log(
      `  P>=${String(prestige).padStart(2)}  ` +
        `3x normal EV=${num(3 * poolEV(normal), 2).padStart(6)} ` +
        `vs gold EV=${num(poolEV(gold), 2).padStart(6)} ` +
        `(${num((poolEV(gold) * 2.25) / (3 * poolEV(normal)), 2)}x after leveling)  ` +
        `| mythic+ share per chest: normal ${num(topTierShare(normal) * 100, 2)}% ` +
        `vs gold ${num(topTierShare(gold) * 100, 2)}%`,
    );
  }

  // 6. Growth curve: how much of a run contains actual progression?
  //    Compare the shipped shape against a deeper level ladder, which is the
  //    lever that lengthens growth without touching income per card.
  console.log(
    `\n=== growth curve over a ${options.minutes}-min run (window-independent) ===`,
  );
  console.log(
    '  variant              growth stops   ceiling   upgrades   growth share',
  );
  const variants = [5, 6, 7, 8, 9].map((maxLevelBase) => ({
    label: `MAX_LEVEL=${maxLevelBase}${
      maxLevelBase === DEFAULTS.maxLevelBase ? ' (ship)' : ''
    }`,
    params: { ...params, maxLevelBase },
  }));
  for (const { label, params: vp } of variants) {
    const g = growthCurve(vp, options.seed, horizon);
    const share = g.stop > 0 ? (g.stop / horizon) * 100 : 0;
    console.log(
      `  ${label.padEnd(20)} ${mmss(g.stop).padStart(9)}  ` +
        `${num(g.final).padStart(8)}  ${String(g.upgrades).padStart(8)}  ` +
        `${num(share).padStart(9)}%`,
    );
  }
  console.log(
    '  "growth stops" = time of the LAST income increase: past it, opening\n' +
      '  chests cannot raise income. "growth share" = that time / the run length.\n' +
      '  Unlocking new rarities on prestige is separate and continues to matter.',
  );

  // 7. Design target check.
  const unlockAt = chosen.sim.crossings.get(3);
  console.log('\n=== DESIGN.md §3 target: first run ~30 min ===');
  console.log(
    `  first prestige (P>=3, mythic) at: ` +
      (unlockAt === undefined ? 'never within horizon' : mmss(unlockAt)),
  );
  const deadTime =
    firstRun.cappedAt !== null && wallAt !== null
      ? wallAt - firstRun.cappedAt
      : null;
  console.log(
    `  time between "income maxed" and "cost wall" under the shipped scale: ` +
      (deadTime === null ? 'n/a' : mmss(deadTime)) +
      ` — the run is stretched by waiting, not by playing`,
  );
  console.log(
    `  verdict: growth stops at ${mmss(firstRun.cappedAt ?? 0)}, so every unlock ` +
      `after that is gated purely by dP/dt = ${num((firstRun.income / params.perPoint) * 60, 2)} P/min.`,
  );
}

main();
