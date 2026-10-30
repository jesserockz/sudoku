/**
 * WebCrypto where it's available: Node.js, and browsers in secure contexts
 * (HTTPS or localhost). Over plain http (e.g. on a LAN) browsers leave out
 * `crypto.subtle`, so hashing falls back to a pure-TS implementation with the
 * same output. `crypto.getRandomValues` works in any context.
 */
import { hmacSha256Bytes, sha256Bytes } from "./sha256.ts";

const encoder = new TextEncoder();

/** `crypto.subtle`, or `null` outside a secure context. */
export function webSubtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

export async function hmacSha256(key: string, message: string, subtle: SubtleCrypto | null = webSubtle()): Promise<Uint8Array> {
  if (!subtle) return hmacSha256Bytes(encoder.encode(key), encoder.encode(message));
  const k = await subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, encoder.encode(message)));
}

export async function sha256(text: string, subtle: SubtleCrypto | null = webSubtle()): Promise<Uint8Array> {
  if (!subtle) return sha256Bytes(encoder.encode(text));
  return new Uint8Array(await subtle.digest("SHA-256", encoder.encode(text)));
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
