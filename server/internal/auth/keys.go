package auth

import (
	"context"
	"crypto"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

// ErrUnavailable means a token couldn't be checked because the issuer
// couldn't be reached and no saved key fits it. Callers should answer 503;
// clients should keep their tokens and try again later.
var ErrUnavailable = errors.New("sign-in unavailable")

// KeyCache saves the issuer's signing keys across restarts, so tokens signed
// with a known key still verify while the issuer is down.
type KeyCache interface {
	// LoadOIDCKeys returns what SaveOIDCKeys last saved for issuer, or nil.
	LoadOIDCKeys(ctx context.Context, issuer string) ([]byte, error)
	SaveOIDCKeys(ctx context.Context, issuer string, data []byte) error
}

const (
	defaultMaxAge      = time.Hour
	defaultMinInterval = time.Minute
	// maxJWKSBytes caps the key set response.
	maxJWKSBytes = 1 << 20
)

var signingAlgs = []jose.SignatureAlgorithm{
	jose.RS256, jose.RS384, jose.RS512, jose.ES256, jose.ES384, jose.ES512, jose.PS256, jose.EdDSA,
}

// savedKeys is what a KeyCache holds: the issuer's JWKS as fetched.
type savedKeys struct {
	JWKSURI   string          `json:"jwksUri"`
	JWKS      json.RawMessage `json:"jwks"`
	FetchedAt time.Time       `json:"fetchedAt"`
}

// keySet is a parsed savedKeys with a verifier that only uses its keys.
type keySet struct {
	saved    savedKeys
	kids     map[string]bool
	verifier *oidc.IDTokenVerifier
}

// has reports whether a token signed under kid can be checked with these
// keys. A token without a kid is tried against every key.
func (k *keySet) has(kid string) bool {
	return kid == "" || k.kids[kid]
}

// keyID returns the kid in a JWT's header.
func keyID(token string) (string, error) {
	jws, err := jose.ParseSigned(token, signingAlgs)
	if err != nil {
		return "", err
	}
	return jws.Signatures[0].Header.KeyID, nil
}

func (o *OIDC) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func (o *OIDC) maxAge() time.Duration {
	if o.MaxAge > 0 {
		return o.MaxAge
	}
	return defaultMaxAge
}

func (o *OIDC) minInterval() time.Duration {
	if o.MinInterval > 0 {
		return o.MinInterval
	}
	return defaultMinInterval
}

// keysFor returns keys that can check a token signed under kid. Known keys
// never wait for the issuer: once they are older than MaxAge a background
// refresh replaces them, and a failed refresh keeps them. An unknown kid
// (a rotated key, or no keys yet) fetches the keys now.
func (o *OIDC) keysFor(ctx context.Context, kid string) (*keySet, error) {
	o.load(ctx)
	o.mu.Lock()
	keys := o.keys
	if keys != nil && keys.has(kid) {
		now := o.now()
		if now.Sub(keys.saved.FetchedAt) >= o.maxAge() && !o.refreshing && now.Sub(o.lastFetch) >= o.minInterval() {
			o.refreshing = true
			o.background.Add(1)
			go o.refreshInBackground()
		}
		o.mu.Unlock()
		return keys, nil
	}
	o.mu.Unlock()
	keys, err := o.refresh(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if !keys.has(kid) {
		return nil, fmt.Errorf("%w: unknown key id %q", ErrInvalidToken, kid)
	}
	return keys, nil
}

func (o *OIDC) refreshInBackground() {
	defer o.background.Done()
	_, _ = o.refresh(context.Background())
	o.mu.Lock()
	o.refreshing = false
	o.mu.Unlock()
}

// load reads the saved keys, once. Missing or unreadable ones are ignored:
// the keys are then fetched on first use.
func (o *OIDC) load(ctx context.Context) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.loaded || o.Cache == nil {
		return
	}
	o.loaded = true
	data, err := o.Cache.LoadOIDCKeys(ctx, o.Issuer)
	if err != nil {
		slog.Warn("loading saved oidc keys", "err", err)
		return
	}
	if data == nil {
		return
	}
	var saved savedKeys
	if err := json.Unmarshal(data, &saved); err != nil {
		slog.Warn("ignoring saved oidc keys", "err", err)
		return
	}
	keys, err := o.parseKeys(saved)
	if err != nil {
		slog.Warn("ignoring saved oidc keys", "err", err)
		return
	}
	o.keys = keys
}

// refresh fetches the issuer's keys, at most once per MinInterval: a caller
// arriving sooner gets the outcome of the last fetch. On success the keys
// replace the current ones and are saved; on failure the current ones stay.
func (o *OIDC) refresh(ctx context.Context) (*keySet, error) {
	o.fetchMu.Lock()
	defer o.fetchMu.Unlock()
	o.mu.Lock()
	if !o.lastFetch.IsZero() && o.now().Sub(o.lastFetch) < o.minInterval() {
		keys, err := o.keys, o.lastErr
		o.mu.Unlock()
		return keys, err
	}
	o.mu.Unlock()

	keys, data, err := o.fetch(ctx)
	o.mu.Lock()
	o.lastFetch, o.lastErr = o.now(), err
	if err == nil {
		o.keys = keys
	}
	o.mu.Unlock()
	if err != nil {
		slog.Warn("fetching oidc keys failed; keeping any saved keys", "err", err)
		return nil, err
	}
	if o.Cache != nil {
		if err := o.Cache.SaveOIDCKeys(ctx, o.Issuer, data); err != nil {
			slog.Warn("saving oidc keys", "err", err)
		}
	}
	return keys, nil
}

// fetch discovers the JWKS and downloads it, returning the parsed keys and
// what to save.
func (o *OIDC) fetch(ctx context.Context) (*keySet, []byte, error) {
	client := o.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	jwksURI, err := discoverJWKS(ctx, client, o.Issuer)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURI, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("oidc jwks: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("oidc jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("oidc jwks: %s returned %s", jwksURI, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes))
	if err != nil {
		return nil, nil, fmt.Errorf("oidc jwks: %w", err)
	}
	saved := savedKeys{JWKSURI: jwksURI, JWKS: body, FetchedAt: o.now()}
	keys, err := o.parseKeys(saved)
	if err != nil {
		return nil, nil, err
	}
	// The JWKS parsed as JSON above, so this cannot fail.
	data, _ := json.Marshal(saved)
	return keys, data, nil
}

// parseKeys checks saved and builds a verifier over its signing keys.
func (o *OIDC) parseKeys(saved savedKeys) (*keySet, error) {
	if saved.JWKSURI == "" {
		return nil, errors.New("oidc jwks: no jwks_uri")
	}
	var set jose.JSONWebKeySet
	if err := json.Unmarshal(saved.JWKS, &set); err != nil {
		return nil, fmt.Errorf("oidc jwks: %w", err)
	}
	kids := map[string]bool{}
	var public []crypto.PublicKey
	for _, k := range set.Keys {
		pub := k.Public()
		if (k.Use != "" && k.Use != "sig") || !pub.Valid() {
			continue
		}
		kids[k.KeyID] = true
		public = append(public, pub.Key)
	}
	if len(public) == 0 {
		return nil, errors.New("oidc jwks: no signing keys")
	}
	algs := make([]string, len(signingAlgs))
	for i, a := range signingAlgs {
		algs[i] = string(a)
	}
	return &keySet{
		saved: saved,
		kids:  kids,
		verifier: oidc.NewVerifier(o.Issuer, &oidc.StaticKeySet{PublicKeys: public}, &oidc.Config{
			SkipClientIDCheck:    true, // we check aud against a list ourselves
			SupportedSigningAlgs: algs,
			Now:                  o.Now,
		}),
	}, nil
}
