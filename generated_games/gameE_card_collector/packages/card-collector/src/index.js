/**
 * Card-collector boot: wires the rules, the 3D stand, the HUD, and input.
 *
 * The game is a 2D-leaning collectible idle: buy a chest, open it to draw
 * a card, hold cards that mint coins every tick, and spend those coins on
 * more chests. Duplicates level a card up and multiply its income.
 *
 * Input is real: `KeyB` buys a chest, `Space` opens one, and the same two
 * verbs are on clickable buttons (`data-game-action`), so a playtest can
 * drive the actual game and a human can click. The playtest plan is
 * declared on `window.__A3GAME_PLAYTEST__` because only the game knows
 * where its verbs are.
 */

import * as THREE from 'three';
import {
  A3GameInputRouter,
  A3GameLookMode,
  bootA3GameRuntime,
} from '@a3game/playable';
import { GameApiClient } from './api-client.js';
import { CardCollectorGame } from './game.js';
import { aimCamera, CardCollectorRenderer, lightStage } from './renderer.js';
import { LocalSession, ServerSession } from './session.js';
import { hasWallet } from './wallet.js';

export {
  CARD_POOL,
  ECONOMY,
  PRESTIGE,
  RARITY,
  RARITY_PROFILE,
  availableRarities,
  goldChestPool,
  maxLevelAt,
} from './catalog.js';
export {
  CardInstance,
  CardCollectionEconomy,
  ChestResult,
} from './economy.js';
export { CardCollectorGame, GAME_EVENT, GAME_PHASE } from './game.js';
export { CardCollectorRenderer } from './renderer.js';
export {
  GameApiClient,
  GameApiError,
  createBrowserTokenStore,
} from './api-client.js';
export { LocalSession, ServerSession } from './session.js';
export {
  WalletError,
  connectAndSignIn,
  connectWallet,
  createSiweMessage,
  hasWallet,
} from './wallet.js';

/** Build two clickable action buttons inside the HUD container. */
function buildButtons(hudContainer) {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);' +
    'display:flex;gap:12px;pointer-events:auto;';

  const make = (label, action) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.dataset.gameAction = action;
    button.style.cssText =
      'padding:12px 22px;font-size:16px;font-weight:600;border:none;' +
      'border-radius:10px;cursor:pointer;color:#14161c;' +
      'background:linear-gradient(90deg,#4ade80,#22d3ee);';
    bar.appendChild(button);
    return button;
  };

  const buy = make('Buy Chest (10)', 'buy_chest');
  const open = make('Open Chest', 'open_chest');
  const gold = make('Gold Chest', 'buy_gold_chest');
  const prestige = make('Prestige', 'prestige');
  const claim = make('Claim to wallet', 'claim_cards');
  hudContainer.appendChild(bar);
  return { bar, buy, open, gold, prestige, claim };
}

/** Build the wallet connect / disconnect control and the status line. */
function buildWalletBar(hudContainer) {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;top:16px;right:16px;display:flex;gap:8px;' +
    'align-items:center;pointer-events:auto;font:13px system-ui;color:#cbd5e1;';

  const status = document.createElement('span');
  status.dataset.walletStatus = 'true';
  status.style.cssText = 'opacity:0.85;';

  const button = document.createElement('button');
  button.dataset.gameAction = 'connect_wallet';
  button.style.cssText =
    'padding:8px 14px;font-size:13px;font-weight:600;border:none;' +
    'border-radius:8px;cursor:pointer;color:#14161c;' +
    'background:linear-gradient(90deg,#c084fc,#38bdf8);';

  bar.append(status, button);
  hudContainer.appendChild(bar);
  return { bar, status, button };
}

