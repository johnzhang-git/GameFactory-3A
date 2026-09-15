/**
 * HTTP surface.
 *
 * Deliberately tiny: a stray JSON body, a bearer token, and a handler per
 * verb. There is no routing framework because there are eight routes, and no
 * ORM because there are three tables.
 */

import { HttpError } from './errors.js';

/** Read and parse a JSON request body, with a size ceiling. */
export async function readJson(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
}

/** A route table: [method, path, handler(ctx) -> body]. */
export function createRoutes({ auth, game }) {
  return [
    ['GET', '/health', () => ({ ok: true })],

    // --- auth -------------------------------------------------------------

    // Hand out a nonce for the client to embed in a SIWE message.
    ['POST', '/auth/nonce', async ({ body }) => ({
      nonce: auth.nonce(body.address),
    })],

    // Verify the signed message and open a session.
    ['POST', '/auth/verify', async ({ body }) => auth.verify(body)],

    ['POST', '/auth/logout', async ({ req }) => {
      auth.logout(req);
      return { ok: true };
    }],

    [
      'GET',
      '/auth/me',
      async ({ req }) => ({ address: auth.requireAddress(req) }),
    ],

    // --- game -------------------------------------------------------------

    // The save, with any offline income already credited.
    ['GET', '/game/state', async ({ req }) => game.state(auth.requireAddress(req))],

    ['POST', '/game/buy', async ({ req, body }) =>
      body.gold
        ? game.buyGoldChest(auth.requireAddress(req))
        : game.buyChest(auth.requireAddress(req))],

    ['POST', '/game/open', async ({ req, body }) =>
      game.openChest(auth.requireAddress(req), { gold: Boolean(body.gold) })],

    ['POST', '/game/prestige', async ({ req }) =>
      game.prestige(auth.requireAddress(req))],

    ['POST', '/game/tick', async ({ req, body }) =>
      game.tick(auth.requireAddress(req), body.seconds)],
  ];
}

/** Match a request against the table, returning its handler or null. */
export function matchRoute(routes, method, pathname) {
  for (const [routeMethod, routePath, handler] of routes) {
    if (routeMethod === method && routePath === pathname) return handler;
  }
  return null;
}
