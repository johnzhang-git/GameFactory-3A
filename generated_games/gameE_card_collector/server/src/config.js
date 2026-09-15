/**
 * Server configuration. Every field is overridable by environment variable so
 * deploying needs no code change.
 *
 * Defaults are chosen to run with zero setup: a SQLite file beside the code, a
 * loopback bind, and a per-boot session secret.
 */

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    /** `:memory:` is honoured, which is what the tests use. */
    dbPath: env.DB_PATH ?? join(here, '..', 'data.sqlite'),
    /**
     * A fresh secret each boot drops every existing session. That is the safe
     * default: an operator who wants sessions to outlive a restart has to set
     * SESSION_SECRET deliberately.
     */
    sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    /**
     * The longest stretch of idle income one request may credit.
     *
     * Uncapped, a save left untouched for a year would mint a year of coins
     * the moment its owner returned. Capping keeps offline progress generous
     * but bounded — and it is also what stops a client from fabricating a
     * huge `since` timestamp to mint arbitrarily.
     */
    maxOfflineSeconds: Number(env.MAX_OFFLINE_SECONDS ?? 8 * 3600),
    /** Allowed origin for the game front-end. Loosen only for development. */
    corsOrigin: env.CORS_ORIGIN ?? '*',
  };
}
