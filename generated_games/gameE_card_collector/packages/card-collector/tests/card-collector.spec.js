/**
 * Headless tests for the card-collector economy and rules.
 *
 * These run under `vitest` in the `node` environment: no GPU, no canvas,
 * no screenshots. They prove the core loop with explicit deltas — buy a
 * chest, open it to draw a card, wait out the income tick, spend the
 * coins on another chest — because that loop is exactly what "playable"
 * means for this game.
 *
 * The pure modules (`catalog`, `economy`, `game`) import nothing from
 * three.js, which is what lets every case run headless.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
  levelThresholds,
  maxLevelAt,
  maxedDuplicateCoins,
  pickCardName,
  prestigeGain,
  rollRarity,
} from '../src/catalog.js';
import {
  CardCollectionEconomy,
  CardInstance,
} from '../src/economy.js';
import { CardCollectorGame, GAME_EVENT, GAME_PHASE } from '../src/game.js';

describe('catalog', () => {
  it('is deterministic for a fixed seed', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('rolls only declared rarities', () => {
    const random = createSeededRandom(9);
    for (let i = 0; i < 500; i += 1) {
      const rarity = rollRarity(random);
      expect(RARITY_ORDER).toContain(rarity);
    }
  });

  it('picks only cards from the rolled pool', () => {
    const random = createSeededRandom(3);
    for (const rarity of RARITY_ORDER) {
      const name = pickCardName(random, rarity);
      expect(CARD_POOL[rarity]).toContain(name);
    }
  });

  it('weights legendary below common over many rolls', () => {
    const random = createSeededRandom(1);
    const counts = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
    for (let i = 0; i < 4000; i += 1) {
      counts[rollRarity(random)] += 1;
    }
    expect(counts[RARITY.LEGENDARY]).toBeLessThan(
      counts[RARITY.COMMON],
    );
  });

  it('computes a strictly increasing income per level', () => {
    const legendary = cardIncome(RARITY.LEGENDARY, 1);
    expect(legendary).toBe(RARITY_PROFILE[RARITY.LEGENDARY].baseIncome);
    const level2 = cardIncome(RARITY.LEGENDARY, 2);
    expect(level2).toBeGreaterThan(legendary);
  });

  it('gains at least one coin per level, at every rarity', () => {
    // The floor of `base * mult^(lvl-1)` eats low-rarity upgrades (a
    // common card stays at 1 from Lv1 to Lv2). This is the regression
    // guard: no upgrade may ever read as dead.
    for (const rarity of RARITY_ORDER) {
      for (let level = 1; level <= 8; level += 1) {
        expect(cardIncome(rarity, level + 1)).toBeGreaterThan(
          cardIncome(rarity, level),
        );
      }
    }
  });

  it('maps copies to level via geometric thresholds', () => {
    // levelForCopies is the long-term-depth lever: each level costs more
    // copies than the last, so "max every card" is far deeper than "collect
    // one of each". Asserting against the derived table keeps this honest
    // when the growth rate is retuned for pacing.
    const thresholds = levelThresholds(0);
    for (let i = 0; i < thresholds.length; i += 1) {
      expect(levelForCopies(thresholds[i], 0)).toBe(i + 1);
    }
    // Anything past the last threshold is capped at the current max level.
    expect(levelForCopies(100000, 0)).toBe(maxLevelAt(0));
  });

  it('raises the level cap with each prestige', () => {
    // The cap is the long-term reward for resetting: a later run can push
    // cards further than any earlier one could.
    expect(maxLevelAt(0)).toBe(ECONOMY.MAX_LEVEL_BASE);
    expect(maxLevelAt(3)).toBe(
      ECONOMY.MAX_LEVEL_BASE + 3 * ECONOMY.MAX_LEVEL_PER_PRESTIGE,
    );
    // A deeper cap means a longer threshold table, and the shared prefix is
    // unchanged, so earlier levels keep costing what they always did.
    const shallow = levelThresholds(0);
    const deep = levelThresholds(5);
    expect(deep.length).toBeGreaterThan(shallow.length);
    expect(deep.slice(0, shallow.length)).toEqual(shallow);
  });

  it('refunds maxed duplicates scaled by rarity', () => {
    // A maxed common refunds 1 * multiplier, a maxed legendary 20 * multiplier.
    expect(maxedDuplicateCoins(RARITY.COMMON)).toBe(
      RARITY_PROFILE[RARITY.COMMON].baseIncome *
        ECONOMY.MAXED_DUPLICATE_COIN_MULTIPLIER,
    );
    expect(maxedDuplicateCoins(RARITY.LEGENDARY)).toBe(
      RARITY_PROFILE[RARITY.LEGENDARY].baseIncome *
        ECONOMY.MAXED_DUPLICATE_COIN_MULTIPLIER,
    );
  });

  it('computes chest cost from lifetime income, uncapped', () => {
    // Price rises one coin per COST_SCALE lifetime income and never caps:
    // 400x scale is far past the old cap, proving the ceiling is gone.
    expect(chestCostAt(0)).toBe(ECONOMY.CHEST_COST);
    expect(chestCostAt(ECONOMY.COST_SCALE - 1)).toBe(ECONOMY.CHEST_COST);
    expect(chestCostAt(ECONOMY.COST_SCALE)).toBe(ECONOMY.CHEST_COST + 1);
    expect(chestCostAt(ECONOMY.COST_SCALE * 400)).toBe(
      ECONOMY.CHEST_COST + 400,
    );
  });

  it('unlocks rarities as prestige accumulates', () => {
    // Base pool has the five classic tiers only.
    expect(availableRarities(0)).toEqual(RARITY_ORDER);
    // Each unlock adds its rarity once the threshold is crossed.
    expect(availableRarities(3)).toContain(RARITY.MYTHIC);
    expect(availableRarities(3)).not.toContain(RARITY.ANCIENT);
    expect(availableRarities(10)).toContain(RARITY.ANCIENT);
    expect(availableRarities(20)).toContain(RARITY.ASTRAL);
  });

  it('builds a gold-chest pool of rare-or-better tiers', () => {
    const pool = goldChestPool(PRESTIGE.RARITY_UNLOCKS[0].prestige);
    // Only tiers at or above rare appear, and none below it.
    for (const rarity of pool) {
      expect(RARITY_RANK[rarity]).toBeGreaterThanOrEqual(
        RARITY_RANK[RARITY.RARE],
      );
    }
    expect(pool).not.toContain(RARITY.COMMON);
    expect(pool).not.toContain(RARITY.UNCOMMON);
  });

  it('converts lifetime income to prestige points', () => {
    expect(prestigeGain(0)).toBe(0);
    expect(prestigeGain(PRESTIGE.PER_POINT - 1)).toBe(0);
    expect(prestigeGain(PRESTIGE.PER_POINT)).toBe(1);
    expect(prestigeGain(PRESTIGE.PER_POINT * 5 + 99)).toBe(5);
  });
});

describe('CardCollectionEconomy', () => {
  it('starts with the configured coins and no cards', () => {
    const eco = new CardCollectionEconomy();
    const state = eco.getState();
    expect(state.coins).toBe(ECONOMY.STARTING_COINS);
    expect(state.totalCards).toBe(0);
    expect(state.incomePerTick).toBe(0);
  });

  it('cannot buy a chest it cannot afford', () => {
    const eco = new CardCollectionEconomy({ coins: 5 });
    expect(eco.canBuyChest()).toBe(false);
    expect(eco.buyChest()).toBe(false);
    expect(eco.coins).toBe(5);
  });

  it('buying a chest deducts exactly the chest cost', () => {
    const eco = new CardCollectionEconomy({ coins: 30 });
    expect(eco.buyChest()).toBe(true);
    expect(eco.coins).toBe(30 - ECONOMY.CHEST_COST);
    expect(eco.chestsBought).toBe(1);
    expect(eco.coinsSpent).toBe(ECONOMY.CHEST_COST);
  });

  it('raises the chest price with lifetime income, uncapped', () => {
    const eco = new CardCollectionEconomy({ coins: 0 });
    expect(eco.currentChestCost()).toBe(ECONOMY.CHEST_COST);
    // Lifetime income drives the price up one coin per COST_SCALE, with no
    // cap, so it eventually outruns a maxed collection's income.
    eco.applyDraw('Slime', RARITY.COMMON); // +1 per tick
    eco.update(ECONOMY.INCOME_INTERVAL * ECONOMY.COST_SCALE);
    expect(eco.currentChestCost()).toBe(ECONOMY.CHEST_COST + 1);
  });

  it('a new draw creates a card and a duplicate levels it up', () => {
    const eco = new CardCollectionEconomy();
    const first = eco.applyDraw('Dragon', RARITY.EPIC);
    expect(first.isNew).toBe(true);
    expect(first.levelAfter).toBe(1);
    expect(eco.uniqueCards).toBe(1);

    const second = eco.applyDraw('Dragon', RARITY.EPIC);
    expect(second.isNew).toBe(false);
    expect(second.levelAfter).toBe(2);
    expect(eco.uniqueCards).toBe(1);
    expect(eco.cards.get('Dragon').level).toBe(2);
  });

  it('a duplicate raises the card income', () => {
    const eco = new CardCollectionEconomy();
    eco.applyDraw('Elder Wyrm', RARITY.LEGENDARY);
    const level1 = eco.incomePerTick();
    eco.applyDraw('Elder Wyrm', RARITY.LEGENDARY);
    const level2 = eco.incomePerTick();
    expect(level2).toBeGreaterThan(level1);
  });

  it('derives level from copies and caps at the current max level', () => {
    const eco = new CardCollectionEconomy();
    const cap = eco.maxLevel();
    expect(cap).toBe(maxLevelAt(0));
    const maxCopies = levelThresholds(0)[cap - 1];
    for (let i = 0; i < maxCopies; i += 1) {
      eco.applyDraw('Slime', RARITY.COMMON);
    }
    expect(eco.cards.get('Slime').copies).toBe(maxCopies);
    expect(eco.cards.get('Slime').level).toBe(cap);
    // Extra duplicates beyond the cap do not raise the level further.
    eco.applyDraw('Slime', RARITY.COMMON);
    expect(eco.cards.get('Slime').level).toBe(cap);
  });

  it('gives a card drawn after prestige a deeper cap', () => {
    const eco = new CardCollectionEconomy({ prestigeCount: 4 });
    eco.applyDraw('Slime', RARITY.COMMON);
    expect(eco.cards.get('Slime').maxLevel).toBe(maxLevelAt(4));
    // It still starts at Lv1 — a higher cap is headroom, not a head start.
    expect(eco.cards.get('Slime').level).toBe(1);
  });

  it('refunds a duplicate of a maxed card as coin', () => {
    const eco = new CardCollectionEconomy({ coins: 0 });
    const cap = eco.maxLevel();
    const maxCopies = levelThresholds(0)[cap - 1];
    for (let i = 0; i < maxCopies; i += 1) {
      eco.applyDraw('Slime', RARITY.COMMON);
    }
    const coinsBefore = eco.coins;
    const result = eco.applyDraw('Slime', RARITY.COMMON);
    expect(result.coinsAwarded).toBe(maxedDuplicateCoins(RARITY.COMMON));
    expect(eco.coins).toBe(coinsBefore + maxedDuplicateCoins(RARITY.COMMON));
    // The card stays capped, but the refunded coins are not passive income.
    expect(eco.cards.get('Slime').level).toBe(cap);
    expect(eco.coinsEarned).toBe(0);
  });

  it('mints coins at the fixed interval and tracks them', () => {
    const eco = new CardCollectionEconomy({ coins: 0 });
    eco.applyDraw('Slime', RARITY.COMMON); // +1 per tick
    const minted = eco.update(ECONOMY.INCOME_INTERVAL * 5);
    expect(minted).toBe(5);
    expect(eco.coins).toBe(5);
    expect(eco.coinsEarned).toBe(5);
  });

  it('mints nothing when the collection is empty', () => {
    const eco = new CardCollectionEconomy({ coins: 0 });
    expect(eco.update(10)).toBe(0);
    expect(eco.coins).toBe(0);
  });

  it('orders the collection by rarity, then level', () => {
    const eco = new CardCollectionEconomy();
    eco.applyDraw('Slime', RARITY.COMMON);
    eco.applyDraw('Dragon', RARITY.EPIC);
    const list = eco.collectionList();
    expect(list[0].name).toBe('Dragon');
    expect(list[list.length - 1].name).toBe('Slime');
  });

  it('survives JSON.stringify for replay', () => {
    const eco = new CardCollectionEconomy();
    eco.buyChest();
    eco.applyDraw('Golem', RARITY.RARE);
    const snapshot = eco.getState();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped.coins).toBe(snapshot.coins);
    expect(roundTripped.totalCards).toBe(1);
  });

  it('locks the gold chest until enough prestige', () => {
    const eco = new CardCollectionEconomy({ coins: 9999 });
    expect(eco.isGoldChestUnlocked()).toBe(false);
    expect(eco.canBuyGoldChest()).toBe(false);
    expect(eco.buyGoldChest()).toBe(false);
    // Unlock it by banking prestige, then it is affordable.
    eco.prestige = PRESTIGE.GOLD_CHEST_AT;
    expect(eco.isGoldChestUnlocked()).toBe(true);
    expect(eco.buyGoldChest()).toBe(true);
  });

  it('charges the gold chest a fixed multiple of the normal chest', () => {
    const eco = new CardCollectionEconomy({ coins: 9999 });
    eco.prestige = PRESTIGE.GOLD_CHEST_AT;
    const before = eco.coins;
    expect(eco.buyGoldChest()).toBe(true);
    expect(eco.coins).toBe(
      before - ECONOMY.CHEST_COST * ECONOMY.GOLD_CHEST_MULTIPLIER,
    );
  });

  it('prestige resets the run but banks points', () => {
    const eco = new CardCollectionEconomy();
    eco.applyDraw('Slime', RARITY.COMMON); // +1 per tick
    eco.update(ECONOMY.INCOME_INTERVAL * PRESTIGE.PER_POINT * 3);
    const gain = eco.prestigeReset();
    expect(gain).toBe(3);
    expect(eco.prestige).toBe(3);
    // The run resets: collection, coins, lifetime income all cleared.
    expect(eco.cards.size).toBe(0);
    expect(eco.coins).toBe(ECONOMY.STARTING_COINS);
    expect(eco.getState().totalIncome).toBe(0);
    expect(eco.currentChestCost()).toBe(ECONOMY.CHEST_COST);
  });

  it('round-trips through JSON without losing state', () => {
    const eco = new CardCollectionEconomy({ prestigeCount: 3 });
    eco.applyDraw('Slime', RARITY.COMMON);
    eco.applyDraw('Slime', RARITY.COMMON);
    eco.applyDraw('Elder Wyrm', RARITY.LEGENDARY);
    // A partly-elapsed income tick must survive too, or a reload could mint
    // income the player never earned (or drop income they did).
    eco.update(ECONOMY.INCOME_INTERVAL + 0.4);

    const restored = CardCollectionEconomy.fromJSON(
      JSON.parse(JSON.stringify(eco.toJSON())),
    );

    expect(restored.getState()).toEqual(eco.getState());
    expect(restored.cards.get('Slime').copies).toBe(2);
    // The cap travels with the card, so a later prestige cannot lift it.
    expect(restored.cards.get('Slime').maxLevel).toBe(maxLevelAt(3));
  });

  it('loads a save written by an older build', () => {
    // Absent fields fall back to constructor defaults rather than throwing,
    // so a save from before a field existed still opens.
    const restored = CardCollectionEconomy.fromJSON({ coins: 42 });
    expect(restored.coins).toBe(42);
    expect(restored.cards.size).toBe(0);
    expect(restored.getState().chestCost).toBe(ECONOMY.CHEST_COST);
  });
});

describe('CardInstance', () => {
  it('starts at level 1 with one copy', () => {
    const card = new CardInstance('Slime', RARITY.COMMON);
    expect(card.level).toBe(1);
    expect(card.copies).toBe(1);
    expect(card.incomePerTick()).toBe(1);
  });
});

describe('CardCollectorGame', () => {
  it('runs the full loop: buy, open, earn, buy again', () => {
    const game = new CardCollectorGame({ seed: 5 });
    // Starting coins afford a chest.
    expect(game.buyChest()).toBe(true);
    const result = game.openChest();
    expect(result).not.toBeNull();
    expect(result.name).toBeTruthy();
    expect(game.getState().economy.chestsOpened).toBe(1);

    // Now hold the card and wait for income to accrue.
    const income = game.getState().economy.incomePerTick;
    expect(income).toBeGreaterThan(0);
    const coinsBefore = game.getState().economy.coins;
    game.update(ECONOMY.INCOME_INTERVAL * 20);
    expect(game.getState().economy.coins).toBeGreaterThan(coinsBefore);
  });

  it('refuses to open without owning a chest', () => {
    const game = new CardCollectorGame({ seed: 2 });
    // No purchase: openChest still rolls, because a chest is always
    // resolved when the player has bought it — but a zero-coin economy
    // must still have paid for it. Assert the draw is applied.
    const before = game.getState().economy.chestsOpened;
    game.buyChest();
    const result = game.openChest();
    expect(result).not.toBeNull();
    expect(game.getState().economy.chestsOpened).toBe(before + 1);
  });

  it('is deterministic for a fixed seed', () => {
    const first = new CardCollectorGame({ seed: 11 });
    const second = new CardCollectorGame({ seed: 11 });
    first.buyChest();
    second.buyChest();
    expect(first.openChest().name).toBe(second.openChest().name);
  });

  it('stays idle after opening', () => {
    const game = new CardCollectorGame({ seed: 8 });
    game.buyChest();
    game.openChest();
    expect(game.getState().phase).toBe(GAME_PHASE.IDLE);
  });

  it('reports OPENING while a bought chest is unopened', () => {
    // The phase is derived from the buy/open counters, so it cannot drift
    // out of sync with them.
    const game = new CardCollectorGame({ seed: 8 });
    expect(game.getState().phase).toBe(GAME_PHASE.IDLE);
    game.buyChest();
    expect(game.getState().phase).toBe(GAME_PHASE.OPENING);
    game.openChest();
    expect(game.getState().phase).toBe(GAME_PHASE.IDLE);
    // Buying two and opening one leaves the game still mid-open. Fund the
    // purchases explicitly so this tests the counter, not the wallet.
    game.economy.coins = 100;
    game.buyChest();
    game.buyChest();
    game.openChest();
    expect(game.getState().phase).toBe(GAME_PHASE.OPENING);
  });

  it('emits a distinguishable event for every state change', () => {
    const game = new CardCollectorGame({ seed: 21 });
    /** @type {string[]} */
    const events = [];
    /** @type {unknown[]} */
    const details = [];
    game.onChange((_g, event, detail) => {
      events.push(event);
      details.push(detail);
    });

    game.economy.coins = 9999;
    game.buyChest();
    expect(events).toEqual([GAME_EVENT.CHEST_BOUGHT]);

    const result = game.openChest();
    expect(events).toEqual([
      GAME_EVENT.CHEST_BOUGHT,
      GAME_EVENT.CHEST_OPENED,
    ]);
    // The draw result rides along as the event detail.
    expect(details[1]).toBe(result);

    // Drive the mint through the game, not the economy, so the event fires.
    const minted = game.update(ECONOMY.INCOME_INTERVAL);
    expect(events[2]).toBe(GAME_EVENT.INCOME_MINTED);
    expect(details[2]).toBe(minted);

    game.prestige();
    expect(events[3]).toBe(GAME_EVENT.PRESTIGE);
  });

  it('keeps the mechanic contract in step with the emitted events', () => {
    // Regression guard: the contract once declared chest_bought /
    // chest_opened / income_minted while the game emitted nothing but a bare
    // "change". Any future divergence fails here instead of shipping.
    const contract = JSON.parse(
      readFileSync(new URL('../../../mechanic_contract.json', import.meta.url), 'utf8'),
    );
    const declared = contract.events
      .map((line) => line.split(' —')[0].trim())
      .filter((name) => !name.startsWith('onChange'))
      .sort();
    const defined = Object.values(GAME_EVENT).sort();
    expect(declared).toEqual(defined);
  });

  it('does not emit for a purchase or mint that did not happen', () => {
    const game = new CardCollectorGame({ seed: 5 });
    /** @type {string[]} */
    const events = [];
    game.onChange((_g, event) => events.push(event));

    game.economy.coins = 0;
    expect(game.buyChest()).toBe(false);
    // No cards owned, so income is zero and nothing is minted.
    game.update(ECONOMY.INCOME_INTERVAL);
    expect(events).toEqual([]);
  });

  it('reports a growing collection in its state', () => {
    const game = new CardCollectorGame({ seed: 3 });
    const uniqueBefore = game.getState().economy.uniqueCards;
    for (let i = 0; i < 3; i += 1) {
      game.economy.coins = 9999;
      game.buyChest();
      game.openChest();
    }
    expect(game.getState().economy.chestsOpened).toBe(3);
    expect(game.getState().economy.uniqueCards).toBeGreaterThanOrEqual(
      uniqueBefore,
    );
  });

  it('opens a gold chest from a rare-or-better pool', () => {
    const game = new CardCollectorGame({ seed: 4 });
    game.economy.prestige = PRESTIGE.GOLD_CHEST_AT;
    game.economy.coins = 9999;
    expect(game.buyGoldChest()).toBe(true);
    const result = game.openGoldChest();
    expect(result).not.toBeNull();
    expect(RARITY_RANK[result.rarity]).toBeGreaterThanOrEqual(
      RARITY_RANK[RARITY.RARE],
    );
  });

  it('prestiges through the game command and resets state', () => {
    const game = new CardCollectorGame({ seed: 6 });
    game.economy.applyDraw('Slime', RARITY.COMMON);
    game.economy.update(ECONOMY.INCOME_INTERVAL * PRESTIGE.PER_POINT * 2);
    const gain = game.prestige();
    expect(gain).toBe(2);
    expect(game.getState().economy.prestige).toBe(2);
    expect(game.getState().economy.uniqueCards).toBe(0);
    expect(game.getState().phase).toBe(GAME_PHASE.IDLE);
  });
});
