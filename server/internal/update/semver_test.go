package update

import "testing"

func TestValidTag(t *testing.T) {
	for _, tag := range []string{"v1.2.3", "1.2.3", "v0.3.0-rc.1", "v1.0.0+build.5", "v1.0.0-beta.2+x"} {
		if !ValidTag(tag) {
			t.Errorf("ValidTag(%q) = false", tag)
		}
	}
	for _, tag := range []string{"", "v1.2", "latest", "v1.2.3 ", "../v1.2.3", "v1.2.3/../x", "vv1.2.3", "v1.2.3-", "1.2.3\n"} {
		if ValidTag(tag) {
			t.Errorf("ValidTag(%q) = true", tag)
		}
	}
}

func TestCompare(t *testing.T) {
	tests := []struct {
		v, cur, want string
	}{
		{"v0.3.0", "0.2.0", Newer},
		{"0.2.0", "0.2.0", Same},
		{"v0.2.0", "0.2.0", Same},
		{"0.2.0+build", "0.2.0", Same},
		{"0.1.9", "0.2.0", Older},
		{"1.0.0", "0.9.9", Newer},
		{"0.2.1", "0.2.0", Newer},
		{"0.3.0", "0.2.9", Newer},
		{"0.2.0", "0.10.0", Older},
		// Prereleases rank below their release, in either operand position.
		{"1.0.0-rc.1", "1.0.0", Older},
		{"1.0.0", "1.0.0-rc.1", Newer},
		{"1.0.0-rc.1", "1.0.0-rc.1", Same},
		{"1.0.0-rc.2", "1.0.0-rc.10", Older},
		{"1.0.0-rc.10", "1.0.0-rc.2", Newer},
		{"1.0.0-alpha", "1.0.0-beta", Older},
		{"1.0.0-beta", "1.0.0-alpha", Newer},
		{"1.0.0-1", "1.0.0-alpha", Older},
		{"1.0.0-alpha", "1.0.0-1", Newer},
		{"1.0.0-alpha", "1.0.0-alpha.1", Older},
		{"1.0.0-alpha.1", "1.0.0-alpha", Newer},
		{"1.0.0-9", "1.0.0-10", Older},
		{"nonsense", "0.2.0", Unknown},
		{"0.3.0", "dev", Unknown},
		{"0.3.0", "", Unknown},
		{"99999999999999999999.0.0", "0.2.0", Unknown},
	}
	for _, tt := range tests {
		if got := Compare(tt.v, tt.cur); got != tt.want {
			t.Errorf("Compare(%q, %q) = %q, want %q", tt.v, tt.cur, got, tt.want)
		}
	}
}
