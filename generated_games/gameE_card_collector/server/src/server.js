/**
 * HTTP plumbing: build the object graph, dispatch requests, render errors.
 *
 * Kept separate from `index.js` so tests can boot a server on an ephemeral
 * port against an in-memory database without touching the filesystem or
 * `process.argv`.
 */

import { createServer } from 'node:http';
import { Auth } from './auth.js';
import { loadConfig } from './config.js';
import { HttpError } from './errors.js';
import { GameService } from './game-service.js';
import { createRoutes, matchRoute, readJson } from './routes.js';
import { Store } from './store.js';

/**
 * Wire up a server without listening.
 *
 * @param {Partial<ReturnType<typeof loadConfig>>} [overrides]
 */
export function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = new Store(config.dbPath);
  const auth = new Auth(store, config);
  const game = new GameService(store, config);
  const routes = createRoutes({ auth, game });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const handler = matchRoute(routes, req.method ?? 'GET', url.pathname);

    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!handler) {
      send(res, 404, { error: 'no such route' });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await handler({ req, res, body, url });
      send(res, 200, result);
    } catch (error) {
      // An HttpError is a deliberate refusal; anything else is a bug and is
      // reported as one rather than dressed up as a client mistake.
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('[server] unhandled error', error);
        send(res, 500, { error: 'internal error' });
      }
    }
  });

  return { server, config, store, auth, game };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Start listening. Resolves once the port is bound, with the actual port
 * (useful when `port: 0` asks the OS to choose one).
 *
 * @param {Partial<ReturnType<typeof loadConfig>>} [overrides]
 */
export function startServer(overrides = {}) {
  const app = createApp(overrides);
  return new Promise((resolve) => {
    app.server.listen(app.config.port, app.config.host, () => {
      const address = app.server.address();
      resolve({ ...app, port: typeof address === 'object' ? address.port : null });
    });
  });
}
