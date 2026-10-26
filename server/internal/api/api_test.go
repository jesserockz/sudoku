package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/config"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := config.Default()
	cfg.Auth.Mode = config.AuthModeDev
	srv := httptest.NewServer(New(Deps{Config: cfg}).Handler())
	t.Cleanup(srv.Close)
	return srv
}

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
	srv := newTestServer(t)
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
	srv := newTestServer(t)
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
	srv := newTestServer(t)
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
