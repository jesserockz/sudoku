// Package api wires the HTTP routes of the sudoku server.
package api

import (
	"net/http"

	"github.com/jesserockz/sudoku/server/internal/config"
	"github.com/jesserockz/sudoku/server/internal/httpx"
)

// Deps are the server's collaborators.
type Deps struct {
	Config config.Config
}

type Server struct {
	deps Deps
	mux  *http.ServeMux
}

func New(deps Deps) *Server {
	s := &Server{deps: deps, mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.healthz)
}

// Handler returns the full handler chain.
func (s *Server) Handler() http.Handler {
	return httpx.Logging(httpx.Recover(jsonFallback(s.mux)))
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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
