package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/config"
	"github.com/jesserockz/sudoku/server/internal/store"
)

const testSecret = "test-secret-0123456789"

func testConfig() config.Config {
	cfg := config.Default()
	cfg.Auth.Mode = config.AuthModeDev
	cfg.ServerSecret = testSecret
	// The week and result tests are written against Auckland's boundaries.
	cfg.Timezone = "Pacific/Auckland"
	return cfg
}

// newTestServer starts a server with deps. Unset deps get test defaults:
// testConfig, a temp-file store and dev auth.
func newTestServer(t *testing.T, deps Deps) *httptest.Server {
	t.Helper()
	if deps.Config.ServerSecret == "" {
		deps.Config = testConfig()
	}
	if deps.Store == nil {
		deps.Store = newTestStore(t)
	}
	if deps.Verifier == nil {
		deps.Verifier = auth.Dev{}
	}
	srv := httptest.NewServer(New(deps).Handler())
	t.Cleanup(srv.Close)
	return srv
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// do sends a request with an optional bearer token and JSON body.
func do(t *testing.T, srv *httptest.Server, method, path, token string, body any) *http.Response {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// expectError checks status and error code, consuming the body.
func expectError(t *testing.T, resp *http.Response, status int, code string) {
	t.Helper()
	if resp.StatusCode != status {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("status = %d, want %d; body %s", resp.StatusCode, status, b)
	}
	if body := decode[errorBody](t, resp); body.Error.Code != code {
		t.Errorf("code = %q, want %q", body.Error.Code, code)
	}
}

const alice = "dev:alice:Alice"

func decode[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	defer resp.Body.Close()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return v
}

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func TestHealthz(t *testing.T) {
	srv := newTestServer(t, Deps{})
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q", ct)
	}
	body := decode[map[string]string](t, resp)
	if body["status"] != "ok" {
		t.Errorf("body = %v", body)
	}
}

func TestUnknownRouteIsJSON404(t *testing.T) {
	srv := newTestServer(t, Deps{})
	resp, err := http.Get(srv.URL + "/api/v1/nope")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if body := decode[errorBody](t, resp); body.Error.Code != "not_found" {
		t.Errorf("code = %q", body.Error.Code)
	}
}

func TestWrongMethodIsJSON405(t *testing.T) {
	srv := newTestServer(t, Deps{})
	resp, err := http.Post(srv.URL+"/healthz", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if allow := resp.Header.Get("Allow"); allow == "" {
		t.Error("missing Allow header")
	}
	if body := decode[errorBody](t, resp); body.Error.Code != "method_not_allowed" {
		t.Errorf("code = %q", body.Error.Code)
	}
}
