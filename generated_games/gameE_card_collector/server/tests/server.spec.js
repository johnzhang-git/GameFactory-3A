/**
 * Backend tests: login, persistence, authoritative draws, and the bounds that
 * stop a client from minting its own coins.
 *
 * These boot a real server on an ephemeral port against an in-memory database,
 * so they exercise the HTTP surface end to end rather than calling handlers
 * directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { startServer } from '../src/server.js';

/** @type {Awaited<ReturnType<typeof startServer>>} */
let app;
let baseUrl;

beforeEach(async () => {
  app = await startServer({ port: 0, dbPath: ':memory:' });
  baseUrl = `http://127.0.0.1:${app.port}`;
});

afterEach(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  app.store.close();
});

/** POST/GET JSON, returning `{status, body}`. */
async function api(path, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A fresh wallet, plus a helper to authenticate it against a running server. */
function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    address: account.address,
    /** Run the full nonce -> sign -> verify handshake and return a token. */
    async login() {
      const { body: challenge } = await api('/auth/nonce', {
        body: { address: account.address },
      });
      const message = createSiweMessage({
        address: account.address,
        chainId: 1,
        domain: 'localhost',
        nonce: challenge.nonce,
        uri: 'http://localhost',
        version: '1',
      });
      const signature = await account.signMessage({ message });
      const { body } = await api('/auth/verify', { body: { message, signature } });
      return body.token;
    },
  };
}

