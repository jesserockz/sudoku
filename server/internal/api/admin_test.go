package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/update"
)

const adminToken = "dev:ann:Ann"

func adminConfig() Deps {
	cfg := testConfig()
	cfg.Admin.Claim = "sub"
	cfg.Admin.Values = []string{"ann"}
	return Deps{Config: cfg}
}

// claimsVerifier trusts any token and returns fixed claims.
type claimsVerifier map[string]any

func (c claimsVerifier) Verify(context.Context, string) (auth.Identity, error) {
	return auth.Identity{Subject: "sub1", DisplayName: "Sub One", Claims: c}, nil
}

func TestAdminGate(t *testing.T) {
	routes := []struct{ method, path string }{
		{"GET", "/api/v1/admin/releases"},
		{"GET", "/api/v1/admin/update"},
		{"POST", "/api/v1/admin/update"},
		{"POST", "/api/v1/admin/rollback"},
	}
	t.Run("dev tokens", func(t *testing.T) {
		srv := newTestServer(t, adminConfig())
		for _, rt := range routes {
			// No token: 401, not 403.
			expectError(t, do(t, srv, rt.method, rt.path, "", nil), http.StatusUnauthorized, "unauthorized")
			// Wrong sub.
			expectError(t, do(t, srv, rt.method, rt.path, alice, nil), http.StatusForbidden, "forbidden")
			// Claim absent from the token.
			noClaim := adminConfig()
			noClaim.Config.Admin.Claim = "groups"
			expectError(t, do(t, newTestServer(t, noClaim), rt.method, rt.path, adminToken, nil), http.StatusForbidden, "forbidden")
			// The right value lets the request through to the handler, which
			// without an updater answers 409.
			expectError(t, do(t, srv, rt.method, rt.path, adminToken, nil), http.StatusConflict, "update_unavailable")
		}
	})

	t.Run("unset config means nobody", func(t *testing.T) {
		srv := newTestServer(t, Deps{})
		for _, rt := range routes {
			expectError(t, do(t, srv, rt.method, rt.path, adminToken, nil), http.StatusForbidden, "forbidden")
		}
		me := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", adminToken, nil))
		if me.Admin {
			t.Error("admin with no admin config")
		}
	})

	t.Run("nested and list claims", func(t *testing.T) {
		deps := adminConfig()
		deps.Config.Admin.Claim = "realm_access.roles"
		deps.Config.Admin.Values = []string{"sudoku-admin"}
		for name, tt := range map[string]struct {
			claims map[string]any
			status int
		}{
			"nested list":   {map[string]any{"realm_access": map[string]any{"roles": []any{"x", "sudoku-admin"}}}, http.StatusConflict},
			"nested string": {map[string]any{"realm_access": map[string]any{"roles": "sudoku-admin"}}, http.StatusConflict},
			"wrong role":    {map[string]any{"realm_access": map[string]any{"roles": []any{"x"}}}, http.StatusForbidden},
			"flat claim":    {map[string]any{"realm_access.roles": []any{"sudoku-admin"}}, http.StatusForbidden},
		} {
			t.Run(name, func(t *testing.T) {
				d := deps
				d.Verifier = claimsVerifier(tt.claims)
				srv := newTestServer(t, d)
				resp := do(t, srv, "GET", "/api/v1/admin/update", "any", nil)
				if resp.StatusCode != tt.status {
					t.Errorf("status = %d, want %d", resp.StatusCode, tt.status)
				}
				resp.Body.Close()
			})
		}
	})
}

func TestMeAdmin(t *testing.T) {
	srv := newTestServer(t, adminConfig())
	if me := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", adminToken, nil)); !me.Admin || me.DisplayName != "Ann" {
		t.Errorf("admin me = %+v", me)
	}
	if me := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", alice, nil)); me.Admin {
		t.Errorf("non-admin me = %+v", me)
	}
	// The field is always present.
	resp := do(t, srv, "GET", "/api/v1/me", alice, nil)
	raw := decode[map[string]any](t, resp)
	if v, ok := raw["admin"]; !ok || v != false {
		t.Errorf("me JSON = %v", raw)
	}
}

