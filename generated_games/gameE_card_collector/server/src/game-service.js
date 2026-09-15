/**
 * Game rules, run authoritatively on the server.
 *
 * Every state transition lives here and is driven from a persisted save. The
 * client is a view: it *asks* to buy or open, and is told what happened. That
 * inverts the previous design, where the browser held the wallet and the draw
 * roll, and held them over page reloads not at all.
 *
 * The rules themselves are not reimplemented. `@a3game/card-collector`'s
 * catalog/economy/game modules were built engine-agnostic precisely so they
 * could run headless, and this file simply loads a save into them, applies one
 * action, and writes the result back.
 */

// The `/rules` subpath, not the package root: the root boots the browser game
// and would drag three.js into a headless process for no reason.
import {
  CardCollectionEconomy,
  CardCollectorGame,
} from '@a3game/card-collector/rules';
import { HttpError } from './errors.js';
import { createCryptoRandom } from './rng.js';

export class GameService {
  /**
   * @param {import('./store.js').Store} store
   * @param {{maxOfflineSeconds: number}} config
   */
  constructor(store, config) {
    /** The store is exposed so claim routes can read a save directly. */
    this.store = store;
    this.config = config;
  }

  /**
   * Load a player's game, restoring their save and crediting at most
   * `maxOfflineSeconds` of offline income.
   *
   * @param {string} address
   * @param {number} [now]
   */
  load(address, now = Date.now()) {
    const save = this.store.loadSave(address);
    const economy = save
      ? CardCollectionEconomy.fromJSON(save)
      : new CardCollectionEconomy();

    if (save) {
      const updatedAt = this.store.saveUpdatedAt(address);
      if (updatedAt) {
        const elapsed = Math.min(
          Math.max(0, (now - updatedAt) / 1000),
          this.config.maxOfflineSeconds,
        );
        // `update` mints whole ticks only, so a partial tick is carried in
        // the economy's accumulator rather than lost.
        economy.update(elapsed);
      }
    }

    return {
      economy,
      game: new CardCollectorGame({
        economy,
        random: createCryptoRandom(),
      }),
    };
  }

  /** Persist a game's economy. */
  persist(address, economy) {
    this.store.saveGame(address, economy.toJSON());
  }

  /**
   * Run one action against a fresh load of the player's game, then save.
   *
   * Each request loads and saves independently so the stored save is the only
   * source of truth — there is no in-memory session state a client could get
   * out of step with, and no way to act on a stale copy.
   *
   * @param {string} address
   * @param {(ctx: ReturnType<GameService['load']>) => any} action
   */
  apply(address, action) {
    const ctx = this.load(address);
    const result = action(ctx);
    this.persist(address, ctx.economy);
    return { ...this.snapshot(ctx), result };
  }

  /** Current save, without applying any action. */
  state(address) {
    const ctx = this.load(address);
    this.persist(address, ctx.economy);
    return this.snapshot(ctx);
  }

  /** Buy a chest, if affordable. */
  buyChest(address) {
    return this.apply(address, ({ game }) => {
      if (!game.buyChest()) throw new HttpError(409, 'not enough coins');
      return { bought: true };
    });
  }

  /** Buy a gold chest, if unlocked and affordable. */
  buyGoldChest(address) {
    return this.apply(address, ({ game }) => {
      if (!game.buyGoldChest()) {
        throw new HttpError(409, 'gold chest is locked or unaffordable');
      }
      return { bought: true };
    });
  }

  /**
   * Open a chest. The rarity roll happens here, on the server, against a
   * cryptographic source — the client cannot influence or predict it.
   */
  openChest(address, { gold = false } = {}) {
    return this.apply(address, ({ game, economy }) => {
      if (economy.chestsBought <= economy.chestsOpened) {
        throw new HttpError(409, 'no unopened chest to open');
      }
      const result = gold ? game.openGoldChest() : game.openChest();
      if (!result) throw new HttpError(409, 'nothing to open');
      return result.toJSON();
    });
  }

  /** Reset the run for prestige. */
  prestige(address) {
    return this.apply(address, ({ game, economy }) => {
      const gain = game.prestige();
      if (gain <= 0) {
        throw new HttpError(409, 'prestige would grant no points yet');
      }
      const state = economy.getState();
      return {
        gain,
        prestige: state.prestige,
        prestigeCount: state.prestigeCount,
        maxLevel: state.maxLevel,
      };
    });
  }

  /** Credit elapsed income for an explicit `seconds`, bounded by the config. */
  tick(address, seconds) {
    const requested = Number(seconds);
    if (!Number.isFinite(requested) || requested < 0) {
      throw new HttpError(400, 'seconds must be a non-negative number');
    }
    // The same cap as offline accrual: a client cannot ask for a year.
    const capped = Math.min(requested, this.config.maxOfflineSeconds);
    return this.apply(address, ({ economy }) => ({
      minted: economy.update(capped),
    }));
  }

  /**
   * The public shape of a game, sent to the client.
   *
   * Carries the raw save alongside the derived view. The derived fields are
   * what the HUD renders; the raw save is what the client restores from, so
   * reloading a save never has to round-trip through a lossy mapping (and
   * `chestCost` — a derived price — can never be mistaken for the base cost
   * the economy stores).
   */
  snapshot({ game, economy }) {
    return {
      savedAt: Date.now(),
      save: economy.toJSON(),
      ...game.getState(),
    };
  }
}
