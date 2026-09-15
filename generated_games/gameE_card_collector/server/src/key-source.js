/**
 * Where the voucher-signing key lives.
 *
 * This is the one secret whose compromise is unbounded: it can authorise a
 * mint of any card to any address, forever. An environment variable is fine
 * for local development and wrong for anything holding real value, so the key
 * is behind an interface with two implementations — a raw key for dev, and a
 * KMS for deployment — and swapping them is a config change.
 *
 * ## Why this file exists rather than a one-line KMS call
 *
 * Managed KMS ECDSA has two traps, and both make **every** voucher fail on
 * chain while local tests still pass:
 *
 * 1. **KMS returns DER, Ethereum wants raw `r||s||v`.** DER is a nested
 *    TLV encoding with variable-length integers, so it cannot be sliced.
 *
 * 2. **KMS does not normalise `s` to the lower half of the curve order.**
 *    OpenZeppelin's `ECDSA.recover` rejects high-`s` outright (`EIP-2`, and
 *    the check is at ECDSA.sol:185). viem's own signer normalises silently,
 *    which is exactly why this bites: sign with a raw key locally and it
 *    works; sign with a KMS in production and every claim reverts.
 *
 * 3. **KMS does not return the recovery id.** Ethereum signatures carry a
 *    `v` byte that KMS has no concept of, so it has to be recovered by trying
 *    both candidates against the known signer address.
 *
 * All three are handled here, and tested against a real key — see
 * `tests/key-source.spec.js` for the high-`s` case in particular.
 */

import { bytesToHex, concat, hexToBytes, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** The secp256k1 group order. */
const CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Half the group order; an `s` above this is rejected by EIP-2. */
const HALF_CURVE_ORDER = CURVE_ORDER >> 1n;

/**
 * Trusted setup: a raw private key from the environment.
 *
 * Only appropriate for development. It exists so the rest of the system does
 * not have to care which key source is in use.
 *
 * @param {string} privateKey
 */
export function createEnvKeySource(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return {
    kind: 'env',
    address: account.address,
    /**
     * @param {`0x${string}`} digest the 32-byte EIP-712 digest
     * @returns {Promise<`0x${string}`>} a 65-byte signature
     */
    async signDigest(digest) {
      // viem signs a digest directly and normalises `s` itself.
      return account.sign({ hash: digest });
    },
  };
}

/**
 * Read a DER-encoded length, advancing `offset`.
 *
 * Supports both the short form (a single byte under 0x80) and the long form
 * (a byte with the high bit set, followed by that many length bytes). KMS
 * output is short in practice, but a parser that silently mis-reads a long
 * form would produce a wrong signature rather than an error.
 *
 * @param {Uint8Array} der
 * @param {{offset: number}} cursor
 */
function readDerLength(der, cursor) {
  const first = der[cursor.offset];
  cursor.offset += 1;
  if (first === undefined) throw new Error('DER: truncated length');

  if (first < 0x80) return first;

  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 4) {
    throw new Error(`DER: unsupported length encoding (${byteCount} bytes)`);
  }
  let length = 0;
  for (let i = 0; i < byteCount; i += 1) {
    length = (length << 8) | der[cursor.offset];
    cursor.offset += 1;
  }
  return length;
}

/**
 * Read one DER INTEGER as a big-endian unsigned value.
 *
 * DER encodes integers as signed, so a value whose top bit is set is padded
 * with a leading zero byte. Stripping that padding is what makes an `r` of
 * exactly 32 bytes come out as 32 bytes rather than 33.
 *
 * @param {Uint8Array} der
 * @param {{offset: number}} cursor
 */
