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

    // --- on-chain claiming (phase 2) --------------------------------------
    // All three must be set before the server will issue vouchers; until then
    // /game/claim answers 503 and the rest of the game is unaffected.

    /** Chain the card contract is deployed to. */
    chainId: env.CHAIN_ID ? Number(env.CHAIN_ID) : null,
    /** Deployed `CardCollector` address. */
    contractAddress: env.CHAIN_CONTRACT_ADDRESS ?? null,
    /**
     * A raw private key, used only when no KMS is configured.
     *
     * Fine for local development — it can only sign vouchers, holds no funds,
     * and cannot move any — but wrong for anything holding real value: it is
     * the one secret whose leak authorises unlimited minting, and it would sit
     * in an environment variable, a process listing and possibly an image.
     * Set `keyProvider: 'kms'` in production instead.
     */
    signerKey: env.CHAIN_SIGNER_KEY ?? null,
    /**
     * Where the signing key lives: 'env' (default) or 'kms'.
     *
     * Defaulting to 'env' keeps local setup to one variable; a deployment
     * opts into a KMS explicitly rather than having it silently unavailable.
     */
    keyProvider: env.CHAIN_KEY_PROVIDER ?? 'env',
    /** The KMS key id or ARN, when `keyProvider` is 'kms'. */
    kmsKeyId: env.CHAIN_KMS_KEY_ID ?? null,
    /** AWS region for the KMS client. */
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null,
    /**
     * The address the signing key must correspond to.
     *
     * Required for KMS: AWS returns no address for an asymmetric key, and the
     * recovery id has to be checked against a known address. Declaring it also
     * catches a key id that points at the wrong key before any voucher is
     * issued.
     */
    signerAddress: env.CHAIN_SIGNER_ADDRESS ?? null,
    /**
     * Refuse to start if the key does not match `signerAddress`.
     *
     * On by default: a mismatch means every claim reverts on chain, and
     * finding that out at startup beats finding it out from players.
     */
    verifyKeyOnBoot: env.CHAIN_VERIFY_KEY !== 'false',
    /** How long an issued voucher stays redeemable. */
    voucherTtlSeconds: Number(env.VOUCHER_TTL_SECONDS ?? 3600),
  };
}
