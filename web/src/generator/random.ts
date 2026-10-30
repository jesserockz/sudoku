/**
 * Deterministic pseudo-random numbers for puzzle generation.
 *
 * Everything here is exact unsigned 64-bit arithmetic on BigInt, so a seed
 * produces the same sequence in every browser, on Node and in the original
 * Kotlin implementation (whose golden values the tests pin).
 *
 * The generator is xoshiro256** (Blackman and Vigna), seeded from SplitMix64
 * as its authors recommend.
 */
const MASK = (1n << 64n) - 1n;
const u64 = (x: bigint): bigint => x & MASK;
const rotl = (x: bigint, k: bigint): bigint => u64((x << k) | (x >> (64n - k)));

/** SplitMix64 (Steele, Lea and Flood), used for seeding and for mixing seed inputs. */
export class SplitMix64 {
  static readonly GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
  #state: bigint;

  constructor(seed: bigint) {
    this.#state = u64(seed);
  }

  next(): bigint {
    this.#state = u64(this.#state + SplitMix64.GOLDEN_GAMMA);
    return SplitMix64.mix(this.#state);
  }

  /** The SplitMix64 output function: a strong 64-bit bijective mixer. */
  static mix(value: bigint): bigint {
    let z = u64(value);
    z = u64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = u64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }
}

export class Xoshiro256StarStar {
  #s0: bigint;
  #s1: bigint;
  #s2: bigint;
  #s3: bigint;

  constructor(seed: bigint) {
    const sm = new SplitMix64(seed);
    this.#s0 = sm.next();
    this.#s1 = sm.next();
    this.#s2 = sm.next();
    this.#s3 = sm.next();
  }

  /** The next value as an unsigned 64-bit integer. */
  nextU64(): bigint {
    const result = u64(rotl(u64(this.#s1 * 5n), 7n) * 9n);
    const t = u64(this.#s1 << 17n);
    this.#s2 ^= this.#s0;
    this.#s3 ^= this.#s1;
    this.#s1 ^= this.#s2;
    this.#s0 ^= this.#s3;
    this.#s2 ^= t;
    this.#s3 = rotl(this.#s3, 45n);
    return result;
  }

  /** A uniformly distributed integer in `0 until bound`, without modulo bias. */
  nextInt(bound: number): number {
    if (!(bound > 0)) throw new RangeError(`bound must be positive: ${bound}`);
    // Take the top 32 bits and reject the uneven tail.
    const range = 2 ** 32;
    const limit = range - (range % bound);
    for (;;) {
      const r = Number(this.nextU64() >> 32n);
      if (r < limit) return r % bound;
    }
  }

  /** Fisher-Yates shuffle in place. */
  shuffle(array: number[] | Int32Array): void {
    for (let i = array.length - 1; i >= 1; i--) {
      const j = this.nextInt(i + 1);
      const tmp = array[i]!;
      array[i] = array[j]!;
      array[j] = tmp;
    }
  }
}
