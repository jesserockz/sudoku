package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// testIssuer is a fake OIDC provider serving discovery and a JWKS.
type testIssuer struct {
	srv       *httptest.Server
	key       *rsa.PrivateKey
	discovery atomic.Int32
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ti := &testIssuer{key: key}
	mux := http.NewServeMux()
	ti.srv = httptest.NewServer(mux)
	t.Cleanup(ti.srv.Close)
	mux.HandleFunc("/application/o/sudoku/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		ti.discovery.Add(1)
		json.NewEncoder(w).Encode(map[string]string{
			"issuer":   ti.Issuer(),
			"jwks_uri": ti.srv.URL + "/application/o/sudoku/jwks/",
		})
	})
	mux.HandleFunc("/application/o/sudoku/jwks/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
		}})
	})
	return ti
}

func (ti *testIssuer) Issuer() string { return ti.srv.URL + "/application/o/sudoku/" }

// sign returns a JWT for claims, signed with key under kid.
func sign(t *testing.T, key *rsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(claims)
	obj, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	s, err := obj.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var testNow = time.Date(2026, 10, 26, 9, 0, 0, 0, time.UTC)

func (ti *testIssuer) claims(overrides map[string]any) map[string]any {
	c := map[string]any{
		"iss":                ti.Issuer(),
		"sub":                "abc123",
		"aud":                "sudoku-web",
		"exp":                testNow.Add(time.Hour).Unix(),
		"iat":                testNow.Add(-time.Minute).Unix(),
		"name":               "Alice Example",
		"preferred_username": "alice",
	}
	for k, v := range overrides {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	return c
}

func (ti *testIssuer) verifier() *OIDC {
	return &OIDC{
		Issuer:   ti.Issuer(),
		Audience: []string{"sudoku-web", "sudoku-android"},
		Now:      func() time.Time { return testNow },
	}
}

func TestOIDCValid(t *testing.T) {
	ti := newTestIssuer(t)
	v := ti.verifier()
	tests := []struct {
		name      string
		overrides map[string]any
		wantName  string
	}{
		{"name claim", nil, "Alice Example"},
		{"preferred_username fallback", map[string]any{"name": nil}, "alice"},
		{"sub fallback", map[string]any{"name": "  ", "preferred_username": nil}, "abc123"},
		{"second audience", map[string]any{"aud": "sudoku-android"}, "Alice Example"},
		{"audience list", map[string]any{"aud": []string{"other", "sudoku-web"}}, "Alice Example"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, err := v.Verify(context.Background(), sign(t, ti.key, "k1", ti.claims(tt.overrides)))
			if err != nil {
				t.Fatal(err)
			}
			if id.Subject != "abc123" || id.DisplayName != tt.wantName {
				t.Errorf("identity = %+v", id)
			}
		})
	}
	if n := ti.discovery.Load(); n != 1 {
		t.Errorf("discovery fetched %d times, want once", n)
	}
}

func TestOIDCRejects(t *testing.T) {
	ti := newTestIssuer(t)
	v := ti.verifier()
	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	tests := []struct {
		name  string
		token string
	}{
		{"expired", sign(t, ti.key, "k1", ti.claims(map[string]any{"exp": testNow.Add(-time.Second).Unix()}))},
		{"no exp", sign(t, ti.key, "k1", ti.claims(map[string]any{"exp": nil}))},
		{"wrong issuer", sign(t, ti.key, "k1", ti.claims(map[string]any{"iss": "https://evil.example.com/"}))},
		{"wrong audience", sign(t, ti.key, "k1", ti.claims(map[string]any{"aud": "someone-else"}))},
		{"no audience", sign(t, ti.key, "k1", ti.claims(map[string]any{"aud": nil}))},
		{"no sub", sign(t, ti.key, "k1", ti.claims(map[string]any{"sub": nil}))},
		{"wrong key", sign(t, otherKey, "k1", ti.claims(nil))},
		{"unknown kid", sign(t, otherKey, "k2", ti.claims(nil))},
		{"garbage", "not-a-jwt"},
		{"dev token", "dev:alice:Alice"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := v.Verify(context.Background(), tt.token)
			if !errors.Is(err, ErrInvalidToken) {
				t.Errorf("err = %v, want ErrInvalidToken", err)
			}
		})
	}
}

