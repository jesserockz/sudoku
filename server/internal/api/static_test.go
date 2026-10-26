package api

import (
	"io"
	"net/http"
	"testing"
)

func TestStaticNeverShadowsAPI(t *testing.T) {
	webHit := false
	webStub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webHit = true
		io.WriteString(w, "WEB")
	})
	srv := newTestServer(t, Deps{Web: webStub})

	for _, path := range []string{"/", "/leaderboard", "/play/1", "/apiary", "/healthzz"} {
		webHit = false
		resp := do(t, srv, "GET", path, "", nil)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != "WEB" || !webHit {
			t.Errorf("GET %s = %d %q, want web client", path, resp.StatusCode, body)
		}
	}

	for _, path := range []string{"/api", "/api/", "/api/v1/nope", "/api/v2/week"} {
		webHit = false
		expectError(t, do(t, srv, "GET", path, alice, nil), http.StatusNotFound, "not_found")
		if webHit {
			t.Errorf("GET %s reached the web client", path)
		}
	}

	// Real routes still win, and wrong methods are still 405, not the web client.
	resp := do(t, srv, "GET", "/healthz", "", nil)
	if resp.StatusCode != 200 || decode[map[string]string](t, resp)["status"] != "ok" {
		t.Error("healthz shadowed")
	}
	resp = do(t, srv, "GET", "/api/v1/config", "", nil)
	if resp.StatusCode != 200 {
		t.Errorf("config status = %d", resp.StatusCode)
	}
	resp.Body.Close()
	expectError(t, do(t, srv, "POST", "/api/v1/week", alice, nil), http.StatusMethodNotAllowed, "method_not_allowed")
	expectError(t, do(t, srv, "POST", "/leaderboard", "", nil), http.StatusMethodNotAllowed, "method_not_allowed")
	expectError(t, do(t, srv, "GET", "/api/v1/me", "", nil), http.StatusUnauthorized, "unauthorized")
}

func TestNoWebDirMeans404(t *testing.T) {
	srv := newTestServer(t, Deps{})
	expectError(t, do(t, srv, "GET", "/", "", nil), http.StatusNotFound, "not_found")
}
