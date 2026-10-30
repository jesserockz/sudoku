package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// Sanity caps from docs/API.md.
const (
	minLevel       = 1
	minElapsedMs   = 5_000
	maxElapsedMs   = 86_400_000
	maxDaysBack    = 8
	maxRequestBody = 64 << 10
	// maxResultBody is the cap for POST /results, which carries a replay.
	maxResultBody = 1 << 20
)

type resultJSON struct {
	Date        string `json:"date"`
	Level       int    `json:"level"`
	ElapsedMs   int64  `json:"elapsedMs"`
	CompletedAt string `json:"completedAt"`
}

func toResultJSON(r store.Result) resultJSON {
	return resultJSON{Date: r.Date, Level: r.Level, ElapsedMs: r.ElapsedMs, CompletedAt: r.CompletedAt}
}

// submitRequest uses pointers so missing fields are distinguishable from zero.
type submitRequest struct {
	Date        *string `json:"date"`
	Level       *int    `json:"level"`
	ElapsedMs   *int64  `json:"elapsedMs"`
	CompletedAt *string `json:"completedAt"`
	// Replay is decoded separately so a bad one is invalid_result, not a
	// malformed body.
	Replay json.RawMessage `json:"replay"`
}

func (s *Server) postResult(w http.ResponseWriter, r *http.Request) {
	var req submitRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxResultBody))
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Error(w, http.StatusRequestEntityTooLarge, httpx.CodeTooLarge, "request body is too large")
			return
		}
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "malformed JSON body")
		return
	}
	if req.Date == nil || req.Level == nil || req.ElapsedMs == nil || req.CompletedAt == nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "date, level, elapsedMs and completedAt are required")
		return
	}
	date, err := validateResult(req, s.today())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}
	levels, err := s.levelsFor(r.Context(), date)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if *req.Level > levels {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, fmt.Sprintf("level must be %d..%d on %s", minLevel, levels, date))
		return
	}

	rep, hasReplay, err := parseReplay(req.Replay)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}

	result := store.Result{
		UserID:      currentUser(r).ID,
		Date:        date.String(),
		Level:       *req.Level,
		ElapsedMs:   *req.ElapsedMs,
		CompletedAt: *req.CompletedAt,
	}
	if !hasReplay {
		result.ReplayStatus = replayMissing
		result.AutoFlag = "No replay submitted"
	} else {
		p, err := s.puzzleFor(date, *req.Level, levels)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		// Marshalling plain structs cannot fail. The result is never empty
		// ("[]" at least), so the replay is stored even with no events.
		events, _ := json.Marshal(append([]replay.Event{}, rep.Events...))
		result.Events = string(events)
		if err := replay.Check(rep, p.Givens, p.Solution, *req.ElapsedMs); err != nil {
			result.ReplayStatus = replayInvalid
			result.ReplayError = err.Error()
			result.AutoFlag = "Replay check failed: " + err.Error()
		} else {
			result.ReplayStatus = replayValid
		}
	}
	stored, created, err := s.deps.Store.InsertResult(r.Context(), result)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, toResultJSON(stored))
}

// Replay statuses, as stored and served.
const (
	replayValid   = "valid"
	replayInvalid = "invalid"
	replayMissing = "missing"
)

// parseReplay decodes the optional replay of a submission and checks its
// shape. ok is false when none was sent.
func parseReplay(raw json.RawMessage) (rep replay.Replay, ok bool, err error) {
	if len(raw) == 0 || string(raw) == "null" {
		return replay.Replay{}, false, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rep); err != nil {
		return replay.Replay{}, false, errors.New("replay is malformed")
	}
	if err := replay.Wellformed(rep); err != nil {
		return replay.Replay{}, false, err
	}
	return rep, true, nil
}

// puzzleFor regenerates the puzzle of game level on date, on a day with
// levels games.
func (s *Server) puzzleFor(date week.Date, level, levels int) (puzzle.Puzzle, error) {
	// ForWeek always yields 16 hex digits, which ParseWeekSeed accepts.
	ws, _ := puzzle.ParseWeekSeed(seed.ForWeek([]byte(s.deps.Config.ServerSecret), date.ISOWeek()))
	return puzzle.Generate(ws, date.Weekday(), level, levels)
}

// validateResult applies the sanity caps relative to today. The level's
// upper bound depends on the date's week and is checked by the caller.
func validateResult(req submitRequest, today week.Date) (week.Date, error) {
	if *req.Level < minLevel {
		return week.Date{}, fmt.Errorf("level must be at least %d", minLevel)
	}
	if ms := *req.ElapsedMs; ms < minElapsedMs {
		return week.Date{}, errors.New("elapsedMs below minimum")
	} else if ms > maxElapsedMs {
		return week.Date{}, errors.New("elapsedMs above maximum")
	}
	date, err := week.ParseDate(*req.Date)
	if err != nil {
		return week.Date{}, errors.New("date must be YYYY-MM-DD")
	}
	if date.After(today) {
		return week.Date{}, errors.New("date is in the future")
	}
	if today.DaysSince(date) > maxDaysBack {
		return week.Date{}, fmt.Errorf("date is more than %d days ago", maxDaysBack)
	}
	if _, err := time.Parse(time.RFC3339, *req.CompletedAt); err != nil {
		return week.Date{}, errors.New("completedAt must be an RFC 3339 timestamp")
	}
	return date, nil
}

type myResultsResponse struct {
	Date    string       `json:"date"`
	Results []resultJSON `json:"results"`
}

func (s *Server) getMyResults(w http.ResponseWriter, r *http.Request) {
	date, ok := s.dateParam(w, r)
	if !ok {
		return
	}
	results, err := s.deps.Store.UserResults(r.Context(), currentUser(r).ID, date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := myResultsResponse{Date: date.String(), Results: make([]resultJSON, len(results))}
	for i, res := range results {
		out.Results[i] = toResultJSON(res)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// dateParam reads ?date=YYYY-MM-DD, defaulting to today. On a bad value it
// writes a 400 and returns false.
func (s *Server) dateParam(w http.ResponseWriter, r *http.Request) (week.Date, bool) {
	raw := r.URL.Query().Get("date")
	if raw == "" {
		return s.today(), true
	}
	d, err := week.ParseDate(raw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "date must be YYYY-MM-DD")
		return week.Date{}, false
	}
	return d, true
}