/** Push the latest game state into the HUD and the 3D stand. */
function sync(session, hud, renderer, buttons, wallet, chain) {
  const state = session.getState();
  const eco = state.economy;

  hud.setValue('coins', `Coins ${eco.coins}`);
  hud.setValue('income', `Income +${eco.incomePerTick}/s`);
  hud.setValue(
    'stats',
    `${eco.uniqueCards} unique / ${eco.chestsOpened} opened`,
  );
  // Show the level cap alongside prestige: raising it is the headline reward
  // for resetting, so it belongs where the player decides whether to reset.
  hud.setValue(
    'prestige',
    `Prestige ${eco.prestige} (+${eco.prestigeGain} next) · Lv cap ${eco.maxLevel}`,
  );
  if (buttons) {
    buttons.buy.textContent = `Buy Chest (${eco.chestCost})`;
    buttons.buy.disabled = !eco.canBuyChest;
    buttons.gold.textContent = eco.goldChestUnlocked
      ? `Gold Chest (${eco.goldChestCost})`
      : 'Gold Chest (locked)';
    buttons.gold.disabled = !eco.canBuyGoldChest;
    buttons.prestige.textContent =
      `Prestige (+${eco.prestigeGain}) → Lv${eco.maxLevel + 1}`;
    buttons.prestige.disabled = eco.prestigeGain <= 0;

    // Claiming needs a wallet session; without one there is nobody to mint to.
    const claimable = chain?.claimable ?? 0;
    buttons.claim.textContent = chain?.busy
      ? 'Claiming…'
      : claimable > 0
        ? `Claim ${claimable} to wallet`
        : 'Claim to wallet';
    buttons.claim.disabled = Boolean(chain?.busy) || claimable <= 0;
  }

  const cards = state.collection;
  const listing =
    cards.length === 0
      ? '(none yet)'
      : cards
          .slice(0, 12)
          .map(
            (card) =>
              `${card.name} Lv.${card.level}/${card.maxLevel} ` +
              `(+${card.incomePerTick})`,
          )
          .join('\n');
  hud.setValue('collection', `Collection\n${listing}`);

  if (state.lastResult) {
    const { name, rarity, isNew, levelAfter, coinsAwarded } = state.lastResult;
    hud.setValue(
      'result',
      coinsAwarded > 0
        ? `${name} MAXED → +${coinsAwarded} coins`
        : isNew
          ? `NEW! ${name} (${rarity})`
          : `${name} → Lv.${levelAfter}`,
    );
    hud.setVisible('result', true);
  }

  if (wallet) {
    const signedIn = Boolean(session.address);
    wallet.status.textContent = signedIn
      ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}`
      : session.error
        ? session.error
        : hasWallet()
          ? 'Not signed in — progress is local'
          : 'No wallet detected — progress is local';
    wallet.status.style.color = session.error ? '#fca5a5' : '#cbd5e1';
    wallet.button.textContent = signedIn ? 'Sign out' : 'Connect wallet';
  }

  renderer.renderWall(cards);
}

/**
 * Start the game. Returns the full runtime context plus the game itself.
 *
 * Play starts locally and needs nothing. Connecting a wallet switches to the
 * server-backed session, which owns the save from then on.
 *
 * @param {{container?: string, hudContainer?: string, seed?: number,
 *          apiBaseUrl?: string, apiClient?: GameApiClient,
 *          session?: LocalSession | ServerSession}} [options]
 */
export async function startCardCollector(options = {}) {
  const runtimeContext = await bootA3GameRuntime({
    container: options.container ?? '#a3game-viewport',
    hudContainer: options.hudContainer ?? '#a3game-hud',
    hostOptions: { fov: 55, clearColor: 0x14161c },
    autoBeginPlay: false,
    autoStart: false,
  });
  // The runtime's own `session` is not used here; the name belongs to the
  // wallet session below, which is the thing this file actually manages.
  const { host, assets, hud, runtime } = runtimeContext;

  const renderer = new CardCollectorRenderer({
    host,
    root: host.getRoot(),
  });
  renderer.build();
  lightStage(host);
  aimCamera(host);

  hud.addText('coins', { anchor: 'top-left', value: 'Coins 0' });
  hud.addText('income', { anchor: 'top-left', value: 'Income +0/s' });
  hud.addText('stats', { anchor: 'top-left', value: '0 unique / 0 opened' });
  hud.addText('prestige', { anchor: 'top-left', value: 'Prestige 0 (+0 next)' });
  hud.addPanel('collection', { anchor: 'top-right', value: 'Collection' });
  hud.addBanner('result', { anchor: 'center', value: '', visible: false });

  const buttons = buildButtons(hud.container);
  const wallet = buildWalletBar(hud.container);

  const api =
    options.apiClient ??
    new GameApiClient({ baseUrl: options.apiBaseUrl ?? '' });

  /**
   * The active session. Local by default; connecting a wallet swaps in a
   * server-backed one that owns the save.
   *
   * Everything below goes through `session`, which is why the input handlers
   * do not care which mode is active.
   */
  let session = options.session ?? new LocalSession(options.seed ?? 7);
  const game = session.game;

  /**
   * Claim state, kept outside the session because it is a view concern:
   * `claimable` counts what the *server* would sign, `busy` guards the button
   * while a wallet prompt is open.
   */
  const chain = { claimable: 0, busy: false, available: false, reason: null };

  const rerender = () =>
    sync(session, hud, renderer, buttons, wallet, chain);
  let unsubscribe = session.onChange(rerender);

  /** Swap the active session, rewiring the subscription. */
  function useSession(next) {
    unsubscribe();
    session = next;
    unsubscribe = session.onChange(rerender);
    rerender();
  }

  /** Refresh how much is left to mint. Silently no-ops without a session. */
  async function refreshClaimable() {
    if (!session.claimable) {
      chain.claimable = 0;
      chain.available = false;
      rerender();
      return;
    }
    try {
      const info = await session.claimable();
      chain.available = info.available;
      chain.reason = info.reason;
      chain.claimable = (info.cards ?? []).reduce(
        (sum, card) => sum + card.claimable,
        0,
      );
    } catch {
      // A failed poll must not break rendering; the button simply stays put.
      chain.claimable = 0;
    }
    rerender();
  }

  /** Mint everything unminted, then refresh the counters. */
  async function claimCards() {
    if (chain.busy || !session.claimAll) return;
    chain.busy = true;
    rerender();
    try {
      const outcome = await session.claimAll();
      chain.lastOutcome = outcome;
    } catch (error) {
      chain.lastOutcome = { claimed: [], reason: error.message };
    } finally {
      chain.busy = false;
      await refreshClaimable();
    }
  }

  /** The server-backed session, created once and reused across sign-ins. */
  let serverSession = null;
  const getServerSession = () => {
    serverSession ??= new ServerSession({ api, seed: options.seed ?? 7 });
    return serverSession;
  };

  /**
   * Boot into the player's save when this browser already holds a token.
   *
   * Without this the stored session is never read, so a reload silently drops
   * the player back to a fresh local game — which is exactly the failure this
   * whole phase exists to fix.
   */
  if (!options.session && api.signedIn) {
    const restored = getServerSession();
    useSession(restored);
    await restored.restore();
    // A stored token can be expired or revoked server-side; fall back rather
    // than leaving the player on an empty view.
    if (!restored.address) useSession(new LocalSession(options.seed ?? 7));
  }

  async function connectWallet() {
    const target = getServerSession();
    useSession(target);
    const ok = await target.connect();
    if (!ok) {
      // Sign-in failed or was declined: keep playing locally rather than
      // stranding the player on an empty server view.
      useSession(new LocalSession(options.seed ?? 7));
      return false;
    }
    await refreshClaimable();
    return true;
  }

  async function disconnectWallet() {
    if (serverSession) await serverSession.disconnect();
    useSession(new LocalSession(options.seed ?? 7));
  }

  const input = new A3GameInputRouter({
    target: host.container,
    lookMode: A3GameLookMode.DRAG,
    actionBindings: {
      KeyB: 'buy_chest',
      Space: 'open_chest',
      KeyG: 'buy_gold_chest',
      KeyP: 'prestige',
    },
  }).enable();
  input.onAction((action, phase) => {
    if (phase !== 'pressed') return;
    if (action === 'buy_chest') {
      session.buy();
    } else if (action === 'buy_gold_chest') {
      session.buyGold();
    } else if (action === 'open_chest') {
      session.open();
      renderer.hopChest();
    } else if (action === 'prestige') {
      session.prestige();
    }
  });

  buttons.buy.addEventListener('click', () => session.buy());
  buttons.gold.addEventListener('click', () => session.buyGold());
  buttons.prestige.addEventListener('click', () => session.prestige());
  buttons.open.addEventListener('click', () => {
    session.open();
    renderer.hopChest();
  });
  wallet.button.addEventListener('click', () => {
    if (session.address) disconnectWallet();
    else connectWallet();
  });
  buttons.claim.addEventListener('click', claimCards);

  const unsubscribeTick = host.onTick((delta) => {
    session.tick(delta);
    renderer.update(delta);
    rerender();
  });

  runtime.onWorldBeginPlay();
  host.start();
  rerender();
  // After the first paint, so a slow claim lookup never delays the game.
  refreshClaimable();

  // Only the game knows its verbs; declare them so a playtest presses the
  // right keys instead of guessing.
  window.__A3GAME_PLAYTEST__ = {
    warmup: 0.5,
    actions: [
      { id: 'buy_chest', taps: ['KeyB'] },
      { id: 'open_chest', taps: ['Space'] },
    ],
  };

  const context = {
    ...runtimeContext,
    // `session` is a getter because connecting a wallet swaps it mid-run.
    get session() {
      return session;
    },
    get game() {
      return game;
    },
    get address() {
      return session.address;
    },
    connectWallet,
    disconnectWallet,
    claimCards,
    refreshClaimable,
    chain,
    renderer,
    input,
    buttons,
    wallet,
    getState() {
      return session.getState();
    },
    dispose() {
      unsubscribeTick();
      unsubscribe();
      input.disable();
      renderer.dispose();
      hud.dispose();
      runtime.deinitialize();
      assets.dispose();
      host.dispose();
    },
  };
  // The playtest recorder reads this exact name (`__A3GAME_GAME__`) for the
  // host, input router, HUD, and state. The game-specific alias is kept for
  // human debugging and tests.
  globalThis.__A3GAME_GAME__ = context;
  globalThis.__A3GAME_CARD_COLLECTOR__ = context;
  return context;
}
