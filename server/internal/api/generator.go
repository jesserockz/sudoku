package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
)

// generatorResponse is the set of enabled generators, ascending and never
// empty: [1], [2] or [1, 2].
type generatorResponse struct {
	Enabled []int `json:"enabled"`
}

// enabledGenerators is the set of generators players may use.
func (s *Server) enabledGenerators(ctx context.Context) ([]int, error) {
	return s.deps.Store.EnabledGenerators(ctx)
}

// defaultGenerator is the generator used when a request names none: the
// first enabled one.
func (s *Server) defaultGenerator(ctx context.Context) (int, error) {
	enabled, err := s.enabledGenerators(ctx)
	if err != nil {
		return 0, err
	}
	return enabled[0], nil
}

// respondGenerator answers with the enabled generators.
func (s *Server) respondGenerator(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.enabledGenerators(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, generatorResponse{Enabled: enabled})
}

func (s *Server) getAdminGenerator(w http.ResponseWriter, r *http.Request) {
	s.respondGenerator(w, r)
}

type generatorRequest struct {
	Enabled []int `json:"enabled"`
}

func validGeneratorVersion(v int) bool {
	return v == puzzle.VersionClassic || v == puzzle.VersionGraded
}

// putAdminGenerator enables the generators in the body, with immediate
// effect. Duplicates are collapsed.
func (s *Server) putAdminGenerator(w http.ResponseWriter, r *http.Request) {
	var req generatorRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil || len(req.Enabled) == 0 {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "enabled must be a non-empty list of generators")
		return
	}
	if slices.ContainsFunc(req.Enabled, func(v int) bool { return !validGeneratorVersion(v) }) {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "generators must be 1 or 2")
		return
	}
	if err := s.deps.Store.SetEnabledGenerators(r.Context(), req.Enabled); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.respondGenerator(w, r)
}
