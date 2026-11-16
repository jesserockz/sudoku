package api

import (
	"context"
	"database/sql"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/store"
)

type maintBody struct {
	Enabled bool    `json:"enabled"`
	Until   *string `json:"until"`
}

type maintError struct {
	Error struct {
		Code    string  `json:"code"`
		Message string  `json:"message"`
		Until   *string `json:"until"`
	} `json:"error"`
}

func putMaintenance(t *testing.T, e replayEnv, body any) maintBody {
	t.Helper()
	resp := do(t, e.srv, "PUT", "/api/v1/admin/maintenance", adminToken, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT maintenance status = %d", resp.StatusCode)
	}
	return decode[maintBody](t, resp)
}

func getMaintenance(t *testing.T, e replayEnv) maintBody {
	t.Helper()
	return decode[maintBody](t, do(t, e.srv, "GET", "/api/v1/admin/maintenance", adminToken, nil))
}

func configMaintenance(t *testing.T, e replayEnv) *maintenanceConfig {
	t.Helper()
	return decode[configResponse](t, do(t, e.srv, "GET", "/api/v1/config", "", nil)).Maintenance
}

func strp(s string) *string { return &s }

func TestAdminMaintenanceGate(t *testing.T) {
	srv := newTestServer(t, adminConfig())
	for _, method := range []string{"GET", "PUT"} {
		expectError(t, do(t, srv, method, "/api/v1/admin/maintenance", "", nil), http.StatusUnauthorized, "unauthorized")
		expectError(t, do(t, srv, method, "/api/v1/admin/maintenance", alice, nil), http.StatusForbidden, "forbidden")
	}
}

func TestAdminMaintenanceToggle(t *testing.T) {
	e := newReplayEnv(t, 5)
	if got := getMaintenance(t, e); got.Enabled || got.Until != nil {
		t.Fatalf("default = %+v", got)
	}
	if configMaintenance(t, e) != nil {
		t.Error("config reports maintenance while off")
	}

	// An offset time is normalised to UTC.
	got := putMaintenance(t, e, map[string]any{"enabled": true, "until": "2026-11-17T15:00:00+13:00"})
	if !got.Enabled || got.Until == nil || *got.Until != "2026-11-17T02:00:00Z" {
		t.Errorf("PUT = %+v", got)
	}
	if got := getMaintenance(t, e); !got.Enabled || *got.Until != "2026-11-17T02:00:00Z" {
		t.Errorf("GET = %+v", got)
	}
	if c := configMaintenance(t, e); c == nil || c.Until == nil || *c.Until != "2026-11-17T02:00:00Z" {
		t.Errorf("config maintenance = %+v", c)
	}

	// On without an end time: config carries a null until.
	putMaintenance(t, e, map[string]any{"enabled": true, "until": nil})
	if c := configMaintenance(t, e); c == nil || c.Until != nil {
		t.Errorf("config maintenance without end = %+v", c)
	}
	putMaintenance(t, e, map[string]any{"enabled": true})
	if got := getMaintenance(t, e); got.Until != nil {
		t.Errorf("missing until = %+v, want null", got)
	}

	// A past end is accepted and changes nothing: maintenance stays on.
	got = putMaintenance(t, e, map[string]any{"enabled": true, "until": "2001-01-01T00:00:00Z"})
	if !got.Enabled || *got.Until != "2001-01-01T00:00:00Z" {
		t.Errorf("past until = %+v", got)
	}
	expectError(t, do(t, e.srv, "GET", "/api/v1/me", alice, nil), http.StatusServiceUnavailable, "maintenance")

	// Off again.
	if got := putMaintenance(t, e, map[string]any{"enabled": false, "until": nil}); got.Enabled {
		t.Errorf("off = %+v", got)
	}
	if configMaintenance(t, e) != nil {
		t.Error("config reports maintenance after switching off")
	}
	if resp := do(t, e.srv, "GET", "/api/v1/me", alice, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("me after off = %d", resp.StatusCode)
	}
}

func TestAdminMaintenanceValidation(t *testing.T) {
	e := newReplayEnv(t, 5)
	putMaintenance(t, e, map[string]any{"enabled": true, "until": "2026-11-17T02:00:00Z"})
	for name, body := range map[string]any{
		"missing enabled": map[string]any{"until": nil},
		"null enabled":    map[string]any{"enabled": nil},
		"string enabled":  map[string]any{"enabled": "yes"},
		"no body":         nil,
		"bad until":       map[string]any{"enabled": false, "until": "tomorrow"},
		"empty until":     map[string]any{"enabled": false, "until": ""},
		"date only":       map[string]any{"enabled": false, "until": "2026-11-17"},
		"numeric until":   map[string]any{"enabled": false, "until": 5},
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/maintenance", adminToken, body), http.StatusBadRequest, "bad_request")
		})
	}
	if got := getMaintenance(t, e); !got.Enabled || *got.Until != "2026-11-17T02:00:00Z" {
		t.Errorf("a refused request changed it to %+v", got)
	}
}