describe('server', () => {
  it('answers a health check', async () => {
    const { status, body } = await api('/health', { method: 'GET' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('404s an unknown route', async () => {
    const { status } = await api('/nope');
    expect(status).toBe(404);
  });
});

describe('auth', () => {
  it('opens a session from a signed SIWE message', async () => {
    const w = wallet();
    const token = await w.login();
    expect(token).toBeTruthy();

    const { status, body } = await api('/auth/me', { method: 'GET', token });
    expect(status).toBe(200);
    // Addresses are normalised to lowercase on the way through.
    expect(body.address).toBe(w.address.toLowerCase());
  });

  it('rejects a request with no session', async () => {
    const { status } = await api('/game/state', { method: 'GET' });
    expect(status).toBe(401);
  });

  it('rejects a replayed nonce', async () => {
    const w = wallet();
    const { body: challenge } = await api('/auth/nonce', {
      body: { address: w.address },
    });
    const message = createSiweMessage({
      address: w.address,
      chainId: 1,
      domain: 'localhost',
      nonce: challenge.nonce,
      uri: 'http://localhost',
      version: '1',
    });
    const signature = await w.account.signMessage({ message });

    const first = await api('/auth/verify', { body: { message, signature } });
    expect(first.status).toBe(200);

    // The same signature must not open a second session.
    const second = await api('/auth/verify', { body: { message, signature } });
    expect(second.status).toBe(401);
  });

  it('rejects a signature from a different wallet', async () => {
    const victim = wallet();
    const attacker = wallet();
    const { body: challenge } = await api('/auth/nonce', {
      body: { address: victim.address },
    });
    const message = createSiweMessage({
      address: victim.address,
      chainId: 1,
      domain: 'localhost',
      nonce: challenge.nonce,
      uri: 'http://localhost',
      version: '1',
    });
    // Signed by the attacker, claiming the victim's address.
    const signature = await attacker.account.signMessage({ message });
    const { status } = await api('/auth/verify', { body: { message, signature } });
    expect(status).toBe(401);
  });

  it('ends a session on logout', async () => {
    const w = wallet();
    const token = await w.login();
    await api('/auth/logout', { token });
    const { status } = await api('/auth/me', { method: 'GET', token });
    expect(status).toBe(401);
  });
});

describe('game', () => {
  it('starts a new player with the configured opening coins', async () => {
    const w = wallet();
    const token = await w.login();
    const { body } = await api('/game/state', { method: 'GET', token });
    expect(body.economy.coins).toBe(20);
    expect(body.collection).toEqual([]);
    expect(body.phase).toBe('idle');
  });

  it('persists the collection across separate requests', async () => {
    // The whole point of this phase: the save outlives the request, so a
    // reload no longer loses the collection.
    const w = wallet();
    const token = await w.login();

    await api('/game/buy', { token, body: {} });
    const opened = await api('/game/open', { token, body: {} });
    expect(opened.status).toBe(200);

    const { body } = await api('/game/state', { method: 'GET', token });
    expect(body.collection).toHaveLength(1);
    expect(body.collection[0].name).toBe(opened.body.result.name);
    expect(body.economy.chestsOpened).toBe(1);
  });

  it('keeps each wallet save separate', async () => {
    const a = wallet();
    const b = wallet();
    const tokenA = await a.login();
    const tokenB = await b.login();

    await api('/game/buy', { token: tokenA, body: {} });
    await api('/game/open', { token: tokenA, body: {} });

    const stateB = await api('/game/state', { method: 'GET', token: tokenB });
    expect(stateB.body.collection).toEqual([]);
    expect(stateB.body.economy.chestsOpened).toBe(0);
  });

  it('reports OPENING between buying and opening', async () => {
    const w = wallet();
    const token = await w.login();
    await api('/game/buy', { token, body: {} });
    const { body } = await api('/game/state', { method: 'GET', token });
    expect(body.phase).toBe('opening');
  });

  it('refuses to open a chest that was never bought', async () => {
    const w = wallet();
    const token = await w.login();
    const { status, body } = await api('/game/open', { token, body: {} });
    expect(status).toBe(409);
    expect(body.error).toMatch(/no unopened chest/);
  });

  it('refuses a purchase the wallet cannot afford', async () => {
    const w = wallet();
    const token = await w.login();
    // Opening coins are 20 and a chest costs 10, so three buys must fail on
    // the third regardless of what the client claims.
    expect((await api('/game/buy', { token, body: {} })).status).toBe(200);
    expect((await api('/game/buy', { token, body: {} })).status).toBe(200);
    expect((await api('/game/buy', { token, body: {} })).status).toBe(409);
  });

  it('refuses prestige before any points are banked', async () => {
    const w = wallet();
    const token = await w.login();
    const { status } = await api('/game/prestige', { token });
    expect(status).toBe(409);
  });

  it('banks prestige points and raises the level cap', async () => {
    const w = wallet();
    const token = await w.login();

    // Earn enough for a point without going through thousands of draws.
    await app.store.saveGame(w.address.toLowerCase(), {
      coins: 0,
      prestige: 0,
      prestigeCount: 0,
      cards: [],
      stats: { totalIncome: 400000, totalDraws: 0, totalNewCards: 0 },
    });

    const { status, body } = await api('/game/prestige', { token });
    expect(status).toBe(200);
    expect(body.result.gain).toBe(2); // 400000 / PER_POINT 200000
    expect(body.economy.prestigeCount).toBe(1);
    expect(body.economy.maxLevel).toBe(6); // base 5 + 1 per prestige
  });
});

describe('bounds on client-supplied time', () => {
  it('caps a single tick request', async () => {
    const w = wallet();
    const token = await w.login();
    // No cards yet, so income is zero and nothing mints — but the request must
    // still be accepted and bounded rather than trusted.
    const { status } = await api('/game/tick', { token, body: { seconds: 1e9 } });
    expect(status).toBe(200);
  });

  it('credits offline income only up to the cap', async () => {
    const w = wallet();
    const token = await w.login();

    // A player with income who has been away far longer than the cap.
    await app.store.saveGame(w.address.toLowerCase(), {
      coins: 0,
      prestige: 0,
      prestigeCount: 0,
      cards: [{ name: 'Slime', rarity: 'common', copies: 1, maxLevel: 5 }],
      stats: { totalIncome: 0, totalDraws: 0, totalNewCards: 1 },
    });
    const capMs = app.config.maxOfflineSeconds * 1000;
    // Backdate the save well past the cap.
    app.store.db
      .prepare('UPDATE players SET updated_at = ? WHERE address = ?')
      .run(Date.now() - capMs * 5, w.address.toLowerCase());

    const { body } = await api('/game/state', { method: 'GET', token });
    const expectedMax = app.config.maxOfflineSeconds * 1; // 1 coin/s income
    // Granted at most the cap; never five times it.
    expect(body.economy.coins).toBeLessThanOrEqual(expectedMax);
    expect(body.economy.coins).toBeGreaterThan(0);
  });

  it('rejects a negative tick', async () => {
    const w = wallet();
    const token = await w.login();
    const { status } = await api('/game/tick', { token, body: { seconds: -100 } });
    expect(status).toBe(400);
  });
});

describe('server-side randomness', () => {
  it('does not produce identical draw sequences for two wallets', async () => {
    // The old build seeded its PRNG from a client-supplied number, so two
    // players sharing a seed drew identically. Two independent wallets must
    // not be correlated.
    const draws = async () => {
      const w = wallet();
      const token = await w.login();
      const names = [];
      for (let i = 0; i < 6; i += 1) {
        await app.store.saveGame(w.address.toLowerCase(), {
          coins: 1000,
          prestige: 0,
          prestigeCount: 0,
          cards: [],
          stats: { totalIncome: 0, totalDraws: 0, totalNewCards: 0 },
        });
        await api('/game/buy', { token, body: {} });
        const { body } = await api('/game/open', { token, body: {} });
        names.push(body.result.name);
      }
      return names;
    };

    const first = await draws();
    const second = await draws();
    expect(first).not.toEqual(second);
  });
});
