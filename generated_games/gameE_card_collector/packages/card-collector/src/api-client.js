/**
 * HTTP client for the card-collector backend.
 *
 * The server is authoritative once a wallet is connected: this client asks for
 * things and is told what happened. It never computes a draw or decides
 * whether a purchase is affordable — it sends the request and adopts the state
 * that comes back.
 *
 * `fetch` and the token store are injected so the client can be exercised in a
 * test without a browser or a running server.
 */

/** An error carrying the server's status and message. */
export class GameApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'GameApiError';
    this.status = status;
  }
}

/** An in-memory token store, used when there is no `localStorage`. */
export function createMemoryTokenStore() {
  let token = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
  };
}

/** A token store backed by `localStorage`, so a reload keeps the session. */
export function createBrowserTokenStore(key = 'a3game.cardCollector.token') {
  return {
    get: () => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        // Storage can be blocked (private mode, third-party context). A
        // forgotten session is a reasonable failure; a crash is not.
        return null;
      }
    },
    set: (value) => {
      try {
        if (value) globalThis.localStorage?.setItem(key, value);
        else globalThis.localStorage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

export class GameApiClient {
  /**
   * @param {{baseUrl?: string, fetchImpl?: typeof fetch,
   *          tokenStore?: {get(): string|null, set(v: string|null): void}}} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.tokens = options.tokenStore ?? createBrowserTokenStore();
  }

  /** True when a session token is present. */
  get signedIn() {
    return Boolean(this.tokens.get());
  }

  /** The stored session token, or null. */
  get token() {
    return this.tokens.get();
  }

  /**
   * Issue a request, unwrapping the JSON body.
   *
   * Every failure becomes a `GameApiError` carrying the server's own message,
   * so callers can show it rather than guessing from a status code.
   */
  async request(path, { method = 'POST', body } = {}) {
    const token = this.tokens.get();
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // A dead network is the common case here (server not started), and it
      // deserves a clearer message than "Failed to fetch".
      throw new GameApiError(0, 'cannot reach the game server');
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      // A rejected session is worth forgetting immediately, so the UI can
      // fall back to "connect wallet" instead of retrying a dead token.
      if (res.status === 401) this.tokens.set(null);
      throw new GameApiError(
        res.status,
        payload?.error ?? `request failed (${res.status})`,
      );
    }
    return payload;
  }

  // --- auth ---------------------------------------------------------------

  /** Ask for a login nonce to embed in a SIWE message. */
  nonce(address) {
    return this.request('/auth/nonce', { body: { address } });
  }

  /**
   * Exchange a signed SIWE message for a session.
   *
   * The token is stored before returning so the very next call is
   * authenticated.
   */
  async verify(message, signature) {
    const result = await this.request('/auth/verify', {
      body: { message, signature },
    });
    this.tokens.set(result.token);
    return result;
  }

  /** The address behind the current session, or null when there is none. */
  async me() {
    if (!this.signedIn) return null;
    try {
      const { address } = await this.request('/auth/me', { method: 'GET' });
      return address;
    } catch (error) {
      if (error instanceof GameApiError && error.status === 401) return null;
      throw error;
    }
  }

  /** Drop the session, locally and on the server. */
  async logout() {
    try {
      if (this.signedIn) await this.request('/auth/logout', { body: {} });
    } finally {
      // Even if the server call failed, forget the token: a session the
      // player asked to end should not survive on this device.
      this.tokens.set(null);
    }
  }

  // --- game ---------------------------------------------------------------

  /** Fetch the save, with offline income already credited server-side. */
  state() {
    return this.request('/game/state', { method: 'GET' });
  }

  /** Buy a chest. `gold` buys the premium one. */
  buy({ gold = false } = {}) {
    return this.request('/game/buy', { body: { gold } });
  }

  /** Open a chest and return the authoritative draw. */
  open({ gold = false } = {}) {
    return this.request('/game/open', { body: { gold } });
  }

  /** Reset the run for prestige. */
  prestige() {
    return this.request('/game/prestige', { body: {} });
  }

  /** Ask the server to credit `seconds` of income. */
  tick(seconds) {
    return this.request('/game/tick', { body: { seconds } });
  }
}
