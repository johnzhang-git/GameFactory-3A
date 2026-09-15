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

/** EIP-1193: the wallet does not know this chain. */
const UNKNOWN_CHAIN = 4902;

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

/**
 * The chain the wallet is currently on.
 *
 * @returns {Promise<number>} the EIP-155 chain id
 */
export async function currentChain() {
  const provider = requireProvider();
  return currentChainId(provider);
}

/**
 * Ensure the wallet is on `chainId`, asking it to switch if not.
 *
 * A wallet that has never seen the chain answers 4902 rather than switching,
 * so that case falls through to `wallet_addEthereumChain`. That is the normal
 * path for a player meeting a game's chain for the first time.
 *
 * @param {number} chainId
 * @param {{name?: string, rpcUrls?: string[], explorer?: string,
 *          currency?: {name: string, symbol: string, decimals: number}}} [meta]
 * @returns {Promise<boolean>} whether a switch was performed
 */
export async function ensureChain(chainId, meta = {}) {
  const provider = requireProvider();
  const hex = `0x${chainId.toString(16)}`;

  if ((await currentChainId(provider)) === chainId) return false;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hex }],
    });
    return true;
  } catch (cause) {
    if (cause?.code !== UNKNOWN_CHAIN) throw toWalletError(cause);
    // The wallet has no such chain: offer to add it.
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hex,
            chainName: meta.name ?? `Chain ${chainId}`,
            nativeCurrency: meta.currency ?? {
              name: 'Ether',
              symbol: 'ETH',
              decimals: 18,
            },
            rpcUrls: meta.rpcUrls ?? [],
            ...(meta.explorer ? { blockExplorerUrls: [meta.explorer] } : {}),
          },
        ],
      });
      return true;
    } catch (addCause) {
      throw toWalletError(addCause);
    }
  }
}

/**
 * Submit a transaction the server prepared.
 *
 * The caller passes `transaction.data` straight through from a voucher — the
 * client does not build or inspect the calldata. `from` is set explicitly so
 * the request is unambiguous when the wallet holds several accounts.
 *
 * @param {{to: string, data: string, value?: string}} transaction
 * @param {string} from
 * @returns {Promise<string>} the transaction hash
 */
export async function sendTransaction(transaction, from) {
  const provider = requireProvider();
  try {
    return await provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value ?? '0x0',
        },
      ],
    });
  } catch (cause) {
    throw toWalletError(cause);
  }
}
