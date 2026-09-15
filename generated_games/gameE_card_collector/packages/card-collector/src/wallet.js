/**
 * Browser wallet connection and Sign-In with Ethereum.
 *
 * Talks to the injected provider (`window.ethereum`) directly rather than
 * bundling a wallet library: connecting and signing are two RPC calls, and a
 * game front-end should not ship an SDK's worth of ABI plumbing to make them.
 *
 * The SIWE message is composed here rather than via a helper, for the same
 * reason. `siwe-message.spec.js` parses the result with the same library the
 * server verifies with, so the format is checked rather than assumed.
 */

/** Raised when the player has no wallet, or declines something. */
export class WalletError extends Error {
  /**
   * @param {string} message
   * @param {number} [code] the provider's EIP-1193 code, when it has one
   */
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** EIP-1193: the user rejected the request. */
const USER_REJECTED = 4001;

/** True when an injected wallet is present. */
export function hasWallet(provider = globalThis.ethereum) {
  return Boolean(provider?.request);
}

/** Resolve the injected provider, or throw a message worth showing. */
function requireProvider() {
  if (!hasWallet()) {
    throw new WalletError(
      'No wallet found. Install a browser wallet such as MetaMask.',
    );
  }
  return globalThis.ethereum;
}

/**
 * Turn a provider failure into a `WalletError`.
 *
 * A declined prompt is a normal thing a player does, not a crash, so it gets
 * its own phrasing.
 *
 * @param {any} cause
 */
function toWalletError(cause) {
  if (cause?.code === USER_REJECTED) {
    return new WalletError('Request declined in your wallet.', cause.code);
  }
  return new WalletError(cause?.message ?? 'Wallet request failed', cause?.code);
}

/**
 * Ask the wallet for an account, requesting access if needed.
 *
 * @returns {Promise<string>} the chosen address
 */
export async function connectWallet() {
  const provider = requireProvider();
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) {
      throw new WalletError('No account was shared by the wallet.');
    }
    return accounts[0];
  } catch (cause) {
    if (cause instanceof WalletError) throw cause;
    throw toWalletError(cause);
  }
}

/** The chain id the wallet is currently on, as a number. */
async function currentChainId(provider) {
  const hex = await provider.request({ method: 'eth_chainId' });
  return Number.parseInt(hex, 16);
}

/**
 * Compose an EIP-4361 statement.
 *
 * Field order and spacing are fixed by the spec — the server parses this
 * text, so a stray blank line is a login failure, not a cosmetic change.
 *
 * @param {{address: string, nonce: string, domain: string, uri: string,
 *          chainId: number, issuedAt?: Date, statement?: string}} params
 */
export function createSiweMessage({
  address,
  nonce,
  domain,
  uri,
  chainId,
  issuedAt = new Date(),
  statement = 'Sign in to the card collector. This proves you own this address.',
}) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join('\n');
}

/**
 * Sign a login statement, proving control of the connected address.
 *
 * @param {{address: string, nonce: string, domain?: string, uri?: string}} params
 * @returns {Promise<{message: string, signature: string}>}
 */
export async function signIn({ address, nonce, domain, uri }) {
  const provider = requireProvider();
  const origin =
    domain ?? globalThis.location?.host ?? 'localhost';
  const resource = uri ?? globalThis.location?.origin ?? `http://${origin}`;

  try {
    const chainId = await currentChainId(provider);
    const message = createSiweMessage({
      address,
      nonce,
      domain: origin,
      uri: resource,
      chainId,
    });
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, address],
    });
    return { message, signature };
  } catch (cause) {
    throw toWalletError(cause);
  }
}

/**
 * Run the full handshake for an address.
 *
 * The nonce is fetched from the server, signed, and exchanged for a session —
 * the three steps a caller would otherwise have to sequence themselves.
 *
 * @param {import('./api-client.js').GameApiClient} api
 * @returns {Promise<{address: string, domain: string}>}
 */
export async function connectAndSignIn(api) {
  const address = await connectWallet();
  const { nonce } = await api.nonce(address);
  const { message, signature } = await signIn({ address, nonce });
  const session = await api.verify(message, signature);
  return { address: session.address, domain: globalThis.location?.host ?? '' };
}
