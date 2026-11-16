package store

import (
	"context"
	"strings"
	"testing"
)

func TestOIDCKeys(t *testing.T) {
	ctx := context.Background()
	s, path := openTemp(t)
	if data, err := s.LoadOIDCKeys(ctx, "https://a/"); err != nil || data != nil {
		t.Fatalf("nothing saved: %q, %v", data, err)
	}
	for _, d := range []string{`{"v":1}`, `{"v":2}`} {
		if err := s.SaveOIDCKeys(ctx, "https://a/", []byte(d)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SaveOIDCKeys(ctx, "https://b/", []byte(`{"v":3}`)); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// The keys outlive a restart, the latest per issuer.
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for issuer, want := range map[string]string{"https://a/": `{"v":2}`, "https://b/": `{"v":3}`} {
		if data, err := s.LoadOIDCKeys(ctx, issuer); err != nil || string(data) != want {
			t.Errorf("%s: %q, %v, want %s", issuer, data, err, want)
		}
	}
	s.Close()
	if _, err := s.LoadOIDCKeys(ctx, "https://a/"); err == nil || !strings.Contains(err.Error(), "load oidc keys") {
		t.Errorf("closed store load: %v", err)
	}
	if err := s.SaveOIDCKeys(ctx, "https://a/", nil); err == nil || !strings.Contains(err.Error(), "save oidc keys") {
		t.Errorf("closed store save: %v", err)
	}
}
