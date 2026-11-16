package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memCache is a KeyCache in memory. loadErr and saveErr make it fail.
type memCache struct {
	mu      sync.Mutex
	data    map[string][]byte
	loadErr error
	saveErr error
	saves   int
}

func (c *memCache) LoadOIDCKeys(_ context.Context, issuer string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loadErr != nil {
		return nil, c.loadErr
	}
	return c.data[issuer], nil
}

func (c *memCache) SaveOIDCKeys(_ context.Context, issuer string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.saves++
	if c.saveErr != nil {
		return c.saveErr
	}
	if c.data == nil {
		c.data = map[string][]byte{}
	}
	c.data[issuer] = data
	return nil
}

// clock is a settable time source.
type clock struct{ t atomic.Pointer[time.Time] }

func newClock() *clock {
	c := &clock{}
	c.set(testNow)
	return c
}

func (c *clock) now() time.Time      { return *c.t.Load() }
func (c *clock) set(t time.Time)     { c.t.Store(&t) }
func (c *clock) add(d time.Duration) { c.set(c.now().Add(d)) }

func (ti *testIssuer) cached(cache KeyCache, clk *clock) *OIDC {
	return &OIDC{Issuer: ti.Issuer(), Audience: []string{"sudoku-web"}, Now: clk.now, Cache: cache}
}

// claimsAt are valid claims for a token checked at now.
func (ti *testIssuer) claimsAt(now time.Time) map[string]any {
	return ti.claims(map[string]any{"exp": now.Add(time.Hour).Unix(), "iat": now.Add(-time.Minute).Unix()})
}

func mustVerify(t *testing.T, v *OIDC, token string) {
	t.Helper()
	if _, err := v.Verify(context.Background(), token); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func wantErr(t *testing.T, v *OIDC, token string, want error) {
	t.Helper()
	_, err := v.Verify(context.Background(), token)
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
	if want == ErrUnavailable && errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v is also ErrInvalidToken", err)
	}
}

func TestOIDCRestartWhileIssuerDown(t *testing.T) {
	ti := newTestIssuer(t)
	cache, clk := &memCache{}, newClock()
	token := sign(t, ti.key, "k1", ti.claimsAt(clk.now()))
	mustVerify(t, ti.cached(cache, clk), token)
	if cache.saves != 1 {
		t.Fatalf("saves = %d, want 1", cache.saves)
	}

	// The server restarts while the issuer is down: the saved keys still verify.
	ti.down.Store(true)
	fetches := ti.discovery.Load()
	restarted := ti.cached(cache, clk)
	mustVerify(t, restarted, token)
	if ti.discovery.Load() != fetches {
		t.Error("a known key went to the issuer")
	}
	// Expired tokens, other issuers and audiences are still rejected.
	wantErr(t, restarted, sign(t, ti.key, "k1", ti.claims(map[string]any{"exp": testNow.Add(-time.Second).Unix()})), ErrInvalidToken)
	wantErr(t, restarted, sign(t, ti.key, "k1", ti.claims(map[string]any{"iss": "https://evil.example.com/"})), ErrInvalidToken)
	wantErr(t, restarted, sign(t, ti.key, "k1", ti.claims(map[string]any{"aud": "someone-else"})), ErrInvalidToken)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	wantErr(t, restarted, sign(t, other, "k1", ti.claims(nil)), ErrInvalidToken)
}

func TestOIDCIssuerDownMidRun(t *testing.T) {
	ti := newTestIssuer(t)
	cache, clk := &memCache{}, newClock()
	v := ti.cached(cache, clk)
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))

	// Down, and the keys have aged: they keep working while a background refresh fails.
	ti.down.Store(true)
	clk.add(2 * time.Hour)
	jwks := ti.discovery.Load()
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))
	v.background.Wait()
	if ti.discovery.Load() != jwks+1 {
		t.Fatalf("discovery = %d, want one background attempt", ti.discovery.Load()-jwks)
	}
	// Within MinInterval of that failure, no new attempt.
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))
	v.background.Wait()
	if ti.discovery.Load() != jwks+1 {
		t.Error("refreshed again within MinInterval")
	}

	// Back up: the next refresh replaces and saves the keys.
	ti.down.Store(false)
	clk.add(2 * time.Minute)
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))
	v.background.Wait()
	if cache.saves != 2 {
		t.Errorf("saves = %d, want 2", cache.saves)
	}
	// Fresh keys don't refresh.
	before := ti.discovery.Load()
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))
	v.background.Wait()
	if ti.discovery.Load() != before {
		t.Error("fresh keys were refreshed")
	}
}

func TestOIDCUnknownKeyID(t *testing.T) {
	ti := newTestIssuer(t)
	cache, clk := &memCache{}, newClock()
	v := ti.cached(cache, clk)
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))
	rotated, _ := rsa.GenerateKey(rand.Reader, 2048)

	// A kid that isn't published, just after a fetch: rejected without asking again.
	fetches := ti.jwks.Load()
	wantErr(t, v, sign(t, rotated, "k2", ti.claimsAt(clk.now())), ErrInvalidToken)
	if ti.jwks.Load() != fetches {
		t.Error("fetched again within MinInterval")
	}

	// The issuer rotates in k2: after MinInterval its tokens fetch the new keys.
	ti.extra.Store(rotated)
	clk.add(2 * time.Minute)
	mustVerify(t, v, sign(t, rotated, "k2", ti.claimsAt(clk.now())))
	if ti.jwks.Load() != fetches+1 {
		t.Errorf("jwks fetches = %d, want 1", ti.jwks.Load()-fetches)
	}
	mustVerify(t, v, sign(t, ti.key, "k1", ti.claimsAt(clk.now())))

	// A new kid while the issuer is down can't be checked: unavailable, then
	// unavailable without asking again within MinInterval.
	ti.down.Store(true)
	clk.add(2 * time.Minute)
	wantErr(t, v, sign(t, rotated, "k3", ti.claimsAt(clk.now())), ErrUnavailable)
	fetches = ti.discovery.Load()
	wantErr(t, v, sign(t, rotated, "k3", ti.claimsAt(clk.now())), ErrUnavailable)
	if ti.discovery.Load() != fetches {
		t.Error("asked the issuer again within MinInterval")
	}
	// Known keys still work.
	mustVerify(t, v, sign(t, rotated, "k2", ti.claimsAt(clk.now())))
}