func TestMaintenanceRefusesPlayers(t *testing.T) {
	e := newReplayEnv(t, 5)
	putMaintenance(t, e, map[string]any{"enabled": true, "until": "2026-11-17T02:00:00Z"})

	routes := []struct{ method, path string }{
		{"GET", "/api/v1/week"},
		{"GET", "/api/v1/me"},
		{"GET", "/api/v1/me/results"},
		{"POST", "/api/v1/results"},
		{"GET", "/api/v1/leaderboard"},
		{"GET", "/api/v1/endless"},
		{"GET", "/api/v1/me/endless"},
		{"GET", "/api/v1/me/stats"},
		{"POST", "/api/v1/endless/results"},
		{"GET", "/api/v1/endless/leaderboard"},
		{"GET", "/api/v1/endless/leaderboard/easy/1"},
		// A player probing an admin route is told about maintenance too.
		{"GET", "/api/v1/admin/results"},
		{"PUT", "/api/v1/admin/maintenance"},
	}
	for _, rt := range routes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			// Authentication runs first: no or a bad token is still 401.
			expectError(t, do(t, e.srv, rt.method, rt.path, "", nil), http.StatusUnauthorized, "unauthorized")
			expectError(t, do(t, e.srv, rt.method, rt.path, "garbage", nil), http.StatusUnauthorized, "unauthorized")

			resp := do(t, e.srv, rt.method, rt.path, alice, nil)
			if resp.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", resp.StatusCode)
			}
			if ra := resp.Header.Get("Retry-After"); ra != maintenanceRetryAfter {
				t.Errorf("Retry-After = %q", ra)
			}
			body := decode[maintError](t, resp)
			if body.Error.Code != "maintenance" || body.Error.Message == "" {
				t.Errorf("body = %+v", body)
			}
			if body.Error.Until == nil || *body.Error.Until != "2026-11-17T02:00:00Z" {
				t.Errorf("until = %v", body.Error.Until)
			}
		})
	}

	// Without an end time the error carries no until.
	putMaintenance(t, e, map[string]any{"enabled": true})
	body := decode[maintError](t, do(t, e.srv, "GET", "/api/v1/week", alice, nil))
	if body.Error.Code != "maintenance" || body.Error.Until != nil {
		t.Errorf("body without end = %+v", body)
	}

	// The refusal does not create the user.
	if n := userCount(t, e); n != 0 {
		t.Errorf("%d users created while refused", n)
	}

	// Public routes stay up: health, config, and the JSON 404.
	if resp := do(t, e.srv, "GET", "/healthz", "", nil); resp.StatusCode != http.StatusOK {
		t.Errorf("healthz = %d", resp.StatusCode)
	}
	if resp := do(t, e.srv, "GET", "/api/v1/config", "", nil); resp.StatusCode != http.StatusOK {
		t.Errorf("config = %d", resp.StatusCode)
	}
	expectError(t, do(t, e.srv, "GET", "/api/v1/nope", alice, nil), http.StatusNotFound, "not_found")
}

func userCount(t *testing.T, e replayEnv) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+e.path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM users WHERE subject = 'alice'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMaintenanceAdminPassesThrough(t *testing.T) {
	e := newReplayEnv(t, 5)
	putMaintenance(t, e, map[string]any{"enabled": true})
	for _, path := range []string{"/api/v1/week", "/api/v1/me", "/api/v1/me/results", "/api/v1/leaderboard", "/api/v1/me/stats", "/api/v1/endless"} {
		if resp := do(t, e.srv, "GET", path, adminToken, nil); resp.StatusCode != http.StatusOK {
			t.Errorf("admin GET %s = %d", path, resp.StatusCode)
		}
	}
	e.post(t, adminToken, resultBody(1, 60000, nil), http.StatusCreated)
}

func TestMaintenanceResultSubmission(t *testing.T) {
	e := newReplayEnv(t, 5)
	putMaintenance(t, e, map[string]any{"enabled": true})
	e.postErr(t, alice, resultBody(1, 60000, nil), http.StatusServiceUnavailable, "maintenance")
	// After switching off the same submission is accepted as new (201), so the refused one stored nothing.
	putMaintenance(t, e, map[string]any{"enabled": false})
	e.post(t, alice, resultBody(1, 60000, nil), http.StatusCreated)
}

func TestMaintenanceSurvivesRestart(t *testing.T) {
	e := newReplayEnv(t, 5)
	putMaintenance(t, e, map[string]any{"enabled": true, "until": "2026-11-17T02:00:00Z"})
	// A new server over the same store loads the stored setting.
	deps := adminConfig()
	deps.Store = e.st
	srv := newTestServer(t, deps)
	expectError(t, do(t, srv, "GET", "/api/v1/me", alice, nil), http.StatusServiceUnavailable, "maintenance")
}

func TestMaintenanceLoadFailureLeavesItOff(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "closed.db"))
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	deps := adminConfig()
	deps.Store = st
	s := New(deps)
	if s.maintenance().Enabled {
		t.Error("maintenance on after a failed load")
	}
}

func TestMaintenancePutStoreFailure(t *testing.T) {
	e := newReplayEnv(t, 5)
	e.sabotage(t, "ALTER TABLE maintenance_settings RENAME TO gone")
	expectError(t, do(t, e.srv, "PUT", "/api/v1/admin/maintenance", adminToken, map[string]any{"enabled": true}), http.StatusInternalServerError, "internal")
	// The failed save did not switch it on.
	if resp := do(t, e.srv, "GET", "/api/v1/me", alice, nil); resp.StatusCode != http.StatusOK {
		t.Errorf("me = %d", resp.StatusCode)
	}
}
