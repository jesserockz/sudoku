package seed

import (
	"regexp"
	"testing"
)

func TestForWeekVectors(t *testing.T) {
	// Vectors computed independently with:
	//   printf 'sudoku-week:2026-W44' | openssl dgst -sha256 -hmac 'test-secret-0123456789'
	secret := []byte("test-secret-0123456789")
	tests := []struct{ week, want string }{
		{"2026-W44", "e4d2e1e00e3549cc"},
		{"2020-W53", "8ef3b5d3a4a37a74"},
	}
	for _, tt := range tests {
		if got := ForWeek(secret, tt.week); got != tt.want {
			t.Errorf("ForWeek(%q) = %q, want %q", tt.week, got, tt.want)
		}
	}
}

func TestForWeekShape(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{16}$`)
	a := ForWeek([]byte("secret-a-0123456789"), "2026-W44")
	b := ForWeek([]byte("secret-b-0123456789"), "2026-W44")
	c := ForWeek([]byte("secret-a-0123456789"), "2026-W45")
	for _, s := range []string{a, b, c} {
		if !re.MatchString(s) {
			t.Errorf("seed %q is not 16 lowercase hex chars", s)
		}
	}
	if a == b || a == c {
		t.Errorf("seeds should differ by secret and week: %s %s %s", a, b, c)
	}
}

func TestForEndlessVectors(t *testing.T) {
	tests := []struct{ secret, want string }{
		{"test-secret-0123456789", "3242a2d84b0602b6"},
		{"dev-secret-change-me", "fd31dd763bb00e2c"},
	}
	for _, tt := range tests {
		if got := ForEndless([]byte(tt.secret)); got != tt.want {
			t.Errorf("ForEndless(%q) = %q, want %q", tt.secret, got, tt.want)
		}
	}
	if ForEndless([]byte("a-secret-0123456789")) == ForWeek([]byte("a-secret-0123456789"), "2026-W44") {
		t.Error("endless seed should differ from a week seed")
	}
}