func TestOIDCIssuerDownIsNotInvalidToken(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	v := &OIDC{Issuer: srv.URL + "/", Audience: []string{"x"}}
	_, err := v.Verify(context.Background(), "x.y.z")
	if err == nil || errors.Is(err, ErrInvalidToken) {
		t.Errorf("err = %v, want a non-token error", err)
	}
}

func TestDev(t *testing.T) {
	tests := []struct {
		token, sub, name string
	}{
		{"dev:alice:Alice", "dev:alice", "Alice"},
		{"dev:bob", "dev:bob", "bob"},
		{"dev:carol:", "dev:carol", "carol"},
		{"dev:dave:Dave: The Great", "dev:dave", "Dave: The Great"},
	}
	for _, tt := range tests {
		id, err := Dev{}.Verify(context.Background(), tt.token)
		if err != nil || id.Subject != tt.sub || id.DisplayName != tt.name {
			t.Errorf("Verify(%q) = %+v, %v", tt.token, id, err)
		}
	}
	for _, bad := range []string{"", "dev", "dev:", "dev: :x", "alice:Alice", "eyJhbGciOi.x.y"} {
		if _, err := (Dev{}).Verify(context.Background(), bad); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("Verify(%q) err = %v", bad, err)
		}
	}
}

func TestDevClaims(t *testing.T) {
	tests := []struct {
		token string
		want  map[string]any
	}{
		{"dev:alice:Alice", map[string]any{"sub": "alice", "name": "Alice"}},
		{"dev:bob", map[string]any{"sub": "bob", "name": ""}},
	}
	for _, tt := range tests {
		id, err := Dev{}.Verify(context.Background(), tt.token)
		if err != nil || !reflect.DeepEqual(id.Claims, tt.want) {
			t.Errorf("Verify(%q) claims = %v, %v; want %v", tt.token, id.Claims, err, tt.want)
		}
	}
}

func TestOIDCClaims(t *testing.T) {
	ti := newTestIssuer(t)
	tok := sign(t, ti.key, "k1", ti.claims(map[string]any{
		"groups":       []string{"sudoku-admins"},
		"realm_access": map[string]any{"roles": []string{"a"}},
	}))
	id, err := ti.verifier().Verify(context.Background(), tok)
	if err != nil {
		t.Fatal(err)
	}
	if !HasClaimValue(id.Claims, "groups", []string{"sudoku-admins"}) ||
		!HasClaimValue(id.Claims, "realm_access.roles", []string{"a"}) ||
		id.Claims["sub"] != "abc123" {
		t.Errorf("claims = %v", id.Claims)
	}
}

func TestHasClaimValue(t *testing.T) {
	claims := map[string]any{
		"group":  "admins",
		"groups": []any{"users", 7, "admins"},
		"num":    3.0,
		"realm_access": map[string]any{
			"roles": []any{"x", "sudoku-admin"},
			"flat":  "sudoku-admin",
		},
	}
	tests := []struct {
		name   string
		claims map[string]any
		path   string
		values []string
		want   bool
	}{
		{"string match", claims, "group", []string{"admins"}, true},
		{"string no match", claims, "group", []string{"other"}, false},
		{"list match", claims, "groups", []string{"nope", "admins"}, true},
		{"list no match", claims, "groups", []string{"nope"}, false},
		{"list non-string element", claims, "groups", []string{"7"}, false},
		{"nested list", claims, "realm_access.roles", []string{"sudoku-admin"}, true},
		{"nested string", claims, "realm_access.flat", []string{"sudoku-admin"}, true},
		{"missing top", claims, "nothing", []string{"admins"}, false},
		{"missing nested", claims, "realm_access.nothing", []string{"x"}, false},
		{"path through non-map", claims, "group.sub", []string{"admins"}, false},
		{"wrong type", claims, "num", []string{"3"}, false},
		{"empty path", claims, "", []string{"admins"}, false},
		{"no values", claims, "group", nil, false},
		{"nil claims", nil, "group", []string{"admins"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HasClaimValue(tt.claims, tt.path, tt.values); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBearerToken(t *testing.T) {
	tests := []struct {
		header, want string
		ok           bool
	}{
		{"Bearer abc", "abc", true},
		{"bearer abc", "abc", true},
		{"Bearer dev:alice:Alice Smith", "dev:alice:Alice Smith", true},
		{"Basic abc", "", false},
		{"Bearer ", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", tt.header)
		got, ok := BearerToken(r)
		if got != tt.want || ok != tt.ok {
			t.Errorf("BearerToken(%q) = %q, %v", tt.header, got, ok)
		}
	}
}
