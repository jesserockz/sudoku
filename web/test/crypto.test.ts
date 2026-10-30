import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacSha256, sha256, webSubtle } from "../src/data/crypto.ts";
import { hmacSha256Bytes, sha256Bytes } from "../src/data/sha256.ts";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fill = (length: number, byte: number): Uint8Array => new Uint8Array(length).fill(byte);
const subtle = crypto.subtle;

test("SHA-256 known answers (FIPS 180-4)", () => {
  assert.equal(hex(sha256Bytes(new Uint8Array())), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256Bytes(encoder.encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    hex(sha256Bytes(encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(hex(sha256Bytes(fill(1_000_000, 0x61))), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("HMAC-SHA256 known answers (RFC 4231)", () => {
  assert.equal(
    hex(hmacSha256Bytes(fill(20, 0x0b), encoder.encode("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(
    hex(hmacSha256Bytes(encoder.encode("Jefe"), encoder.encode("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  // A key longer than the block is hashed first.
  assert.equal(
    hex(hmacSha256Bytes(fill(131, 0xaa), encoder.encode("Test Using Larger Than Block-Size Key - Hash Key First"))),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
});

test("the fallback matches crypto.subtle across padding and block boundaries", async () => {
  for (let length = 0; length <= 200; length++) {
    const data = crypto.getRandomValues(new Uint8Array(length));
    assert.equal(hex(sha256Bytes(data)), hex(new Uint8Array(await subtle.digest("SHA-256", data))), `length ${length}`);
    if (length === 0) continue; // WebCrypto refuses empty HMAC keys (seeds are never empty).
    const key = await subtle.importKey("raw", data, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const message = data.subarray(0, length >> 1);
    assert.equal(hex(hmacSha256Bytes(data, message)), hex(new Uint8Array(await subtle.sign("HMAC", key, message))), `key length ${length}`);
  }
});

test("the string helpers give the same bytes with and without crypto.subtle", async () => {
  for (const [key, message] of [["k", ""], ["test-secret-0123456789", "sudoku-week:2026-W44"], ["Kōwhai 🌼 whānau", "sudoku-fingerprint"], ["a".repeat(100), "x"]]) {
    assert.deepEqual(await hmacSha256(key!, message!, null), await hmacSha256(key!, message!, subtle));
    assert.deepEqual(await sha256(message!, null), await sha256(message!, subtle));
  }
  // With no argument, Node's crypto.subtle is used.
  assert.equal(webSubtle(), subtle);
  assert.equal(hex(await sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("crypto.subtle is used when present and skipped when absent", async () => {
  const calls: string[] = [];
  const fake = {
    importKey: async () => (calls.push("importKey"), "key"),
    sign: async () => (calls.push("sign"), new Uint8Array([1]).buffer),
    digest: async () => (calls.push("digest"), new Uint8Array([2]).buffer),
  } as unknown as SubtleCrypto;
  assert.deepEqual(await hmacSha256("k", "m", fake), new Uint8Array([1]));
  assert.deepEqual(await sha256("t", fake), new Uint8Array([2]));
  assert.deepEqual(calls, ["importKey", "sign", "digest"]);
});

test("outside a secure context there's no crypto.subtle, and the fallback is chosen", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", original));
  const expected = await hmacSha256("test-secret-0123456789", "sudoku-week:2026-W44", subtle);
  // An insecure browser page: `crypto` without `subtle`.
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: crypto.getRandomValues.bind(crypto) }, configurable: true });
  assert.equal(webSubtle(), null);
  assert.deepEqual(await hmacSha256("test-secret-0123456789", "sudoku-week:2026-W44"), expected);
  // No `crypto` at all.
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  assert.equal(webSubtle(), null);
  assert.equal(hex(await sha256("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
