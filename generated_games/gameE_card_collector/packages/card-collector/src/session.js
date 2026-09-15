/**
 * Session: decides whether the game runs locally or against the server.
 *
 * The two modes exist on purpose.
 *
 * **Local** is the default and needs nothing: no wallet, no server. It keeps
 * the game playable as a demo and keeps the existing tests and playtest
 * harness working, which all drive the game directly.
 *
 * **Server-backed** engages when the player connects a wallet. From then on
 * the server owns the save and adjudicates every action, because a collection
 * the player is said to *own* has to live somewhere that outlives the tab —
 * and because a client that rolls its own draws can pick its own results.
 *
 * Both modes present the same surface, so the rest of the boot code does not
 * branch on which one is active.
 */

import { GameApiClient } from './api-client.js';
import { CardCollectionEconomy, ChestResult } from './economy.js';
import { CardCollectorGame } from './game.js';
import {
  connectAndSignIn,
  connectWallet,
  ensureChain,
  nextNonce,
  sendTransaction,
  WalletError,
} from './wallet.js';

/**
 * Replace a live game's state with a server snapshot, keeping subscribers.
 *
 * Restores from the snapshot's raw `save` rather than reassembling one from
 * the derived view: `economy.chestCost` is the *current* price (base plus the
 * lifetime-income surcharge), so mapping it onto the economy's `baseChestCost`
 * would double-count the surcharge on every round trip.
 *
 * @param {import('./game.js').CardCollectorGame} game
 * @param {{save: object, lastResult?: object|null}} snapshot
 */
function adoptSave(game, snapshot) {
  game.economy = CardCollectionEconomy.fromJSON(snapshot.save);
  game.lastResult = snapshot.lastResult
    ? ChestResult.fromJSON(snapshot.lastResult)
    : null;
  return game.economy;
}

export class LocalSession {
  /**
   * @param {number} seed keeps draws reproducible, as the browser always has
   */
  constructor(seed = 7) {
    this.mode = 'local';
    this.address = null;
    /** @type {string | null} */
    this.error = null;
    this.game = new CardCollectorGame({ seed });
  }

  /** Local play has nothing to connect. */
  get canConnect() {
    return true;
  }

  /** No-op: local draws are computed in-process. */
  async refresh() {}

  /** Advance the local economy by real elapsed time. */
  tick(deltaSeconds) {
    this.game.update(deltaSeconds);
  }

  buy() {
    return this.game.buyChest();
  }

  buyGold() {
    return this.game.buyGoldChest();
  }

  open() {
    return this.game.openChest();
  }

  openGold() {
    return this.game.openGoldChest();
  }

  prestige() {
    return this.game.prestige();
  }

  getState() {
    return this.game.getState();
  }

  onChange(listener) {
    return this.game.onChange(listener);
  }
}

/**
 * A session whose save lives on the server.
 *
 * Keeps a `CardCollectorGame` as a *view* of the last server response, so the
 * renderer and HUD keep working against the same shape. The game object never
 * adjudicates here — its `buyChest`/`openChest` are never called; every
 * mutation is a request whose response replaces the view.
 */
export class ServerSession {
  /**
   * @param {{api?: GameApiClient, seed?: number}} [options]
   */
  constructor(options = {}) {
    this.mode = 'server';
    this.api = options.api ?? new GameApiClient();
    this.address = null;
    /** @type {string | null} */
    this.error = null;
    /** @type {(() => void)[]} */
    this._listeners = [];
    /** The rendered view. Starts empty; `refresh()` fills it. */
    this.game = new CardCollectorGame({ seed: options.seed ?? 7 });
    /** Last server snapshot, for tests and debugging. */
    this.lastSnapshot = null;
    /** Seconds accumulated since the last income poll. */
    this._sinceRefresh = 0;
  }

  get canConnect() {
    return true;
  }

  get signedIn() {
    return this.api.signedIn;
  }

