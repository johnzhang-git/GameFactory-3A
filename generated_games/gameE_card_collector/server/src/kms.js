/**
 * AWS KMS wiring for the voucher-signing key.
 *
 * Kept apart from `key-source.js` so that the signature *format* handling —
 * the part that is subtle and needs tests — does not drag in an AWS SDK. A
 * deployment using a raw key installs nothing extra; a deployment using KMS
 * installs the client here.
 *
 * The SDK is imported lazily and by package name, so the module can be loaded
 * (and its errors reported clearly) on a machine that has no AWS SDK at all.
 */

import { createKmsKeySource } from './key-source.js';

/**
 * Load `@aws-sdk/client-kms`, or explain how to install it.
 *
 * A static import would turn "you have not installed the optional dependency"
 * into a module-resolution crash at startup, which reads as a broken build
 * rather than a missing package.
 */
async function loadKmsClient() {
  try {
    return await import('@aws-sdk/client-kms');
  } catch (cause) {
    throw new Error(
      'CHAIN_KEY_PROVIDER=kms needs the AWS SDK: ' +
        'npm install @aws-sdk/client-kms',
      { cause },
    );
  }
}

/**
 * Build a key source backed by a KMS asymmetric key.
 *
 * The key must be `ECC_SECG_P256K1` with usage `SIGN_VERIFY` — that is
 * secp256k1, the curve Ethereum uses. An RSA or Ed25519 key would fail the
 * address check at startup rather than produce bad signatures.
 *
 * @param {{kmsKeyId: string, signerAddress: string, region?: string}} config
 */
export async function createAwsKmsKeySource({
  kmsKeyId,
  signerAddress,
  region,
}) {
  if (!kmsKeyId) throw new Error('CHAIN_KMS_KEY_ID is required for the kms provider');
  if (!signerAddress) {
    // Not optional: KMS will not tell us the address, and without it the
    // recovery id cannot be determined.
    throw new Error('CHAIN_SIGNER_ADDRESS is required for the kms provider');
  }

  const { KMSClient, SignCommand } = await loadKmsClient();
  const client = new KMSClient(region ? { region } : {});

  return createKmsKeySource({
    signerAddress,
    kind: 'kms',
    /**
     * Ask KMS to sign the digest.
     *
     * `MessageType: 'DIGEST'` is what makes this EIP-712-compatible: the
     * default would have KMS hash the input again, producing a signature over
     * `keccak(digest)` that recovers to a different address.
     *
     * `SigningAlgorithm` must be `ECDSA_SHA_256` even for a digest — with
     * `MessageType: 'DIGEST'` KMS signs the bytes as given and the algorithm
     * name only selects the curve and the DER output format.
     */
    sign: async (digestBytes) => {
      const result = await client.send(
        new SignCommand({
          KeyId: kmsKeyId,
          Message: digestBytes,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );
      if (!result.Signature) {
        throw new Error('KMS returned no signature');
      }
      return result.Signature;
    },
  });
}

/**
 * Choose a key source from configuration.
 *
 * @param {{keyProvider?: string, signerKey?: string, kmsKeyId?: string,
 *          signerAddress?: string, awsRegion?: string}} config
 * @returns {Promise<{signDigest: Function, address: string, kind: string}|null>}
 */
export async function createKeySource(config) {
  const provider = config.keyProvider ?? 'env';

  if (provider === 'kms') {
    return createAwsKmsKeySource({
      kmsKeyId: config.kmsKeyId,
      signerAddress: config.signerAddress,
      region: config.awsRegion,
    });
  }

  if (provider !== 'env') {
    throw new Error(
      `unknown CHAIN_KEY_PROVIDER '${provider}' (expected 'env' or 'kms')`,
    );
  }

  // The env path is built in `voucher.js`, which already imports it; falling
  // through to null here keeps one construction site for each provider.
  return null;
}
