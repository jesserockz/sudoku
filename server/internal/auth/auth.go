// Package auth turns a bearer token into a caller identity, either by
// verifying an OIDC access token (JWT) or, in dev mode, by trusting it.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// ErrInvalidToken means the token was rejected; callers should answer 401.
// ErrUnavailable means it couldn't be checked for now (503). Any other error
// from Verify is a server-side fault. Neither should make clients drop their
// tokens.
var ErrInvalidToken = errors.New("invalid token")

// Identity is the caller as established by a verified token.
type Identity struct {
	// Subject is the stable key for the local user record.
	Subject     string
	DisplayName string
	// Claims is the token's full claim set, for authorization decisions.
	Claims map[string]any
}

type Verifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// BearerToken extracts the token from an "Authorization: Bearer" header.
func BearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

func displayName(name, preferredUsername, sub string) string {
	for _, s := range []string{name, preferredUsername} {
		if s = strings.TrimSpace(s); s != "" {
			return s
		}
	}
	return sub
}

// HasClaimValue reports whether the claim at the dot-separated path holds one
// of values: either as a string or as an element of a list of strings.
// Missing claims, wrong types and empty paths or value lists never match.
func HasClaimValue(claims map[string]any, path string, values []string) bool {
	if path == "" || len(values) == 0 {
		return false
	}
	var cur any = claims
	for _, key := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		if cur, ok = m[key]; !ok {
			return false
		}
	}
	switch v := cur.(type) {
	case string:
		return slices.Contains(values, v)
	case []any:
		return slices.ContainsFunc(v, func(e any) bool {
			s, ok := e.(string)
			return ok && slices.Contains(values, s)
		})
	}
	return false
}

// Dev trusts tokens of the form "dev:<sub>:<display name>". Its claims are
// just sub and name, so dev mode admin is configured with claim "sub".
// Never use it in production. Dev subjects are stored as "dev:<sub>" so they
// can never collide with OIDC users in the same database.
type Dev struct{}

func (Dev) Verify(_ context.Context, token string) (Identity, error) {
	parts := strings.SplitN(token, ":", 3)
	if len(parts) < 2 || parts[0] != "dev" || strings.TrimSpace(parts[1]) == "" {
		return Identity{}, fmt.Errorf("%w: dev tokens look like dev:<sub>:<display name>", ErrInvalidToken)
	}
	sub := strings.TrimSpace(parts[1])
	name := ""
	if len(parts) == 3 {
		name = parts[2]
	}
	claims := map[string]any{"sub": sub, "name": name}
	return Identity{Subject: "dev:" + sub, DisplayName: displayName(name, "", sub), Claims: claims}, nil
}

// OIDC verifies JWT access tokens: signature against the issuer's JWKS,
// iss, aud (any of Audience) and exp. The keys are fetched from the issuer on
// first use (so the server starts even if the issuer is down) and saved in
// Cache, so after a restart tokens verify without the issuer. Only a token
// signed with a key the server has never seen needs the issuer; while it is
// down such a token gets ErrUnavailable.
type OIDC struct {
	Issuer   string
	Audience []string
	// Now overrides the clock for exp checks and key ages (tests).
	Now func() time.Time
	// HTTPClient is used for discovery and JWKS fetches.
	HTTPClient *http.Client
	// Cache, when set, keeps the keys across restarts.
	Cache KeyCache
	// MaxAge is how old the keys get before a background refresh (default 1 hour).
	MaxAge time.Duration
	// MinInterval is the least time between fetches, so unknown key ids
	// can't hammer the issuer (default 1 minute).
	MinInterval time.Duration

	mu         sync.Mutex
	loaded     bool
	keys       *keySet
	lastFetch  time.Time
	lastErr    error
	refreshing bool
	fetchMu    sync.Mutex
	background sync.WaitGroup
}

func (o *OIDC) Verify(ctx context.Context, token string) (Identity, error) {
	kid, err := keyID(token)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	keys, err := o.keysFor(ctx, kid)
	if err != nil {
		return Identity{}, err
	}
	tok, err := keys.verifier.Verify(ctx, token)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if !slices.ContainsFunc(tok.Audience, func(a string) bool { return slices.Contains(o.Audience, a) }) {
		return Identity{}, fmt.Errorf("%w: audience %q not accepted", ErrInvalidToken, tok.Audience)
	}
	if tok.Subject == "" {
		return Identity{}, fmt.Errorf("%w: missing sub", ErrInvalidToken)
	}
	// Verify already decoded the payload as a JSON object, so this cannot fail.
	var all map[string]any
	_ = tok.Claims(&all)
	name, _ := all["name"].(string)
	preferred, _ := all["preferred_username"].(string)
	return Identity{
		Subject:     tok.Subject,
		DisplayName: displayName(name, preferred, tok.Subject),
		Claims:      all,
	}, nil
}

func discoverJWKS(ctx context.Context, client *http.Client, issuer string) (string, error) {
	url := strings.TrimSuffix(issuer, "/") + "/.well-known/openid-configuration"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("oidc discovery: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oidc discovery: %s returned %s", url, resp.Status)
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return "", fmt.Errorf("oidc discovery: %w", err)
	}
	if doc.Issuer != issuer {
		return "", fmt.Errorf("oidc discovery: issuer %q does not match configured %q", doc.Issuer, issuer)
	}
	if doc.JWKSURI == "" {
		return "", errors.New("oidc discovery: no jwks_uri")
	}
	return doc.JWKSURI, nil
}
