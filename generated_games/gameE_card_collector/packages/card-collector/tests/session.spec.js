/**
 * Session tests: the local/server split, and the API client's behaviour on
 * failure.
 *
 * These run against a fake `fetch`, so they do not need a server or a DOM.
 * The property that matters is that the server-backed session *adopts* what
 * the server says rather than computing anything itself — a client that
 * trusted its own arithmetic would be free to invent coins.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GameApiClient,
  GameApiError,
  createMemoryTokenStore,
} from '../src/api-client.js';
import { LocalSession, ServerSession } from '../src/session.js';

/** A `fetch` stand-in that answers from a route table. */
function fakeFetch(routes) {
  return vi.fn(async (url, init = {}) => {
    const path = new URL(url, 'http://test').pathname;
    const handler = routes[path];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'no such route' }), {
        status: 404,
      });
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    const result = await handler({ body, headers: init.headers ?? {} });
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
    });
  });
}

/** A minimal server snapshot, shaped like the real one. */
function snapshot(overrides = {}) {
  return {
    savedAt: 0,
    save: {
      coins: 100,
      baseChestCost: 10,
      incomeInterval: 1,
      prestige: 0,
      prestigeCount: 0,
      cards: [{ name: 'Slime', rarity: 'common', copies: 3, maxLevel: 5 }],
      chestsBought: 0,
      chestsOpened: 0,
      uniqueCards: 1,
      coinsEarned: 0,
      coinsSpent: 0,
      incomeAccumulator: 0,
      stats: { totalIncome: 0, totalDraws: 3, totalNewCards: 1 },
    },
    lastResult: null,
    economy: {
      coins: 100,
      chestCost: 10,
      chestsBought: 0,
      chestsOpened: 0,
      uniqueCards: 1,
      totalCards: 1,
      incomePerTick: 3,
      coinsEarned: 0,
      coinsSpent: 0,
      totalIncome: 0,
      totalDraws: 3,
      totalNewCards: 1,
      canBuyChest: true,
      prestige: 0,
      prestigeCount: 0,
      maxLevel: 5,
      prestigeGain: 0,
      goldChestCost: 30,
      goldChestUnlocked: false,
      canBuyGoldChest: false,
    },
    collection: [
      {
        name: 'Slime',
        rarity: 'common',
        level: 2,
        maxLevel: 5,
        copies: 3,
        incomePerTick: 2,
      },
    ],
    ...overrides,
  };
}

describe('GameApiClient', () => {
  it('stores the token returned by verify and sends it onward', async () => {
    const seen = [];
    const client = new GameApiClient({
      fetchImpl: fakeFetch({
        '/auth/verify': () => ({ body: { token: 'tok-1', address: '0xabc' } }),
        '/game/state': ({ headers }) => {
          seen.push(headers.Authorization);
          return { body: snapshot() };
        },
      }),
      tokenStore: createMemoryTokenStore(),
    });

    await client.verify('msg', 'sig');
    expect(client.signedIn).toBe(true);
    await client.state();
    expect(seen[0]).toBe('Bearer tok-1');
  });

  it('surfaces the server error message', async () => {
    const client = new GameApiClient({
      fetchImpl: fakeFetch({
        '/game/buy': () => ({ status: 409, body: { error: 'not enough coins' } }),
      }),
      tokenStore: createMemoryTokenStore(),
    });
    await expect(client.buy()).rejects.toThrow('not enough coins');
  });

  it('forgets the token when the server rejects the session', async () => {
    const store = createMemoryTokenStore();
    store.set('stale');
    const client = new GameApiClient({
      fetchImpl: fakeFetch({
        '/game/state': () => ({ status: 401, body: { error: 'not signed in' } }),
      }),
      tokenStore: store,
    });

    await expect(client.state()).rejects.toBeInstanceOf(GameApiError);
    // A dead token must not be retried forever.
    expect(client.signedIn).toBe(false);
  });

  it('reports an unreachable server distinctly from a rejection', async () => {
    const client = new GameApiClient({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
      tokenStore: createMemoryTokenStore(),
    });
    // Status 0 marks "no answer at all", so the UI can say something useful
    // instead of showing a browser-level fetch error.
    await expect(client.state()).rejects.toMatchObject({ status: 0 });
  });
});

describe('LocalSession', () => {
  it('plays without a server', () => {
    const session = new LocalSession(3);
    expect(session.mode).toBe('local');
    expect(session.getState().economy.coins).toBe(20);
    session.buy();
    session.open();
    expect(session.getState().economy.chestsOpened).toBe(1);
  });

  it('accrues income from elapsed time', () => {
    const session = new LocalSession(3);
    session.buy();
    session.open();
    const before = session.getState().economy.coins;
    session.tick(5);
    expect(session.getState().economy.coins).toBeGreaterThan(before);
  });
});

