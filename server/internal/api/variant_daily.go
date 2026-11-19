package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// variantDailyCacheSize bounds the variant of the day puzzles kept in memory:
// a Graded Killer can take seconds to generate, and results arrive for the
// last few days. A variable so tests can make it small.
var variantDailyCacheSize = 16

// variantDailyCache remembers generated variant of the day puzzles by date.
type variantDailyCache struct {
	mu      sync.Mutex
	puzzles map[string]puzzle.DailyVariant
	// order is the dates in the order they were added, oldest first.
	order []string
}

func (c *variantDailyCache) get(key string) (puzzle.DailyVariant, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.puzzles[key]
	return d, ok
}

// put remembers d, dropping the oldest puzzle past the bound. A date already
// there (two requests generated it at once) is kept as it is.
func (c *variantDailyCache) put(key string, d puzzle.DailyVariant) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.puzzles == nil {
		c.puzzles = map[string]puzzle.DailyVariant{}
	}
	if _, ok := c.puzzles[key]; ok {
		return
	}
	if len(c.order) >= variantDailyCacheSize {
		delete(c.puzzles, c.order[0])
		c.order = c.order[1:]
	}
	c.puzzles[key] = d
	c.order = append(c.order, key)
}

// weekSeedOf is the week seed of the ISO week of date.
func (s *Server) weekSeedOf(date week.Date) uint64 {
	// ForWeek always yields 16 hex digits, which ParseWeekSeed accepts.
	ws, _ := puzzle.ParseWeekSeed(seed.ForWeek([]byte(s.deps.Config.ServerSecret), date.ISOWeek()))
	return ws
}

// variantDailyFor is the variant of the day puzzle of date, generated on first
// use and then cached.
func (s *Server) variantDailyFor(date week.Date) puzzle.DailyVariant {
	key := date.String()
	if d, ok := s.variantDaily.get(key); ok {
		return d
	}
	// The weekday is 1..7, so generating cannot fail.
	d, _ := puzzle.GenerateDailyVariant(s.weekSeedOf(date), date.Weekday())
	s.variantDaily.put(key, d)
	return d
}

// variantDailyOf is the variant (1..3) of the variant of the day of date,
// without generating its puzzle.
func (s *Server) variantDailyOf(date week.Date) int {
	return puzzle.DailyVariantOf(s.weekSeedOf(date), date.Weekday())
}

type variantDailyResultJSON struct {
	Date        string `json:"date"`
	Variant     int    `json:"variant"`
	ElapsedMs   int64  `json:"elapsedMs"`
	CompletedAt string `json:"completedAt"`
}

func toVariantDailyResultJSON(r store.VariantDailyResult) variantDailyResultJSON {
	return variantDailyResultJSON{Date: r.Date, Variant: r.Variant, ElapsedMs: r.ElapsedMs, CompletedAt: r.CompletedAt}
}

// variantDailySubmitRequest uses pointers so missing fields are
// distinguishable from zero.
type variantDailySubmitRequest struct {
	Date        *string `json:"date"`
	ElapsedMs   *int64  `json:"elapsedMs"`
	CompletedAt *string `json:"completedAt"`
	// Replay is decoded separately so a bad one is invalid_result, not a
	// malformed body.
	Replay json.RawMessage `json:"replay"`
}

func (s *Server) postVariantDailyResult(w http.ResponseWriter, r *http.Request) {
	var req variantDailySubmitRequest
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
	if req.Date == nil || req.ElapsedMs == nil || req.CompletedAt == nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "date, elapsedMs and completedAt are required")
		return
	}
	// The daily caps apply: a date within the last days, a plausible time.
	// There is only one puzzle a day, so the level is not a field here.
	level := minLevel
	date, err := validateResult(submitRequest{Date: req.Date, Level: &level, ElapsedMs: req.ElapsedMs, CompletedAt: req.CompletedAt}, s.today())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}
	rep, hasReplay, err := parseReplay(req.Replay)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}

	result := store.VariantDailyResult{
		UserID:      currentUser(r).ID,
		Date:        date.String(),
		Variant:     s.variantDailyOf(date),
		ElapsedMs:   *req.ElapsedMs,
		CompletedAt: *req.CompletedAt,
	}
	if !hasReplay {
		result.ReplayStatus = replayMissing
		result.AutoFlag = "No replay submitted"
	} else {
		p := s.variantDailyFor(date)
		// Marshalling plain structs cannot fail. The result is never empty
		// ("[]" at least), so the replay is stored even with no events.
		events, _ := json.Marshal(append([]replay.Event{}, rep.Events...))
		result.Events = string(events)
		if err := replay.CheckLayout(rep, p.Layout, p.Givens, p.Solution, *req.ElapsedMs); err != nil {
			result.ReplayStatus = replayInvalid
			result.ReplayError = err.Error()
			result.AutoFlag = "Replay check failed: " + err.Error()
		} else {
			result.ReplayStatus = replayValid
		}
	}
	stored, created, err := s.deps.Store.InsertVariantDailyResult(r.Context(), result)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, toVariantDailyResultJSON(stored))
}

