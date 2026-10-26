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

	"github.com/coreos/go-oidc/v3/oidc"
)

// ErrInvalidToken means the token was rejected; callers should answer 401.
// Any other error from Verify is a server-side fault (e.g. the issuer is
// unreachable) and should not make clients drop their tokens.
var ErrInvalidToken = errors.New("invalid token")

// Identity is the caller as established by a verified token.
type Identity struct {
	// Subject is the stable key for the local user record.
	Subject     string
	DisplayName string
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

// Dev trusts tokens of the form "dev:<sub>:<display name>". Never use it in
// production. Dev subjects are stored as "dev:<sub>" so they can never
// collide with OIDC users in the same database.
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
	return Identity{Subject: "dev:" + sub, DisplayName: displayName(name, "", sub)}, nil
}

// OIDC verifies JWT access tokens: signature against the issuer's JWKS,
// iss, aud (any of Audience) and exp. The JWKS location is discovered from
// the issuer on first use, so the server starts even if the issuer is down.
type OIDC struct {
	Issuer   string
	Audience []string
	// Now overrides the clock for exp checks (tests).
	Now func() time.Time
	// HTTPClient is used for discovery and JWKS fetches.
	HTTPClient *http.Client

	mu       sync.Mutex
	verifier *oidc.IDTokenVerifier
}

func (o *OIDC) Verify(ctx context.Context, token string) (Identity, error) {
	v, err := o.getVerifier(ctx)
	if err != nil {
		return Identity{}, err
	}
	tok, err := v.Verify(ctx, token)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if !slices.ContainsFunc(tok.Audience, func(a string) bool { return slices.Contains(o.Audience, a) }) {
		return Identity{}, fmt.Errorf("%w: audience %q not accepted", ErrInvalidToken, tok.Audience)
	}
	if tok.Subject == "" {
		return Identity{}, fmt.Errorf("%w: missing sub", ErrInvalidToken)
	}
	var claims struct {
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := tok.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	return Identity{
		Subject:     tok.Subject,
		DisplayName: displayName(claims.Name, claims.PreferredUsername, tok.Subject),
	}, nil
}

func (o *OIDC) getVerifier(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.verifier != nil {
		return o.verifier, nil
	}
	client := o.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	jwksURL, err := discoverJWKS(ctx, client, o.Issuer)
	if err != nil {
		return nil, err
	}
	// The key set outlives this request, so give it a background context
	// carrying only the HTTP client.
	keyCtx := oidc.ClientContext(context.Background(), client)
	o.verifier = oidc.NewVerifier(o.Issuer, oidc.NewRemoteKeySet(keyCtx, jwksURL), &oidc.Config{
		SkipClientIDCheck:    true, // we check aud against a list ourselves
		SupportedSigningAlgs: []string{"RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "PS256", "EdDSA"},
		Now:                  o.Now,
	})
	return o.verifier, nil
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
