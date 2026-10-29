import type { StoredTokens } from "../data/app-storage.ts";
import { base64Url, randomToken, sha256 } from "../data/crypto.ts";
import { Mutex } from "../data/mutex.ts";
import { num, obj, optional, str } from "../data/store.ts";
import type { Fetch } from "./client.ts";

/** A PKCE pair (RFC 7636, S256). */
export async function createPkce(verifier: string = randomToken(32)): Promise<{ verifier: string; challenge: string }> {
  return { verifier, challenge: base64Url(await sha256(verifier)) };
}

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | null;
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number | null;
  refreshToken: string | null;
  idToken: string | null;
}

/** A token endpoint error (RFC 6749 section 5.2). */
export class OidcException extends Error {
  readonly status: number;
  readonly error: string | null;

  constructor(status: number, error: string | null, description: string | null) {
    super(`OIDC error ${error ?? `HTTP ${status}`}${description ? `: ${description}` : ""}`);
    this.status = status;
    this.error = error;
  }
}

/**
 * An OAuth 2.0 / OIDC public client using Authorization Code + PKCE, for
 * Authentik (or any compliant provider). It builds the authorization URL and
 * calls the token endpoint; the redirect itself is the app's job.
 */
export class OidcClient {
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: string[];
  readonly redirectUri: string;
  readonly #fetch: Fetch;
  #discovery: Promise<Discovery> | null = null;

  constructor(issuer: string, clientId: string, scopes: string[], redirectUri: string, fetcher: Fetch = (...args) => fetch(...args)) {
    this.issuer = issuer;
    this.clientId = clientId;
    this.scopes = scopes;
    this.redirectUri = redirectUri;
    this.#fetch = fetcher;
  }

  discover(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const url = this.issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
      const response = await this.#fetch(url);
      if (!response.ok) throw new OidcException(response.status, null, `discovery failed: ${url}`);
      const o = obj(await response.json());
      return {
        authorizationEndpoint: str(o.authorization_endpoint),
        tokenEndpoint: str(o.token_endpoint),
        endSessionEndpoint: optional(o.end_session_endpoint, str),
      };
    })().catch((e) => {
      this.#discovery = null;
      throw e;
    });
    return this.#discovery;
  }

  async authorizationUrl(challenge: string, state: string, nonce: string): Promise<string> {
    const url = new URL((await this.discover()).authorizationEndpoint);
    const p = url.searchParams;
    p.append("response_type", "code");
    p.append("client_id", this.clientId);
    p.append("redirect_uri", this.redirectUri);
    p.append("scope", this.scopes.join(" "));
    p.append("state", state);
    p.append("code_challenge", challenge);
    p.append("code_challenge_method", "S256");
    p.append("nonce", nonce);
    return url.href;
  }

  exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.#token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, client_id: this.clientId, code_verifier: verifier });
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.clientId });
  }

  /** Where to send the browser to end the provider session, if it supports that. */
  async endSessionUrl(idToken: string | null, postLogoutRedirectUri: string): Promise<string | null> {
    const endpoint = (await this.discover()).endSessionEndpoint;
    if (!endpoint) return null;
    const url = new URL(endpoint);
    if (idToken) url.searchParams.append("id_token_hint", idToken);
    url.searchParams.append("post_logout_redirect_uri", postLogoutRedirectUri);
    url.searchParams.append("client_id", this.clientId);
    return url.href;
  }

  async #token(form: Record<string, string>): Promise<TokenResponse> {
    const response = await this.#fetch((await this.discover()).tokenEndpoint, { method: "POST", body: new URLSearchParams(form) });
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try {
        body = obj(await response.json());
      } catch {
        // No error body.
      }
      throw new OidcException(response.status, optional(body.error, str), optional(body.error_description, str));
    }
    const o = obj(await response.json());
    return {
      accessToken: str(o.access_token),
      expiresIn: optional(o.expires_in, num),
      refreshToken: optional(o.refresh_token, str),
      idToken: optional(o.id_token, str),
    };
  }
}

/**
 * Keeps a signed-in session's tokens fresh. `token()` returns a usable access
 * token, refreshing it first when it expires within `refreshMarginMs`. When
 * refresh is impossible (no refresh token, or the provider rejects it) the
 * session ends and `token()` returns `null`. Other refresh failures (offline)
 * return the old token so the API can decide.
 */
export class TokenSession {
  readonly #load: () => StoredTokens | null;
  readonly #save: (tokens: StoredTokens | null) => void;
  readonly #refresh: (refreshToken: string) => Promise<TokenResponse>;
  readonly #now: () => number;
  readonly #refreshMarginMs: number;
  readonly #mutex = new Mutex();

  constructor(
    load: () => StoredTokens | null,
    save: (tokens: StoredTokens | null) => void,
    refresh: (refreshToken: string) => Promise<TokenResponse>,
    now: () => number = Date.now,
    refreshMarginMs = 60_000,
  ) {
    this.#load = load;
    this.#save = save;
    this.#refresh = refresh;
    this.#now = now;
    this.#refreshMarginMs = refreshMarginMs;
  }

  /** Stores the result of a code exchange. */
  signedIn(response: TokenResponse): Promise<void> {
    return this.#mutex.run(async () => this.#save(this.#stored(response, null)));
  }

  token(): Promise<string | null> {
    return this.#mutex.run(async () => {
      const tokens = this.#load();
      if (!tokens) return null;
      const expiresAt = tokens.expiresAtEpochMs;
      const now = this.#now();
      if (expiresAt === null || expiresAt - this.#refreshMarginMs > now) return tokens.accessToken;
      if (tokens.refreshToken === null) {
        if (expiresAt > now) return tokens.accessToken;
        this.#save(null);
        return null;
      }
      try {
        const refreshed = this.#stored(await this.#refresh(tokens.refreshToken), tokens);
        this.#save(refreshed);
        return refreshed.accessToken;
      } catch (e) {
        if (e instanceof OidcException && (e.error === "invalid_grant" || (e.status >= 400 && e.status < 500))) {
          this.#save(null);
          return null;
        }
        return tokens.accessToken;
      }
    });
  }

  #stored(response: TokenResponse, previous: StoredTokens | null): StoredTokens {
    return {
      accessToken: response.accessToken,
      // Providers may omit the refresh token on refresh, meaning "keep using the old one".
      refreshToken: response.refreshToken ?? previous?.refreshToken ?? null,
      idToken: response.idToken ?? previous?.idToken ?? null,
      expiresAtEpochMs: response.expiresIn === null ? null : this.#now() + response.expiresIn * 1000,
    };
  }
}
