package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/store"
)

type adminEndlessResultJSON struct {
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Difficulty  int       `json:"difficulty"`
	Number      int64     `json:"number"`
	ElapsedMs   int64     `json:"elapsedMs"`
	CompletedAt string    `json:"completedAt"`
	SubmittedAt string    `json:"submittedAt"`
	Replay      string    `json:"replay"`
	ReplayError string    `json:"replayError"`
	Flag        *flagJSON `json:"flag"`
}

func toAdminEndlessResultJSON(r store.AdminEndlessResult) adminEndlessResultJSON {
	return adminEndlessResultJSON{
		UserID:      userID(r.UserID),
		DisplayName: r.DisplayName,
		Difficulty:  r.Difficulty,
		Number:      r.Number,
		ElapsedMs:   r.ElapsedMs,
		CompletedAt: r.CompletedAt,
		SubmittedAt: r.SubmittedAt,
		Replay:      r.ReplayStatus,
		ReplayError: r.ReplayError,
		Flag:        toFlagJSON(r.Flag),
	}
}

type adminEndlessResultsResponse struct {
	Date    string                   `json:"date"`
	Results []adminEndlessResultJSON `json:"results"`
}

// getAdminEndlessResults lists the endless results submitted on a game day,
// the day running from midnight to midnight in the game timezone.
func (s *Server) getAdminEndlessResults(w http.ResponseWriter, r *http.Request) {
	date, ok := s.dateParam(w, r)
	if !ok {
		return
	}
	rows, err := s.deps.Store.AdminEndlessResultsBetween(r.Context(), date.Start(s.loc), date.AddDays(1).Start(s.loc))
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := adminEndlessResultsResponse{Date: date.String(), Results: make([]adminEndlessResultJSON, len(rows))}
	for i, row := range rows {
		out.Results[i] = toAdminEndlessResultJSON(row)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// endlessResultKey reads {difficulty}, {number} and {userId} from the path.
// On a bad value it writes a 400 and returns false.
func endlessResultKey(w http.ResponseWriter, r *http.Request) (difficulty int, number int64, uid int64, ok bool) {
	difficulty, number, ok = endlessPuzzleParams(w, r)
	if !ok {
		return 0, 0, 0, false
	}
	uid, err := strconv.ParseInt(r.PathValue("userId"), 10, 64)
	if err != nil || uid < 1 {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "userId must be a positive integer")
		return 0, 0, 0, false
	}
	return difficulty, number, uid, true
}

type adminEndlessReplayResponse struct {
	adminEndlessResultJSON
	// Givens is the puzzle's starting grid, never its solution.
	Givens string          `json:"givens"`
	Events json.RawMessage `json:"events"`
}

func (s *Server) getAdminEndlessReplay(w http.ResponseWriter, r *http.Request) {
	difficulty, number, uid, ok := endlessResultKey(w, r)
	if !ok {
		return
	}
	res, err := s.deps.Store.AdminEndlessResult(r.Context(), uid, difficulty, number)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	events, err := s.deps.Store.EndlessReplayEvents(r.Context(), uid, difficulty, number)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if events == nil {
		events = []byte("[]")
	}
	httpx.WriteJSON(w, http.StatusOK, adminEndlessReplayResponse{
		adminEndlessResultJSON: toAdminEndlessResultJSON(res),
		Givens:                 s.endlessPuzzleFor(difficulty, number).Givens,
		Events:                 events,
	})
}

func (s *Server) putAdminEndlessFlag(w http.ResponseWriter, r *http.Request) {
	difficulty, number, uid, ok := endlessResultKey(w, r)
	if !ok {
		return
	}
	var req flagRequest
	// The body, and so the reason, is optional.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "malformed JSON body")
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if utf8.RuneCountInString(reason) > maxFlagReason {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "reason must be at most 500 characters")
		return
	}
	err := s.deps.Store.FlagEndlessResult(r.Context(), uid, difficulty, number, currentUser(r).ID, reason, s.deps.Clock.Now())
	s.respondEndlessFlagged(w, r, err, uid, difficulty, number)
}

func (s *Server) deleteAdminEndlessFlag(w http.ResponseWriter, r *http.Request) {
	difficulty, number, uid, ok := endlessResultKey(w, r)
	if !ok {
		return
	}
	err := s.deps.Store.UnflagEndlessResult(r.Context(), uid, difficulty, number)
	s.respondEndlessFlagged(w, r, err, uid, difficulty, number)
}

// respondEndlessFlagged answers a flag change with the updated list item.
func (s *Server) respondEndlessFlagged(w http.ResponseWriter, r *http.Request, err error, uid int64, difficulty int, number int64) {
	var res store.AdminEndlessResult
	if err == nil {
		res, err = s.deps.Store.AdminEndlessResult(r.Context(), uid, difficulty, number)
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toAdminEndlessResultJSON(res))
}
