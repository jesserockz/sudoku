package puzzle

import "math/bits"

// splitMix64 is SplitMix64 (Steele, Lea and Flood), used for seeding and for
// mixing seed inputs.
type splitMix64 struct{ state uint64 }

const goldenGamma uint64 = 0x9e3779b97f4a7c15

func (s *splitMix64) next() uint64 {
	s.state += goldenGamma
	return mix(s.state)
}

// mix is the SplitMix64 output function: a strong 64-bit bijective mixer.
func mix(z uint64) uint64 {
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// xoshiro is xoshiro256** (Blackman and Vigna), seeded from SplitMix64.
type xoshiro struct{ s0, s1, s2, s3 uint64 }

func newXoshiro(seed uint64) *xoshiro {
	sm := splitMix64{state: seed}
	x := &xoshiro{}
	x.s0 = sm.next()
	x.s1 = sm.next()
	x.s2 = sm.next()
	x.s3 = sm.next()
	return x
}

// nextU64 is the next value as an unsigned 64-bit integer.
func (x *xoshiro) nextU64() uint64 {
	result := bits.RotateLeft64(x.s1*5, 7) * 9
	t := x.s1 << 17
	x.s2 ^= x.s0
	x.s3 ^= x.s1
	x.s1 ^= x.s2
	x.s0 ^= x.s3
	x.s2 ^= t
	x.s3 = bits.RotateLeft64(x.s3, 45)
	return result
}

// nextInt is a uniform integer in 0..bound-1 (bound > 0), without modulo bias:
// it takes the top 32 bits and rejects the uneven tail.
func (x *xoshiro) nextInt(bound int) int {
	const rng = uint64(1) << 32
	b := uint64(bound)
	limit := rng - rng%b
	for {
		r := x.nextU64() >> 32
		if r < limit {
			return int(r % b)
		}
	}
}

// shuffle is a Fisher-Yates shuffle in place, from the end.
func (x *xoshiro) shuffle(a []int) {
	for i := len(a) - 1; i >= 1; i-- {
		j := x.nextInt(i + 1)
		a[i], a[j] = a[j], a[i]
	}
}