describe('ServerSession', () => {
  /**
   * A session wired to a fake server that always returns `snapshot()`.
   *
   * A token is pre-loaded because every game route needs a session — an
   * unauthenticated session deliberately does not call the server at all.
   */
  function makeSession(routes = {}, { signedIn = true } = {}) {
    const tokens = createMemoryTokenStore();
    if (signedIn) tokens.set('test-token');
    const api = new GameApiClient({
      fetchImpl: fakeFetch({
        '/auth/me': () => ({ body: { address: '0xabc' } }),
        '/game/state': () => ({ body: snapshot() }),
        '/game/buy': () => ({ body: snapshot({ savedAt: 1 }) }),
        ...routes,
      }),
      tokenStore: tokens,
    });
    return new ServerSession({ api });
  }

  it('starts empty until it has spoken to the server', () => {
    const session = makeSession();
    expect(session.mode).toBe('server');
    expect(session.getState().collection).toEqual([]);
  });

  it('does not call the server when there is no session', async () => {
    // An unauthenticated request would only earn a 401, so refresh declines
    // to make one and reports that it adopted nothing.
    const session = makeSession(
      {
        '/game/state': () => {
          throw new Error('should not be called');
        },
      },
      { signedIn: false },
    );
    expect(await session.refresh()).toBe(false);
    expect(session.getState().economy.coins).toBe(20);
  });

  it('adopts the server save rather than computing its own', async () => {
    const session = makeSession();
    await session.refresh();
    const state = session.getState();
    expect(state.economy.coins).toBe(100);
    expect(state.collection).toHaveLength(1);
    expect(state.collection[0].name).toBe('Slime');
  });

  it('restores a stored session on boot', async () => {
    const session = makeSession();
    expect(await session.restore()).toBe(true);
    expect(session.address).toBe('0xabc');
    expect(session.getState().economy.coins).toBe(100);
  });

  it('does not restore when there is no stored token', async () => {
    const session = makeSession({}, { signedIn: false });
    expect(await session.restore()).toBe(false);
    expect(session.address).toBeNull();
  });

  it('replaces its view with whatever a purchase returns', async () => {
    // The client must not add a chest locally: the server decides.
    const session = makeSession({
      '/game/buy': () => ({ body: snapshot({ savedAt: 42 }) }),
    });
    await session.buy();
    expect(session.lastSnapshot.savedAt).toBe(42);
  });

  it('records an error and keeps playing when an action is refused', async () => {
    const session = makeSession({
      '/game/buy': () => ({ status: 409, body: { error: 'not enough coins' } }),
    });
    const before = session.getState().economy.coins;
    expect(await session.buy()).toBe(false);
    expect(session.error).toBe('not enough coins');
    // State is untouched, because the server did not change it.
    expect(session.getState().economy.coins).toBe(before);
  });

  it('restores from the raw save, not the derived price', async () => {
    // `economy.chestCost` is the *current* price (base + surcharge). If the
    // client rebuilt a save from the derived view it would store that as the
    // base cost, and each refresh would compound the surcharge: 60, then 120,
    // then 180. Restoring from `save` keeps the base at 10 forever.
    const session = makeSession({
      '/game/state': () => ({
        body: snapshot({
          save: {
            ...snapshot().save,
            baseChestCost: 10,
            stats: { totalIncome: 5000, totalDraws: 0, totalNewCards: 0 },
          },
        }),
      }),
    });

    for (let i = 0; i < 3; i += 1) await session.refresh();

    // 10 + floor(5000 / COST_SCALE 100) = 60, stable across refetches.
    expect(session.getState().economy.chestCost).toBe(60);
    expect(session.game.economy.baseChestCost).toBe(10);
  });

  it('clears the view on disconnect', async () => {
    const session = makeSession({
      '/auth/logout': () => ({ body: { ok: true } }),
    });
    await session.refresh();
    expect(session.getState().collection).toHaveLength(1);

    await session.disconnect();
    expect(session.address).toBeNull();
    expect(session.getState().collection).toEqual([]);
    expect(session.api.signedIn).toBe(false);
  });

  it('polls the server for income instead of minting locally', async () => {
    const session = makeSession();
    await session.refresh();

    const spy = vi.spyOn(session.api, 'state');
    // Under the poll interval: no request, and no local income either.
    session.tick(30);
    expect(spy).not.toHaveBeenCalled();

    session.tick(31);
    expect(spy).toHaveBeenCalled();
  });

  it('reports a failed connect without throwing', async () => {
    const session = makeSession();
    const connector = async () => {
      throw new Error('boom');
    };
    expect(await session.connect({ walletConnector: connector })).toBe(false);
    expect(session.error).toBeTruthy();
  });
});
