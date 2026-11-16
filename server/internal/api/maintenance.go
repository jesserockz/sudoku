package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/store"
)

// maintenanceRetryAfter is the Retry-After (seconds) sent with a
// maintenance 503. It is a polling hint; the end time is only a display hint.
const maintenanceRetryAfter = "60"

// maintenanceJSON is the admin view of the setting. Until is an RFC 3339
// UTC timestamp or null.
type maintenanceJSON struct {
	Enabled bool    `json:"enabled"`
	Until   *string `json:"until"`
}

// untilString formats m's end time as RFC 3339 UTC, or nil when unset.
func untilString(m store.Maintenance) *string {
	if m.Until == nil {
		return nil
	}
	s := m.Until.UTC().Format(time.RFC3339)
	return &s
}

// loadMaintenance reads the stored setting into memory. A failure leaves
// maintenance off (and is logged): the same database failure would fail
// every request anyway.
func (s *Server) loadMaintenance(ctx context.Context) {
	m, err := s.deps.Store.Maintenance(ctx)
	if err != nil {
		slog.Error("load maintenance setting", "err", err)
	}
	s.maint.Store(&m)
}

// maintenance is the current in-memory setting.
func (s *Server) maintenance() store.Maintenance { return *s.maint.Load() }

// refuseMaintenance answers a non-admin with 503 maintenance when
// maintenance mode is on and reports whether it did.
func (s *Server) refuseMaintenance(w http.ResponseWriter, isAdmin bool) bool {
	m := s.maintenance()
	if !m.Enabled || isAdmin {
		return false
	}
	w.Header().Set("Retry-After", maintenanceRetryAfter)
	httpx.ErrorUntil(w, http.StatusServiceUnavailable, httpx.CodeMaintenance,
		"the server is down for maintenance", untilString(m))
	return true
}

func (s *Server) respondMaintenance(w http.ResponseWriter) {
	m := s.maintenance()
	httpx.WriteJSON(w, http.StatusOK, maintenanceJSON{Enabled: m.Enabled, Until: untilString(m)})
}

func (s *Server) getAdminMaintenance(w http.ResponseWriter, r *http.Request) {
	s.respondMaintenance(w)
}

type maintenanceRequest struct {
	Enabled *bool   `json:"enabled"`
	Until   *string `json:"until"`
}

// putAdminMaintenance switches maintenance mode on or off, with immediate
// effect. until must be an RFC 3339 timestamp (any offset; stored as UTC) or
// null. A past until is fine: it is only a display hint.
func (s *Server) putAdminMaintenance(w http.ResponseWriter, r *http.Request) {
	var req maintenanceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil || req.Enabled == nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "enabled (true or false) is required")
		return
	}
	m := store.Maintenance{Enabled: *req.Enabled}
	if req.Until != nil {
		t, err := time.Parse(time.RFC3339, *req.Until)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "until must be an RFC 3339 timestamp or null")
			return
		}
		t = t.UTC()
		m.Until = &t
	}
	if err := s.deps.Store.SetMaintenance(r.Context(), m); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.maint.Store(&m)
	s.respondMaintenance(w)
}