function readDerInteger(der, cursor) {
  if (der[cursor.offset] !== 0x02) {
    throw new Error('DER: expected an INTEGER');
  }
  cursor.offset += 1;
  const length = readDerLength(der, cursor);
  const start = cursor.offset;
  const end = start + length;
  if (end > der.length) throw new Error('DER: truncated INTEGER');

  let bytes = der.subarray(start, end);
  cursor.offset = end;

  // Drop the sign-padding DER adds for values with the high bit set.
  while (bytes.length > 1 && bytes[0] === 0x00) {
    bytes = bytes.subarray(1);
  }
  if (bytes.length > 32) {
    throw new Error('DER: INTEGER longer than 32 bytes');
  }

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Convert an ECDSA DER signature into the 65-byte Ethereum form.
 *
 * @param {Uint8Array} der
 * @returns {{r: bigint, s: bigint}}
 */
export function parseDerSignature(der) {
  if (der[0] !== 0x30) throw new Error('DER: expected a SEQUENCE');

  const cursor = { offset: 1 };
  const sequenceLength = readDerLength(der, cursor);
  if (cursor.offset + sequenceLength > der.length) {
    throw new Error('DER: sequence length exceeds input');
  }

  const r = readDerInteger(der, cursor);
  const s = readDerInteger(der, cursor);

  if (r <= 0n || s <= 0n) throw new Error('DER: zero component');
  if (r >= CURVE_ORDER || s >= CURVE_ORDER) {
    throw new Error('DER: component out of range');
  }
  return { r, s };
}

/** Left-pad a value to the 32 bytes a signature component always occupies. */
const to32 = (value) => value.toString(16).padStart(64, '0');

/**
 * Turn a DER signature from a KMS into an Ethereum signature.
 *
 * Applies both corrections the KMS does not: normalising `s` to the lower
 * half of the curve order, and finding the recovery id by trial.
 *
 * The recovery id is brute-forced rather than computed because the alternative
 * — deriving it from the curve arithmetic — needs the ephemeral point `R`,
 * which a KMS deliberately does not return. Two candidates is cheap and, more
 * importantly, self-checking: if neither matches the expected address, the key
 * is not the one we think it is, and that is worth failing loudly for.
 *
 * @param {Uint8Array} der
 * @param {{digest: `0x${string}`, expectedAddress: string}} params
 * @returns {`0x${string}`} a 65-byte signature: r || s || v
 */
export async function derToEthereumSignature(der, { digest, expectedAddress }) {
  const { r, s: rawS } = parseDerSignature(der);
  let s = rawS;

  // EIP-2: OpenZeppelin rejects a high `s`, so a KMS that returns one would
  // produce signatures that revert on every submission.
  if (s > HALF_CURVE_ORDER) s = CURVE_ORDER - s;

  const rHex = to32(r);
  const sHex = to32(s);
  const wanted = expectedAddress.toLowerCase();

  for (const v of [27, 28]) {
    const signature = `0x${rHex}${sHex}${v.toString(16)}`;
    let recovered;
    try {
      // viem's `recoverAddress` is async, so this cannot be a plain loop over
      // synchronous calls.
      recovered = await recoverAddress({ hash: digest, signature });
    } catch {
      // A candidate that cannot be recovered is simply not the right one.
      continue;
    }
    if (recovered.toLowerCase() === wanted) return signature;
  }

  throw new Error(
    `signature does not recover to ${expectedAddress} — ` +
      'the KMS key does not match CHAIN_SIGNER_ADDRESS',
  );
}

/**
 * A key held by a managed KMS.
 *
 * `sign` is injected rather than the AWS SDK being imported here, so the
 * dependency stays optional: a deployment using a raw key installs nothing
 * extra, and tests pass a stub instead of needing credentials.
 *
 * `signerAddress` is required, and is not merely informational. It is what
 * the recovery id is checked against, so a key that does not match it fails
 * here — at startup — rather than producing vouchers that every deployment
 * silently rejects.
 *
 * @param {{signerAddress: string, sign: (digest: Uint8Array) => Promise<Uint8Array>,
 *          kind?: string}} params
 */
export function createKmsKeySource({ signerAddress, sign, kind = 'kms' }) {
  if (!signerAddress) throw new Error('signerAddress is required for a KMS key');
  if (typeof sign !== 'function') throw new Error('sign must be a function');

  return {
    kind,
    address: signerAddress,
    async signDigest(digest) {
      const der = await sign(hexToBytes(digest));
      return derToEthereumSignature(der, {
        digest,
        expectedAddress: signerAddress,
      });
    },
  };
}

/**
 * Prove a key source works before the server starts serving.
 *
 * Signs a fixed digest and recovers the address from it. This catches the
 * whole class of misconfiguration that would otherwise only show up as
 * "every claim reverts": a key that does not match the configured address, a
 * KMS key id pointing at the wrong key, a missing `kms:Sign` permission.
 *
 * @param {{signDigest: Function, address: string}} keySource
 */
export async function verifyKeySource(keySource) {
  const digest = bytesToHex(new Uint8Array(32).fill(7));
  const signature = await keySource.signDigest(digest);
  const recovered = await recoverAddress({ hash: digest, signature });
  if (recovered.toLowerCase() !== keySource.address.toLowerCase()) {
    throw new Error(
      `key source signed as ${recovered} but reports ${keySource.address}`,
    );
  }
  return true;
}

export { CURVE_ORDER, HALF_CURVE_ORDER };