func TestOIDCTokenWithoutKeyID(t *testing.T) {
	ti := newTestIssuer(t)
	v := ti.cached(nil, newClock())
	mustVerify(t, v, sign(t, ti.key, "", ti.claims(nil)))
}

func TestOIDCCorruptCache(t *testing.T) {
	ti := newTestIssuer(t)
	clk := newClock()
	good := &memCache{}
	mustVerify(t, ti.cached(good, clk), sign(t, ti.key, "k1", ti.claims(nil)))
	var saved savedKeys
	if err := json.Unmarshal(good.data[ti.Issuer()], &saved); err != nil {
		t.Fatal(err)
	}
	with := func(f func(*savedKeys)) []byte {
		s := saved
		f(&s)
		b, _ := json.Marshal(s)
		return b
	}
	tests := []struct {
		name  string
		cache *memCache
	}{
		{"not json", &memCache{data: map[string][]byte{ti.Issuer(): []byte("{")}}},
		{"no jwks uri", &memCache{data: map[string][]byte{ti.Issuer(): with(func(s *savedKeys) { s.JWKSURI = "" })}}},
		{"bad jwks", &memCache{data: map[string][]byte{ti.Issuer(): with(func(s *savedKeys) { s.JWKS = json.RawMessage(`{"keys":1}`) })}}},
		{"no signing keys", &memCache{data: map[string][]byte{ti.Issuer(): with(func(s *savedKeys) { s.JWKS = json.RawMessage(`{"keys":[]}`) })}}},
		{"load fails", &memCache{loadErr: errors.New("disk on fire")}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The bad cache is ignored and the keys fetched instead.
			fetches := ti.jwks.Load()
			mustVerify(t, ti.cached(tt.cache, clk), sign(t, ti.key, "k1", ti.claims(nil)))
			if ti.jwks.Load() != fetches+1 {
				t.Error("keys were not fetched")
			}
			if tt.cache.loadErr == nil && string(tt.cache.data[ti.Issuer()]) == "{" {
				t.Error("the fetched keys did not replace the bad ones")
			}
		})
	}
	// A bad cache while the issuer is down: unavailable rather than invalid.
	ti.down.Store(true)
	wantErr(t, ti.cached(&memCache{data: map[string][]byte{ti.Issuer(): []byte("{")}}, clk), sign(t, ti.key, "k1", ti.claims(nil)), ErrUnavailable)
}

func TestOIDCSaveFailureStillVerifies(t *testing.T) {
	ti := newTestIssuer(t)
	cache := &memCache{saveErr: errors.New("read-only")}
	mustVerify(t, ti.cached(cache, newClock()), sign(t, ti.key, "k1", ti.claims(nil)))
	if cache.saves != 1 {
		t.Errorf("saves = %d", cache.saves)
	}
}

func TestOIDCBadKeySets(t *testing.T) {
	jwks := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }
	}
	tests := []struct {
		name    string
		handler http.HandlerFunc
		uri     string
		want    string
	}{
		{"error status", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }, "", "500"},
		{"not json", jwks("nope"), "", "oidc jwks"},
		{"only encryption and symmetric keys", jwks(`{"keys":[{"kty":"oct","k":"c2VjcmV0","kid":"s"},` +
			`{"kty":"RSA","use":"enc","kid":"e","n":"sXch","e":"AQAB"}]}`), "", "no signing keys"},
		{"cut off", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", "100")
			w.Write([]byte(`{"keys":`))
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		}, "", "oidc jwks"},
		{"bad uri", nil, "://nope", "oidc jwks"},
		{"unreachable", nil, "http://127.0.0.1:1/jwks", "oidc jwks"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ti := newTestIssuer(t)
			if tt.handler != nil {
				ti.jwksHandler.Store(&tt.handler)
			}
			if tt.uri != "" {
				ti.jwksURI.Store(&tt.uri)
			}
			_, err := ti.cached(nil, newClock()).Verify(context.Background(), sign(t, ti.key, "k1", ti.claims(nil)))
			if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want ErrUnavailable mentioning %q", err, tt.want)
			}
		})
	}
}

func TestOIDCDefaults(t *testing.T) {
	var o OIDC
	if o.maxAge() != time.Hour || o.minInterval() != time.Minute {
		t.Errorf("defaults = %v, %v", o.maxAge(), o.minInterval())
	}
	if d := time.Since(o.now()); d < 0 || d > time.Minute {
		t.Errorf("now() is %v off the wall clock", d)
	}
	o = OIDC{MaxAge: time.Second, MinInterval: time.Millisecond}
	if o.maxAge() != time.Second || o.minInterval() != time.Millisecond {
		t.Errorf("overrides = %v, %v", o.maxAge(), o.minInterval())
	}
}