  /** Subscribe, matching the local session's surface. */
  onChange(listener) {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
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

  /** Adopt a server snapshot as the rendered view. */
  adopt(snapshot) {
    this.lastSnapshot = snapshot;
    adoptSave(this.game, snapshot);
    this._emit();
  }

  /**
   * Restore an existing session, if the browser has a stored token.
   *
   * Called on boot: a returning player lands straight in their save rather
   * than being asked to sign again.
   */
  async restore() {
    if (!this.api.signedIn) return false;
    try {
      this.address = await this.api.me();
      if (!this.address) return false;
      this.adopt(await this.api.state());
      return true;
    } catch (error) {
      this.error = error.message;
      return false;
    }
  }

  /** Connect a wallet, sign in, and load the save. */
  async connect({ walletConnector = connectAndSignIn } = {}) {
    this.error = null;
    try {
      const { address } = await walletConnector(this.api);
      this.address = address;
      this.adopt(await this.api.state());
      return true;
    } catch (error) {
      this.error =
        error instanceof WalletError ? error.message : 'Could not sign in.';
      this._emit();
      return false;
    }
  }

  /** Disconnect: end the session and fall back to a fresh local view. */
  async disconnect() {
    await this.api.logout();
    this.address = null;
    this.lastSnapshot = null;
    this.game = new CardCollectorGame({ seed: 7 });
    this._emit();
  }

  /**
   * Re-pull the save, letting the server credit offline income.
   *
   * Does nothing without a session: an unauthenticated request would only
   * earn a 401, and the local fallback is already showing.
   *
   * @returns {Promise<boolean>} whether a snapshot was adopted
   */
  async refresh() {
    if (!this.signedIn) return false;
    this.adopt(await this.api.state());
    return true;
  }

  /**
   * Income accrual is the server's job.
   *
   * Pulling once a minute is enough to make the HUD feel live without
   * hammering the API; the authoritative number is whatever the next response
   * says, so a missed poll costs nothing but staleness.
   */
  tick(deltaSeconds) {
    this._sinceRefresh += deltaSeconds;
    if (this._sinceRefresh < 60) return;
    this._sinceRefresh = 0;
    this.refresh().catch(() => {
      /* a dropped poll is not worth surfacing; the next one retries */
    });
  }

  /** Run a mutating request, adopting the response. */
  async _act(request) {
    try {
      this.adopt(await request());
      return true;
    } catch (error) {
      this.error = error.message;
      this._emit();
      return false;
    }
  }

  buy({ gold = false } = {}) {
    return this._act(() => this.api.buy({ gold }));
  }

  buyGold() {
    return this._act(() => this.api.buy({ gold: true }));
  }

  open({ gold = false } = {}) {
    return this._act(() => this.api.open({ gold }));
  }

  openGold() {
    return this._act(() => this.api.open({ gold: true }));
  }

  prestige() {
    return this._act(() => this.api.prestige());
  }

  getState() {
    return this.game.getState();
  }

  // --- on-chain claiming --------------------------------------------------

  /**
   * What the player can still mint.
   *
   * @returns {Promise<{available: boolean, reason: string|null, cards: object[]}>}
   */
  async claimable() {
    return this.api.claimable();
  }

  /**
   * Claim every card the player has drawn but not yet minted.
   *
   * Per card: ask the server to sign a voucher, send it through the wallet
   * (the player pays that gas), then report success so the next claim tops up
   * from the new total rather than re-signing what is already held.
   *
   * A voucher that the player declines in the wallet stops the run — continuing
   * would fire a prompt per remaining card, which is worse than asking again
   * later. Everything minted before that point is already recorded.
   *
   * @param {{ensureChain?: Function, sendTransaction?: Function}} [hooks]
   *   injected for testing; default to the real wallet calls
   * @returns {Promise<{claimed: object[], failed: object|null, reason: string|null}>}
   */
  async claimAll(hooks = {}) {
    const ensure = hooks.ensureChain ?? ensureChain;
    const send = hooks.sendTransaction ?? sendTransaction;

    this.error = null;
    const issued = await this.api.vouchers();

    if (!issued.vouchers?.length) {
      return { claimed: [], failed: null, reason: 'nothing to claim' };
    }

    // One prompt, before any transaction, rather than one per card.
    await ensure(issued.chainId);

    /**
     * Nonces are assigned here, not left to the node.
     *
     * Left implicit, the node reuses the first nonce for the second send —
     * its "pending" count has not moved yet — so only the first card mints and
     * the rest are rejected. Reading the pending count once and incrementing
     * per voucher keeps them distinct.
     */
    let nonce = hooks.nextNonce
      ? await hooks.nextNonce(this.address)
      : await nextNonce(this.address);

    const claimed = [];
    for (const voucher of issued.vouchers) {
      try {
        const hash = await send(voucher.transaction, this.address, nonce);
        nonce += 1;
        await this.api.reportClaimed(voucher.tokenId, voucher.amount);
        claimed.push({
          name: voucher.card.name,
          tokenId: voucher.tokenId,
          amount: voucher.claimable,
          hash,
        });
      } catch (error) {
        // Stop on the first failure: a declined prompt is a decision, and
        // retrying the rest would just re-prompt for each one.
        this.error = error.message;
        this._emit();
        return {
          claimed,
          failed: { name: voucher.card.name, tokenId: voucher.tokenId },
          reason: error.message,
        };
      }
    }

    this._emit();
    return { claimed, failed: null, reason: null };
  }
}

export {
  connectAndSignIn,
  connectWallet,
  ensureChain,
  nextNonce,
  sendTransaction,
};
