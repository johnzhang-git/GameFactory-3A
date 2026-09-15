/**
 * Wallet login, following Sign-In with Ethereum (EIP-4361).
 *
 * Two steps: hand the client a nonce, then verify a signed message embedding
 * that nonce. The nonce is single-use, so a signature captured off the wire
 * cannot be replayed to open a second session.
 *
 * This replaces "no accounts at all": the game previously had no identity of
 * any kind, so there was nothing to attach a collection to.
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe';
import { HttpError } from './errors.js';

/**
 * A read-only client, used only so signature verification can reach a node
 * when the signer is a smart-contract account (ERC-1271/6492). Plain wallet
 * signatures are verified locally without a network call.
 *
 * The default mainnet transport is deliberate: `verifySiweMessage` only needs
 * `client.getBytecode`, and an address's bytecode is identical across EVM
 * chains, so there is nothing chain-specific to configure. Set SIWE_RPC_URL to
 * point at a dedicated node if the public endpoint rate-limits.
 */
function createVerifierClient(rpcUrl = process.env.SIWE_RPC_URL) {
  return createPublicClient({
    chain: mainnet,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });
}

export class Auth {
  /**
   * @param {import('./store.js').Store} store
   * @param {{sessionTtlMs: number, siweDomain?: string}} config
   */
  constructor(store, config, verifierClient = createVerifierClient()) {
    this.store = store;
    this.config = config;
    this.verifier = verifierClient;
  }

  /** Step 1: a fresh nonce for the client to embed in its message. */
  nonce(address) {
    if (!address) throw new HttpError(400, 'address is required');
    return this.store.issueNonce(address);
  }

  /**
   * Step 2: verify a signed message and open a session.
   *
   * @param {{message: string, signature: string}} payload
   * @returns {Promise<{token: string, address: string}>}
   */
  async verify({ message, signature }) {
    if (!message || !signature) {
      throw new HttpError(400, 'message and signature are required');
    }

    let parsed;
    try {
      parsed = parseSiweMessage(message);
    } catch {
      throw new HttpError(400, 'message is not a valid SIWE statement');
    }
    if (!parsed.address || !parsed.nonce) {
      throw new HttpError(400, 'message must carry an address and a nonce');
    }

    // Consume before verifying: the nonce is spent either way, so a failed
    // attempt cannot be retried against the same challenge.
    const issuedTo = this.store.consumeNonce(parsed.nonce);
    if (!issuedTo) {
      throw new HttpError(401, 'unknown or already-used nonce');
    }
    if (issuedTo !== parsed.address.toLowerCase()) {
      throw new HttpError(401, 'nonce was issued to a different address');
    }

    const valid = await verifySiweMessage(this.verifier, {
      // The address from the message, which we already bound to the nonce.
      address: parsed.address,
      message,
      signature,
      nonce: parsed.nonce,
      // Validated only when configured; an unset domain means a dev setup
      // serving on a shifting host, where pinning it would just block logins.
      ...(this.config.siweDomain ? { domain: this.config.siweDomain } : {}),
    });
    if (!valid) throw new HttpError(401, 'signature does not match the message');

    const address = parsed.address.toLowerCase();
    const token = this.store.createSession(address, this.config.sessionTtlMs);
    return { token, address };
  }

  /** Read the bearer token off a request and resolve it to an address. */
  requireAddress(req) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const address = this.store.sessionAddress(token);
    if (!address) throw new HttpError(401, 'not signed in');
    return address;
  }

  /** Revoke the session behind a request. */
  logout(req) {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Bearer ')) {
      this.store.deleteSession(header.slice(7));
    }
  }
}
