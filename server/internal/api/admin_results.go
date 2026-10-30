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
	"github.com/jesserockz/sudoku/server/internal/week"
)

// maxFlagReason is the longest flag reason, in characters.
const maxFlagReason = 500

type adminResultJSON struct {
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Level       int       `json:"level"`
	ElapsedMs   int64     `json:"elapsedMs"`
	CompletedAt string    `json:"completedAt"`
	SubmittedAt string    `json:"submittedAt"`
	Replay      string    `json:"replay"`
	ReplayError string    `json:"replayError"`
	Flag        *flagJSON `json:"flag"`
}

type flagJSON struct {
	Reason    string         `json:"reason"`
	Auto      bool           `json:"auto"`
	FlaggedBy *flaggedByJSON `json:"flaggedBy"`
	FlaggedAt string         `json:"flaggedAt"`
}

type flaggedByJSON struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
}

func toAdminResultJSON(r store.AdminResult) adminResultJSON {
	out := adminResultJSON{
		UserID:      userID(r.UserID),
		DisplayName: r.DisplayName,
		Level:       r.Level,
		ElapsedMs:   r.ElapsedMs,
		CompletedAt: r.CompletedAt,
		SubmittedAt: r.SubmittedAt,
		Replay:      r.ReplayStatus,
		ReplayError: r.ReplayError,
	}
	if f := r.Flag; f != nil {
		out.Flag = &flagJSON{Reason: f.Reason, Auto: f.Auto, FlaggedAt: f.At}
		if f.By != nil {
			out.Flag.FlaggedBy = &flaggedByJSON{UserID: userID(f.By.ID), DisplayName: f.By.DisplayName}
		}
	}
	return out
}

type adminResultsResponse struct {
	Date    string            `json:"date"`
	Levels  int               `json:"levels"`
	Results []adminResultJSON `json:"results"`
}

func (s *Server) getAdminResults(w http.ResponseWriter, r *http.Request) {
	date, ok := s.dateParam(w, r)
	if !ok {
		return
	}
	levels, err := s.levelsFor(r.Context(), date)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rows, err := s.deps.Store.AdminDayResults(r.Context(), date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := adminResultsResponse{Date: date.String(), Levels: levels, Results: make([]adminResultJSON, len(rows))}
	for i, row := range rows {
		out.Results[i] = toAdminResultJSON(row)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// resultKey reads {date}, {level} and {userId} from the path. On a bad value
// it writes a 400 and returns false.
func resultKey(w http.ResponseWriter, r *http.Request) (date week.Date, level int, uid int64, ok bool) {
	date, err := week.ParseDate(r.PathValue("date"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "date must be YYYY-MM-DD")
		return week.Date{}, 0, 0, false
	}
	level, err = strconv.Atoi(r.PathValue("level"))
	if err != nil || level < minLevel {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "level must be a positive integer")
		return week.Date{}, 0, 0, false
	}
	uid, err = strconv.ParseInt(r.PathValue("userId"), 10, 64)
	if err != nil || uid < 1 {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "userId must be a positive integer")
		return week.Date{}, 0, 0, false
	}
	return date, level, uid, true
}

// writeStoreError answers a store failure: 404 for a missing result, else 500.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, httpx.CodeNotFound, "no such result")
		return
	}
	httpx.Internal(w, r, err)
}

type adminReplayResponse struct {
	adminResultJSON
	Date   string `json:"date"`
	Levels int    `json:"levels"`
	// Givens is the puzzle's starting grid, never its solution.
	Givens string          `json:"givens"`
	Events json.RawMessage `json:"events"`
}

func (s *Server) getAdminReplay(w http.ResponseWriter, r *http.Request) {
	date, level, uid, ok := resultKey(w, r)
	if !ok {
		return
	}
	res, err := s.deps.Store.AdminResult(r.Context(), uid, date.String(), level)
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	events, err := s.deps.Store.ReplayEvents(r.Context(), uid, date.String(), level)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if events == nil {
		events = []byte("[]")
	}
	levels, err := s.levelsFor(r.Context(), date)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	p, err := s.puzzleFor(date, level, levels)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, adminReplayResponse{
		adminResultJSON: toAdminResultJSON(res),
		Date:            date.String(),
		Levels:          levels,
		Givens:          p.Givens,
		Events:          events,
	})
}

type flagRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) putAdminFlag(w http.ResponseWriter, r *http.Request) {
	date, level, uid, ok := resultKey(w, r)
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
	err := s.deps.Store.FlagResult(r.Context(), uid, date.String(), level, currentUser(r).ID, reason, s.deps.Clock.Now())
	s.respondFlagged(w, r, err, uid, date, level)
}

func (s *Server) deleteAdminFlag(w http.ResponseWriter, r *http.Request) {
	date, level, uid, ok := resultKey(w, r)
	if !ok {
		return
	}
	err := s.deps.Store.UnflagResult(r.Context(), uid, date.String(), level)
	s.respondFlagged(w, r, err, uid, date, level)
}

// respondFlagged answers a flag change with the updated list item.
func (s *Server) respondFlagged(w http.ResponseWriter, r *http.Request, err error, uid int64, date week.Date, level int) {
	var res store.AdminResult
	if err == nil {
		res, err = s.deps.Store.AdminResult(r.Context(), uid, date.String(), level)
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toAdminResultJSON(res))
}
