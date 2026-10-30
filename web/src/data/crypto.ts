/** WebCrypto: browsers (secure contexts: HTTPS or localhost) and Node.js. */
const encoder = new TextEncoder();

export async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A URL-safe random string (for OIDC `state`, `nonce` and PKCE verifiers). */
export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}
