package api

import (
	"encoding/json"
	"net/http"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// pendingGeneratorJSON is a generator change that starts at the beginning of
// FromWeek.
type pendingGeneratorJSON struct {
	Version  int    `json:"version"`
	FromWeek string `json:"fromWeek"`
}

// toPendingJSON converts a pending schedule entry; nil stays nil (null).
func toPendingJSON(e *store.GeneratorEntry) *pendingGeneratorJSON {
	if e == nil {
		return nil
	}
	return &pendingGeneratorJSON{Version: e.Version, FromWeek: e.EffectiveWeek}
}

// generatorEntryJSON is one generator in the history. FromWeek is null for
// the first one, which has applied since before the first week.
type generatorEntryJSON struct {
	FromWeek *string `json:"fromWeek"`
	Version  int     `json:"version"`
}

type generatorResponse struct {
	Active  int                   `json:"active"`
	Pending *pendingGeneratorJSON `json:"pending"`
	// Schedule is every generator that has been in effect, up to and
	// including the active one, oldest first. Pending is not part of it.
	Schedule []generatorEntryJSON `json:"schedule"`
}

// generatorState describes the schedule as of thisWeek.
func generatorState(sc store.GeneratorSchedule, thisWeek string) generatorResponse {
	out := generatorResponse{
		Active:   sc.VersionFor(thisWeek),
		Pending:  toPendingJSON(sc.Pending(thisWeek)),
		Schedule: []generatorEntryJSON{},
	}
	for _, e := range sc {
		if e.EffectiveWeek > thisWeek {
			break
		}
		entry := generatorEntryJSON{Version: e.Version}
		if e.EffectiveWeek != store.FirstWeek {
			entry.FromWeek = &e.EffectiveWeek
		}
		out.Schedule = append(out.Schedule, entry)
	}
	return out
}

// respondGenerator answers with the current schedule.
func (s *Server) respondGenerator(w http.ResponseWriter, r *http.Request) {
	sc, err := s.deps.Store.GeneratorSchedule(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, generatorState(sc, s.today().ISOWeek()))
}

func (s *Server) getAdminGenerator(w http.ResponseWriter, r *http.Request) {
	s.respondGenerator(w, r)
}

type generatorRequest struct {
	Version *int `json:"version"`
}

func validGeneratorVersion(v int) bool {
	return v == puzzle.VersionClassic || v == puzzle.VersionGraded
}

// scheduleGenerator makes version the generator from next week on, or cancels
// the pending change when it is the current week's.
func (s *Server) scheduleGenerator(r *http.Request, version int) error {
	info := week.InfoAt(s.deps.Clock.Now(), s.loc)
	next := info.WeekStart.AddDays(7).ISOWeek()
	_, err := s.deps.Store.ScheduleGenerator(r.Context(), info.ISOWeek, next, version)
	return err
}

func (s *Server) putAdminGenerator(w http.ResponseWriter, r *http.Request) {
	var req generatorRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil || req.Version == nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "version is required")
		return
	}
	if !validGeneratorVersion(*req.Version) {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "version must be 1 or 2")
		return
	}
	if err := s.scheduleGenerator(r, *req.Version); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.respondGenerator(w, r)
}

func (s *Server) deleteAdminGeneratorPending(w http.ResponseWriter, r *http.Request) {
	// Choosing the active version is how a pending change is cancelled.
	sc, err := s.deps.Store.GeneratorSchedule(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if err := s.scheduleGenerator(r, sc.VersionFor(s.today().ISOWeek())); err != nil {
		httpx.Internal(w, r, err)
		return
	}
	s.respondGenerator(w, r)
}
