// Package api wires the HTTP routes of the sudoku server.
package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/config"
	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// Deps are the server's collaborators.
type Deps struct {
	Config   config.Config
	Clock    clock.Clock
	Store    *store.Store
	Verifier auth.Verifier
	// Web serves the web client for every other GET path; nil disables it.
	Web http.Handler
	// Updater backs the admin self-update routes; nil makes them answer 409
	// update_unavailable.
	Updater Updater
}

type Server struct {
	deps Deps
	mux  *http.ServeMux
	// loc is the game timezone, from Config.Timezone.
	loc *time.Location
}

func New(deps Deps) *Server {
	if deps.Clock == nil {
		deps.Clock = clock.System{}
	}
	// config.Load has already validated the zone; a bad one here is a bug.
	loc, err := time.LoadLocation(deps.Config.Timezone)
	if err != nil {
		panic(fmt.Sprintf("api: timezone %q: %v", deps.Config.Timezone, err))
	}
	s := &Server{deps: deps, mux: http.NewServeMux(), loc: loc}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.healthz)
	s.mux.HandleFunc("GET /api/v1/config", s.getConfig)
	s.mux.HandleFunc("GET /api/v1/week", s.requireAuth(s.getWeek))
	s.mux.HandleFunc("GET /api/v1/me", s.requireAuth(s.getMe))
	s.mux.HandleFunc("GET /api/v1/me/results", s.requireAuth(s.getMyResults))
	s.mux.HandleFunc("POST /api/v1/results", s.requireAuth(s.postResult))
	s.mux.HandleFunc("GET /api/v1/leaderboard", s.requireAuth(s.getLeaderboard))
	s.mux.HandleFunc("GET /api/v1/admin/releases", s.requireAdmin(s.getAdminReleases))
	s.mux.HandleFunc("POST /api/v1/admin/update", s.requireAdmin(s.postAdminUpdate))
	s.mux.HandleFunc("GET /api/v1/admin/update", s.requireAdmin(s.getAdminUpdate))
	s.mux.HandleFunc("POST /api/v1/admin/rollback", s.requireAdmin(s.postAdminRollback))
	if s.deps.Web != nil {
		s.mux.HandleFunc("GET /", s.static)
	}
}

// today is the current game date in the configured timezone.
func (s *Server) today() week.Date { return week.DateOf(s.deps.Clock.Now(), s.loc) }

// levelsFor is the number of levels on date d, per the level schedule.
func (s *Server) levelsFor(ctx context.Context, d week.Date) (int, error) {
	return s.deps.Store.LevelsForWeek(ctx, d.ISOWeek())
}

// SyncLevels applies Config.Levels to the level schedule and returns the ISO
// week from which it is in effect: immediately if nothing has been played
// yet, otherwise from next week if it differs from this week's count.
func (s *Server) SyncLevels(ctx context.Context) (string, error) {
	info := week.InfoAt(s.deps.Clock.Now(), s.loc)
	next := info.WeekStart.AddDays(7).ISOWeek()
	eff, err := s.deps.Store.ScheduleLevels(ctx, info.ISOWeek, next, s.deps.Config.Levels)
	if err != nil {
		return "", err
	}
	if eff < info.ISOWeek {
		// Already in effect (possibly for every week): report it as now.
		eff = info.ISOWeek
	}
	return eff, nil
}

// Handler returns the full handler chain.
func (s *Server) Handler() http.Handler {
	return httpx.Logging(httpx.Recover(jsonFallback(s.mux)))
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// static serves the web client, but never for API or health paths: an
// unknown API route must stay a JSON 404, not the client's index.html.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/api" || strings.HasPrefix(p, "/api/") || p == "/healthz" {
		httpx.Error(w, http.StatusNotFound, httpx.CodeNotFound, "not found")
		return
	}
	s.deps.Web.ServeHTTP(w, r)
}

// jsonFallback serves requests no route matches with the JSON error envelope
// instead of the mux's plain-text 404/405.
func jsonFallback(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, pattern := mux.Handler(r)
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		probe := &headerProbe{header: http.Header{}}
		h.ServeHTTP(probe, r)
		if probe.status == http.StatusMethodNotAllowed {
			w.Header().Set("Allow", probe.header.Get("Allow"))
			httpx.Error(w, http.StatusMethodNotAllowed, httpx.CodeMethodNotAllowed, "method not allowed")
			return
		}
		httpx.Error(w, http.StatusNotFound, httpx.CodeNotFound, "not found")
	})
}

// headerProbe records the status and headers the mux's fallback handler
// would have written, discarding the body.
type headerProbe struct {
	header http.Header
	status int
}

func (p *headerProbe) Header() http.Header         { return p.header }
func (p *headerProbe) Write(b []byte) (int, error) { return len(b), nil }
func (p *headerProbe) WriteHeader(code int)        { p.status = code }
