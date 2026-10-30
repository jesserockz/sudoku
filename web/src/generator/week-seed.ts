/**
 * The weekly seed travels as 16 lowercase hex characters (see `docs/API.md`),
 * because JSON numbers can't hold 64-bit integers exactly. In code it's an
 * unsigned 64-bit BigInt.
 */
export function parseWeekSeed(hex: string): bigint {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) throw new RangeError(`week seed must be 16 hex characters: "${hex}"`);
  return BigInt("0x" + hex);
}

export function formatWeekSeed(seed: bigint): string {
  return BigInt.asUintN(64, seed).toString(16).padStart(16, "0");
}