// variantEntry is one player on the variant of the day's board.
type variantEntry struct {
	Rank        int    `json:"rank"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	ElapsedMs   int64  `json:"elapsedMs"`
	Suspicious  bool   `json:"suspicious"`
	// Streak is the player's run of consecutive days ending on the board's
	// date, as on the daily boards.
	Streak int `json:"streak"`
}

type variantDailyBoard struct {
	Date    string `json:"date"`
	Variant int    `json:"variant"`
	// Entries is ranked by time.
	Entries []variantEntry `json:"entries"`
}

func (s *Server) getVariantDailyLeaderboard(w http.ResponseWriter, r *http.Request) {
	date, ok := s.dateParam(w, r)
	if !ok {
		return
	}
	counting, err := s.deps.Store.CountingDates(r.Context(), date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	rows, err := s.deps.Store.VariantDailyResults(r.Context(), date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items := make([]scored, len(rows))
	for i, row := range rows {
		items[i] = scored{row.UserID, row.DisplayName, row.ElapsedMs, row.Flagged}
	}
	ranks := rank(items)
	out := variantDailyBoard{Date: date.String(), Variant: s.variantDailyOf(date), Entries: make([]variantEntry, len(items))}
	for i, it := range items {
		var dates []week.Date
		for _, d := range counting[it.userID] {
			dates = append(dates, storedDate(d))
		}
		out.Entries[i] = variantEntry{
			Rank: ranks[i], UserID: userID(it.userID), DisplayName: it.name, ElapsedMs: it.ms, Suspicious: it.flagged,
			Streak: streakOn(dates, date),
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

type adminVariantDailyJSON struct {
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	Date        string    `json:"date"`
	Variant     int       `json:"variant"`
	ElapsedMs   int64     `json:"elapsedMs"`
	CompletedAt string    `json:"completedAt"`
	SubmittedAt string    `json:"submittedAt"`
	Replay      string    `json:"replay"`
	ReplayError string    `json:"replayError"`
	Flag        *flagJSON `json:"flag"`
}

func toAdminVariantDailyJSON(r store.AdminVariantDailyResult) adminVariantDailyJSON {
	return adminVariantDailyJSON{
		UserID:      userID(r.UserID),
		DisplayName: r.DisplayName,
		Date:        r.Date,
		Variant:     r.Variant,
		ElapsedMs:   r.ElapsedMs,
		CompletedAt: r.CompletedAt,
		SubmittedAt: r.SubmittedAt,
		Replay:      r.ReplayStatus,
		ReplayError: r.ReplayError,
		Flag:        toFlagJSON(r.Flag),
	}
}

// variantDailyKey identifies one variant of the day result.
type variantDailyKey struct {
	uid  int64
	date week.Date
}

// variantDailyResultKey reads {date} and {userId} from the path. On a bad
// value it writes a 400 and returns false.
func variantDailyResultKey(w http.ResponseWriter, r *http.Request) (k variantDailyKey, ok bool) {
	date, err := week.ParseDate(r.PathValue("date"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "date must be YYYY-MM-DD")
		return variantDailyKey{}, false
	}
	uid, err := strconv.ParseInt(r.PathValue("userId"), 10, 64)
	if err != nil || uid < 1 {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "userId must be a positive integer")
		return variantDailyKey{}, false
	}
	return variantDailyKey{uid: uid, date: date}, true
}

type adminVariantDailyReplayResponse struct {
	adminVariantDailyJSON
	// Givens is the puzzle's starting grid, never its solution.
	Givens string          `json:"givens"`
	Layout *layoutJSON     `json:"layout"`
	Events json.RawMessage `json:"events"`
}

func (s *Server) getAdminVariantDailyReplay(w http.ResponseWriter, r *http.Request) {
	k, ok := variantDailyResultKey(w, r)
	if !ok {
		return
	}
	res, err := s.deps.Store.AdminVariantDailyResult(r.Context(), k.uid, k.date.String())
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	events, err := s.deps.Store.VariantDailyReplayEvents(r.Context(), k.uid, k.date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	if events == nil {
		events = []byte("[]")
	}
	p := s.variantDailyFor(k.date)
	httpx.WriteJSON(w, http.StatusOK, adminVariantDailyReplayResponse{
		adminVariantDailyJSON: toAdminVariantDailyJSON(res),
		Givens:                p.Givens,
		Layout:                toLayoutJSON(p.Layout),
		Events:                events,
	})
}

func (s *Server) putAdminVariantDailyFlag(w http.ResponseWriter, r *http.Request) {
	k, ok := variantDailyResultKey(w, r)
	if !ok {
		return
	}
	reason, ok := flagReason(w, r)
	if !ok {
		return
	}
	err := s.deps.Store.FlagVariantDailyResult(r.Context(), k.uid, k.date.String(), currentUser(r).ID, reason, s.deps.Clock.Now())
	s.respondVariantDailyFlagged(w, r, err, k)
}

func (s *Server) deleteAdminVariantDailyFlag(w http.ResponseWriter, r *http.Request) {
	k, ok := variantDailyResultKey(w, r)
	if !ok {
		return
	}
	err := s.deps.Store.UnflagVariantDailyResult(r.Context(), k.uid, k.date.String())
	s.respondVariantDailyFlagged(w, r, err, k)
}

// respondVariantDailyFlagged answers a flag change with the updated list item.
func (s *Server) respondVariantDailyFlagged(w http.ResponseWriter, r *http.Request, err error, k variantDailyKey) {
	var res store.AdminVariantDailyResult
	if err == nil {
		res, err = s.deps.Store.AdminVariantDailyResult(r.Context(), k.uid, k.date.String())
	}
	if err != nil {
		writeStoreError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, toAdminVariantDailyJSON(res))
}
