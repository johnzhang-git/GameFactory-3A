/**
 * Key-source tests.
 *
 * The KMS path is where a carefully tested local setup turns into a broken
 * deployment, and the reasons are all format-level rather than logic-level:
 *
 *   - KMS returns DER, Ethereum wants raw r||s||v;
 *   - KMS may return a high `s`, which EIP-2 and OpenZeppelin reject outright;
 *   - KMS returns no recovery id.
 *
 * A test that stubs KMS with viem's own signer would prove none of this,
 * because viem already emits low-`s` raw signatures with a `v`. So the
 * high-`s` case below is built by hand from a real key.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex, hashTypedData, recoverAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  CURVE_ORDER,
  createEnvKeySource,
  createKmsKeySource,
  derToEthereumSignature,
  parseDerSignature,
  verifyKeySource,
} from '../src/key-source.js';

const DIGEST = bytesToHex(new Uint8Array(32).fill(9));

/** Minimal DER encoding of a positive INTEGER. */
function derInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = [...Buffer.from(hex, 'hex')];
  // DER integers are signed: pad when the top bit is set.
  if (bytes[0] & 0x80) bytes = [0x00, ...bytes];
  return [0x02, bytes.length, ...bytes];
}

/** Wrap two integers in a DER SEQUENCE. */
function derSequence(r, s) {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe('parseDerSignature', () => {
  it('reads a short-form sequence', () => {
    const der = derSequence(0x1234n, 0x5678n);
    expect(parseDerSignature(der)).toEqual({ r: 0x1234n, s: 0x5678n });
  });

  it('strips the sign padding DER adds for high-bit values', () => {
    // A 32-byte `r` with its top bit set is encoded with a leading 0x00; not
    // stripping it would produce a 33-byte component and a wrong signature.
    const big = BigInt(`0x${'ff'.repeat(32)}`) % CURVE_ORDER;
    const der = derSequence(big, 1n);
    expect(parseDerSignature(der).r).toBe(big);
  });

  it('handles a long-form length', () => {
    // Length >= 0x80 uses a continuation byte. KMS output is short in
    // practice, but silently mis-parsing it would yield a wrong signature
    // rather than an error.
    const body = [...derInteger(1n), ...derInteger(2n)];
    const der = Uint8Array.from([0x30, 0x81, body.length, ...body]);
    expect(parseDerSignature(der)).toEqual({ r: 1n, s: 2n });
  });

  it('rejects a non-sequence', () => {
    expect(() => parseDerSignature(Uint8Array.from([0x31, 0x02, 0x01, 0x01])))
      .toThrow(/SEQUENCE/);
  });

  it('rejects a sequence whose length exceeds the input', () => {
    // The declared length (0x10) runs past the four bytes supplied.
    expect(() => parseDerSignature(Uint8Array.from([0x30, 0x10, 0x02, 0x01])))
      .toThrow(/exceeds input/i);
  });

  it('rejects a truncated INTEGER', () => {
    // Length says 5 bytes of integer; only 1 follows.
    expect(() =>
      parseDerSignature(Uint8Array.from([0x30, 0x03, 0x02, 0x05, 0x01])),
    ).toThrow(/truncated/i);
  });

  it('rejects a zero component', () => {
    // r = 0 is not a valid signature and must not be silently accepted.
    expect(() => parseDerSignature(derSequence(0n, 1n))).toThrow(/zero/);
  });
});

describe('derToEthereumSignature', () => {
  let account;
  let digest;

  beforeEach(() => {
    account = privateKeyToAccount(generatePrivateKey());
    digest = hashTypedData({
      domain: { name: 'T', version: '1', chainId: 1, verifyingContract: `0x${'11'.repeat(20)}` },
      types: { V: [{ name: 'x', type: 'uint256' }] },
      primaryType: 'V',
      message: { x: 1n },
    });
  });

  /** Produce a raw (r, s, v) signature we can re-encode as DER. */
  async function rawSignature() {
    const hex = await account.sign({ hash: digest });
    return {
      r: BigInt(`0x${hex.slice(2, 66)}`),
      s: BigInt(`0x${hex.slice(66, 130)}`),
      v: Number.parseInt(hex.slice(130, 132), 16),
    };
  }

  it('normalises a high-s signature that the contract would reject', async () => {
    // This is the case that breaks in production and not in development.
    // OpenZeppelin's ECDSA.recover rejects `s > n/2` (EIP-2), while viem's own
    // signer always emits `s <= n/2`. So a raw-key setup never sees it, and a
    // KMS — which does not normalise — produces it constantly.
    const { r, s } = await rawSignature();
    const flipped = CURVE_ORDER - s; // the malleable counterpart
    expect(flipped).toBeGreaterThan(CURVE_ORDER / 2n);

    const signature = await derToEthereumSignature(derSequence(r, flipped), {
      digest,
      expectedAddress: account.address,
    });

    const producedS = BigInt(`0x${signature.slice(66, 130)}`);
    expect(producedS).toBeLessThanOrEqual(CURVE_ORDER / 2n);
    // And it must still recover to the right signer: normalising `s` flips
    // the recovery id, so getting this wrong yields a valid-looking signature
    // for a different address.
    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
  });

  it('recovers the right address for an ordinary signature', async () => {
    const { r, s } = await rawSignature();
    const signature = await derToEthereumSignature(derSequence(r, s), {
      digest,
      expectedAddress: account.address,
    });
    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
  });

  it('fails loudly when the key is not the expected one', async () => {
    // Better to fail at startup than to sign vouchers every deployment
    // rejects. The message must name both addresses so the fix is obvious.
    const other = privateKeyToAccount(generatePrivateKey());
    const { r, s } = await rawSignature();
    await expect(
      derToEthereumSignature(derSequence(r, s), {
        digest,
        expectedAddress: other.address,
      }),
    ).rejects.toThrow(/does not recover/);
  });

  it('produces a 65-byte signature', async () => {
    const { r, s } = await rawSignature();
    const signature = await derToEthereumSignature(derSequence(r, s), {
      digest,
      expectedAddress: account.address,
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe('createKmsKeySource', () => {
  let account;
  let digest;

  beforeEach(() => {
    account = privateKeyToAccount(generatePrivateKey());
    digest = bytesToHex(new Uint8Array(32).fill(3));
  });

  /** A KMS stub that returns DER, as the real service does. */
  async function kmsReturning(der) {
    return createKmsKeySource({
      signerAddress: account.address,
      sign: async () => der,
    });
  }

  it('converts a KMS DER response into an Ethereum signature', async () => {
    const hex = await account.sign({ hash: digest });
    const r = BigInt(`0x${hex.slice(2, 66)}`);
    const s = BigInt(`0x${hex.slice(66, 130)}`);

    const source = await kmsReturning(derSequence(r, s));
    const signature = await source.signDigest(digest);
    expect(await recoverAddress({ hash: digest, signature })).toBe(account.address);
  });

  it('requires an address, because KMS cannot report one', async () => {
    // Without it the recovery id cannot be determined at all.
    expect(() =>
      createKmsKeySource({ signerAddress: undefined, sign: async () => new Uint8Array() }),
    ).toThrow(/signerAddress/);
  });

  it('reports its kind, so startup logs can say where the key came from', async () => {
    const source = await kmsReturning(new Uint8Array());
    expect(source.kind).toBe('kms');
  });

  it('surfaces a KMS failure rather than signing something wrong', async () => {
    const source = createKmsKeySource({
      signerAddress: account.address,
      sign: async () => {
        throw new Error('AccessDeniedException: not authorized to kms:Sign');
      },
    });
    await expect(source.signDigest(digest)).rejects.toThrow(/AccessDenied/);
  });
});

describe('createEnvKeySource', () => {
  it('signs a digest that recovers to its own address', async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const source = createEnvKeySource(key);

    expect(source.address).toBe(account.address);
    const signature = await source.signDigest(DIGEST);
    expect(await recoverAddress({ hash: DIGEST, signature })).toBe(account.address);
  });

  it('emits a low-s signature, matching what the contract accepts', async () => {
    const source = createEnvKeySource(generatePrivateKey());
    const signature = await source.signDigest(DIGEST);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    expect(s).toBeLessThanOrEqual(CURVE_ORDER / 2n);
  });
});

describe('verifyKeySource', () => {
  it('accepts a source that signs as its own address', async () => {
    const source = createEnvKeySource(generatePrivateKey());
    await expect(verifyKeySource(source)).resolves.toBe(true);
  });

  it('rejects a source whose signature recovers elsewhere', async () => {
    // The misconfiguration this exists to catch: a key id pointing at the
    // wrong key, which otherwise shows up as "every claim reverts".
    const key = generatePrivateKey();
    const real = privateKeyToAccount(key);
    const impostor = privateKeyToAccount(generatePrivateKey());

    const source = {
      address: real.address, // claims to be `real`
      kind: 'kms',
      signDigest: async (digest) => impostor.sign({ hash: digest }),
    };

    await expect(verifyKeySource(source)).rejects.toThrow(/signed as/);
  });
});
