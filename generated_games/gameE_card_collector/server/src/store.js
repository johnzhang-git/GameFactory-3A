/**
 * Persistence: one SQLite file, three tables.
 *
 * A wallet address *is* the account. There is no password, no email, no
 * profile: signing a login message proves control of the address, and that is
 * the entire identity model. Everything else is game state keyed by address.
 *
 * The game had no persistence at all before this — it held its collection in
 * memory and lost it on reload — so this file is the part that makes "the
 * player owns these cards" meaningful in the first place.
 */

import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * Session tokens are stored hashed, so a database leak does not hand an
 * attacker a set of live credentials.
 */
const hashToken = (token) =>
  createHash('sha256').update(token).digest('hex');

const normalize = (address) => String(address ?? '').toLowerCase();

export class Store {
  /** @param {string} [dbPath] `:memory:` is what the tests use. */
  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        address    TEXT PRIMARY KEY,
        save       TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        address    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nonces (
        nonce      TEXT PRIMARY KEY,
        address    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_address ON sessions (address);
    `);
  }

  // --- login nonces -------------------------------------------------------

  /**
   * Issue a single-use login nonce for an address.
   *
   * @param {string} address
   * @param {number} [ttlMs]
   * @param {number} [now]
   */
  issueNonce(address, ttlMs = 5 * 60 * 1000, now = Date.now()) {
    const nonce = randomBytes(16).toString('hex');
    this.db
      .prepare(
        'INSERT INTO nonces (nonce, address, expires_at) VALUES (?, ?, ?)',
      )
      .run(nonce, normalize(address), now + ttlMs);
    return nonce;
  }

  /**
   * Redeem a nonce, returning the address it was issued to or null.
   *
   * Single-use: the row is deleted before the expiry check, so a captured
   * signature cannot be replayed even once.
   */
  consumeNonce(nonce, now = Date.now()) {
    const row = this.db
      .prepare('SELECT address, expires_at FROM nonces WHERE nonce = ?')
      .get(nonce);
    if (!row) return null;
    this.db.prepare('DELETE FROM nonces WHERE nonce = ?').run(nonce);
    if (row.expires_at < now) return null;
    return row.address;
  }

  // --- sessions -----------------------------------------------------------

  /**
   * Create a session and return its bearer token (the only time the raw token
   * exists server-side; only its hash is kept).
   */
  createSession(address, ttlMs, now = Date.now()) {
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, address, expires_at) VALUES (?, ?, ?)',
      )
      .run(hashToken(token), normalize(address), now + ttlMs);
    return token;
  }

  /** Resolve a bearer token to an address, or null when unknown or expired. */
  sessionAddress(token, now = Date.now()) {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT address, expires_at FROM sessions WHERE token_hash = ?')
      .get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < now) {
      this.db
        .prepare('DELETE FROM sessions WHERE token_hash = ?')
        .run(hashToken(token));
      return null;
    }
    return row.address;
  }

  /** Revoke a session. */
  deleteSession(token) {
    this.db
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(hashToken(token));
  }

  // --- saves --------------------------------------------------------------

  /** The stored save for an address, or null if they have never played. */
  loadSave(address) {
    const row = this.db
      .prepare('SELECT save FROM players WHERE address = ?')
      .get(normalize(address));
    if (!row?.save) return null;
    return JSON.parse(row.save);
  }

  /** When the save was last written, or null. */
  saveUpdatedAt(address) {
    const row = this.db
      .prepare('SELECT updated_at FROM players WHERE address = ?')
      .get(normalize(address));
    return row?.updated_at ?? null;
  }

  /** Write a save, creating the player row on first contact. */
  saveGame(address, save, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO players (address, save, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           save = excluded.save,
           updated_at = excluded.updated_at`,
      )
      .run(normalize(address), JSON.stringify(save), now, now);
  }

  /** Drop expired nonces and sessions. Call periodically, not per request. */
  pruneExpired(now = Date.now()) {
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  close() {
    this.db.close();
  }
}