// stubUpdater lets handlers be driven with arbitrary results.
type stubUpdater struct {
	err error
}

func (s stubUpdater) Info() update.Info     { return update.Info{} }
func (s stubUpdater) Status() update.Status { return update.Status{State: "idle"} }
func (s stubUpdater) Releases(context.Context, bool) ([]update.Release, error) {
	return nil, s.err
}
func (s stubUpdater) Start(context.Context, string, bool) (update.Status, error) {
	return update.Status{}, s.err
}
func (s stubUpdater) Rollback() (update.Status, error) { return update.Status{}, s.err }

func TestAdminErrorMapping(t *testing.T) {
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{update.ErrInvalidTag, 400, "bad_request"},
		{update.ErrBusy, 409, "update_in_progress"},
		{update.ErrUnavailable, 409, "update_unavailable"},
		{update.ErrDowngrade, 409, "downgrade_not_confirmed"},
		{update.ErrNotFound, 404, "release_not_found"},
		{update.ErrUpstream, 502, "upstream_error"},
		{errors.New("disk exploded"), 500, "internal"},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			deps := adminConfig()
			deps.Updater = stubUpdater{err: tt.err}
			srv := newTestServer(t, deps)
			for _, call := range []struct {
				method, path string
				body         any
			}{
				{"GET", "/api/v1/admin/releases", nil},
				{"POST", "/api/v1/admin/update", updateRequest{Tag: "v1.0.0"}},
				{"POST", "/api/v1/admin/rollback", nil},
			} {
				expectError(t, do(t, srv, call.method, call.path, adminToken, call.body), tt.status, tt.code)
			}
		})
	}
}

