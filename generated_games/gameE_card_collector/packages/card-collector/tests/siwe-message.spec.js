/**
 * The SIWE statement is composed by hand in `wallet.js` to avoid bundling a
 * signing SDK into the browser build. That trade only holds if the text really
 * is a valid EIP-4361 statement — so these tests parse it with `viem`, the
 * same library the server verifies with.
 *
 * A field-order or blank-line mistake here would show up as "invalid SIWE
 * statement" at login time, which is a slow and confusing way to find it.
 */

import { describe, expect, it } from 'vitest';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { createSiweMessage } from '../src/wallet.js';

const ADDRESS = '0x1234567890AbcdEF1234567890aBcdef12345678';
const NONCE = 'a1b2c3d4e5f60718';

const base = {
  address: ADDRESS,
  nonce: NONCE,
  domain: 'localhost:5199',
  uri: 'http://localhost:5199',
  chainId: 1,
  issuedAt: new Date('2026-09-15T04:05:06.000Z'),
};

describe('SIWE message', () => {
  it('parses into every field the server checks', () => {
    const parsed = parseSiweMessage(createSiweMessage(base));
    expect(parsed.address).toBe(ADDRESS);
    expect(parsed.nonce).toBe(NONCE);
    expect(parsed.domain).toBe('localhost:5199');
    expect(parsed.uri).toBe('http://localhost:5199');
    expect(parsed.chainId).toBe(1);
    expect(parsed.version).toBe('1');
    // Parsed into a Date, so compare instants rather than the raw string.
    expect(parsed.issuedAt).toEqual(new Date('2026-09-15T04:05:06.000Z'));
  });

  it('passes the server-side validator', () => {
    // Exactly the check `server/src/auth.js` performs, minus the signature.
    const message = createSiweMessage(base);
    expect(
      validateSiweMessage({
        address: ADDRESS,
        message: parseSiweMessage(message),
        nonce: NONCE,
        time: new Date('2026-09-15T04:05:07.000Z'),
      }),
    ).toBe(true);
  });

  it('uses the address verbatim, preserving checksum case', () => {
    // EIP-4361 wants the checksummed form; lowercasing it would still parse
    // but would no longer be the canonical statement.
    const message = createSiweMessage(base);
    expect(message).toContain(ADDRESS);
    expect(message).not.toContain(ADDRESS.toLowerCase());
  });

  it('matches the exact EIP-4361 field order', () => {
    // The spec fixes both order and blank lines; the server parses this text.
    const lines = createSiweMessage(base).split('\n');
    expect(lines[0]).toBe(
      'localhost:5199 wants you to sign in with your Ethereum account:',
    );
    expect(lines[1]).toBe(ADDRESS);
    expect(lines[2]).toBe('');
    expect(lines[3]).toMatch(/^Sign in to the card collector/);
    expect(lines[4]).toBe('');
    expect(lines[5]).toBe('URI: http://localhost:5199');
    expect(lines[6]).toBe('Version: 1');
    expect(lines[7]).toBe('Chain ID: 1');
    expect(lines[8]).toBe(`Nonce: ${NONCE}`);
    expect(lines[9]).toBe('Issued At: 2026-09-15T04:05:06.000Z');
  });

  it('carries the nonce the server issued', () => {
    // The nonce is what binds the signature to this login attempt and makes
    // a captured signature unusable a second time.
    const parsed = parseSiweMessage(
      createSiweMessage({ ...base, nonce: 'deadbeefdeadbeef' }),
    );
    expect(parsed.nonce).toBe('deadbeefdeadbeef');
  });
});
