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
import { CardCollectorGame } from './game.js';
import { aimCamera, CardCollectorRenderer, lightStage } from './renderer.js';

export { CARD_POOL, ECONOMY, RARITY, RARITY_PROFILE } from './catalog.js';
export {
  CardInstance,
  CardCollectionEconomy,
  ChestResult,
} from './economy.js';
export { CardCollectorGame, GAME_EVENT, GAME_PHASE } from './game.js';
export { CardCollectorRenderer } from './renderer.js';

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
  hudContainer.appendChild(bar);
  return { bar, buy, open, gold, prestige };
}

/** Push the latest game state into the HUD and the 3D stand. */
function sync(game, hud, renderer, buttons) {
  const state = game.getState();
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

  renderer.renderWall(cards);
}

/**
 * Start the game. Returns the full runtime context plus the game itself.
 *
 * @param {{container?: string, hudContainer?: string, seed?: number}}
 *        [options]
 */
export async function startCardCollector(options = {}) {
  const runtimeContext = await bootA3GameRuntime({
    container: options.container ?? '#a3game-viewport',
    hudContainer: options.hudContainer ?? '#a3game-hud',
    hostOptions: { fov: 55, clearColor: 0x14161c },
    autoBeginPlay: false,
    autoStart: false,
  });
  const { host, assets, hud, session, runtime } = runtimeContext;

  const game = new CardCollectorGame({ seed: options.seed ?? 7 });

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
      game.buyChest();
    } else if (action === 'buy_gold_chest') {
      game.buyGoldChest();
    } else if (action === 'open_chest') {
      const result = game.openChest();
      if (result) renderer.hopChest();
    } else if (action === 'prestige') {
      game.prestige();
    }
  });

  buttons.buy.addEventListener('click', () => game.buyChest());
  buttons.gold.addEventListener('click', () => game.buyGoldChest());
  buttons.prestige.addEventListener('click', () => game.prestige());
  buttons.open.addEventListener('click', () => {
    const result = game.openChest();
    if (result) renderer.hopChest();
  });

  game.onChange(() => sync(game, hud, renderer, buttons));

  const unsubscribe = host.onTick((delta) => {
    game.update(delta);
    renderer.update(delta);
    sync(game, hud, renderer, buttons);
  });

  runtime.onWorldBeginPlay();
  host.start();
  sync(game, hud, renderer, buttons);

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
    game,
    renderer,
    input,
    buttons,
    getState() {
      return game.getState();
    },
    dispose() {
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
