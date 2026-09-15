/**
 * Entry point: start the server, print where it is, and shut down cleanly.
 *
 * All behaviour lives in `server.js`; this file only owns the process.
 */

import { startServer } from './server.js';

const { server, config, port, store } = await startServer();

console.log(`card-collector server listening on http://${config.host}:${port}`);
console.log(`  database: ${config.dbPath}`);
console.log(`  offline income cap: ${config.maxOfflineSeconds}s`);

// Drop expired nonces and sessions hourly. Cheap, and the alternative is a
// table that only ever grows.
const prune = setInterval(() => store.pruneExpired(), 3600 * 1000);
prune.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