func TestAdminUpdateBadBody(t *testing.T) {
	deps := adminConfig()
	deps.Updater = stubUpdater{}
	srv := newTestServer(t, deps)
	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/admin/update", strings.NewReader("{nope"))
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	expectError(t, resp, http.StatusBadRequest, "bad_request")
}

// fakeGitHub serves two releases of the linux/amd64 binary.
func fakeGitHub(t *testing.T) *httptest.Server {
	t.Helper()
	sum := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	sums := sum("binary-2") + "  sudoku-server-linux-amd64\n"
	content := map[string]string{"/storage/11": "binary-2", "/storage/12": sums}
	rel := func(tag string, prerelease bool) map[string]any {
		return map[string]any{
			"tag_name": tag, "name": tag, "published_at": "2026-10-30T01:02:03Z", "prerelease": prerelease,
			"html_url": "https://github.com/jesserockz/sudoku/releases/tag/" + tag,
			"assets": []map[string]any{
				{"id": 11, "name": "sudoku-server-linux-amd64", "size": 8},
				{"id": 12, "name": "SHA256SUMS", "size": len(sums)},
			},
		}
	}
	releases := []map[string]any{rel("v2.0.0", false), rel("v1.5.0-rc.1", true), rel("v1.0.0", false)}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/owner/repo/releases", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(releases)
	})
	mux.HandleFunc("/repos/owner/repo/releases/tags/", func(w http.ResponseWriter, r *http.Request) {
		tag := strings.TrimPrefix(r.URL.Path, "/repos/owner/repo/releases/tags/")
		for _, rl := range releases {
			if rl["tag_name"] == tag {
				json.NewEncoder(w).Encode(rl)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/repos/owner/repo/releases/assets/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/storage/"+strings.TrimPrefix(r.URL.Path, "/repos/owner/repo/releases/assets/"), http.StatusFound)
	})
	mux.HandleFunc("/storage/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(content[r.URL.Path])) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestAdminUpdateFlow(t *testing.T) {
	gh := fakeGitHub(t)
	dir := t.TempDir()
	exe := filepath.Join(dir, "sudoku-server")
	if err := os.WriteFile(exe, []byte("binary-1"), 0o755); err != nil {
		t.Fatal(err)
	}
	restarted := make(chan struct{}, 1)
	deps := adminConfig()
	deps.Updater = &update.Updater{
		APIBase: gh.URL, Repo: "owner/repo", ExePath: exe, GOOS: "linux", GOARCH: "amd64",
		CurrentVersion: "1.0.0", Restart: func() { restarted <- struct{}{} },
	}
	srv := newTestServer(t, deps)

	// Releases: prereleases hidden by default.
	list := decode[releasesResponse](t, do(t, srv, "GET", "/api/v1/admin/releases", adminToken, nil))
	if list.Current != (update.Info{Version: "1.0.0", OS: "linux", Arch: "amd64", Asset: "sudoku-server-linux-amd64"}) {
		t.Errorf("current = %+v", list.Current)
	}
	if len(list.Releases) != 2 || list.Releases[0].Tag != "v2.0.0" || !list.Releases[0].Latest ||
		list.Releases[0].Comparison != "newer" || !list.Releases[0].Installable ||
		!list.Releases[1].Current || list.Releases[1].Comparison != "same" {
		t.Errorf("releases = %+v", list.Releases)
	}
	if list.Update.State != "idle" || list.Update.RollbackAvailable {
		t.Errorf("update = %+v", list.Update)
	}
	withPre := decode[releasesResponse](t, do(t, srv, "GET", "/api/v1/admin/releases?prereleases=true", adminToken, nil))
	if len(withPre.Releases) != 3 {
		t.Errorf("with prereleases: %d releases", len(withPre.Releases))
	}

	// Refusals.
	expectError(t, do(t, srv, "POST", "/api/v1/admin/update", adminToken, updateRequest{Tag: "latest"}), 400, "bad_request")
	expectError(t, do(t, srv, "POST", "/api/v1/admin/update", adminToken, updateRequest{Tag: "v9.9.9"}), 404, "release_not_found")
	expectError(t, do(t, srv, "POST", "/api/v1/admin/update", adminToken, updateRequest{Tag: "v1.0.0"}), 409, "downgrade_not_confirmed")
	expectError(t, do(t, srv, "POST", "/api/v1/admin/rollback", adminToken, nil), 409, "update_unavailable")

	// Update.
	resp := do(t, srv, "POST", "/api/v1/admin/update", adminToken, updateRequest{Tag: "v2.0.0"})
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if st := decode[update.Status](t, resp); st.Action != "update" || st.Target != "v2.0.0" {
		t.Errorf("status = %+v", st)
	}
	select {
	case <-restarted:
	case <-time.After(10 * time.Second):
		t.Fatal("restart not requested")
	}
	st := decode[update.Status](t, do(t, srv, "GET", "/api/v1/admin/update", adminToken, nil))
	if st.State != "restarting" || !st.RollbackAvailable || st.FinishedAt == nil {
		t.Errorf("status = %+v", st)
	}
	if b, _ := os.ReadFile(exe); string(b) != "binary-2" {
		t.Errorf("binary = %q", b)
	}

	// Roll back.
	resp = do(t, srv, "POST", "/api/v1/admin/rollback", adminToken, nil)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("rollback status = %d", resp.StatusCode)
	}
	if rs := decode[update.Status](t, resp); rs.Action != "rollback" {
		t.Errorf("rollback status = %+v", rs)
	}
	select {
	case <-restarted:
	case <-time.After(10 * time.Second):
		t.Fatal("restart not requested after rollback")
	}
	if b, _ := os.ReadFile(exe); string(b) != "binary-1" {
		t.Errorf("binary after rollback = %q", b)
	}
}

func TestAdminReleasesUpstreamDown(t *testing.T) {
	gh := fakeGitHub(t)
	gh.Close()
	deps := adminConfig()
	deps.Updater = &update.Updater{APIBase: gh.URL, Repo: "owner/repo", ExePath: filepath.Join(t.TempDir(), "x")}
	srv := newTestServer(t, deps)
	expectError(t, do(t, srv, "GET", "/api/v1/admin/releases", adminToken, nil), http.StatusBadGateway, "upstream_error")
}
