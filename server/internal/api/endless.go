package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/replay"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/store"
)

// minDifficulty and minNumber are the lowest endless difficulty tier (the
// highest is puzzle.Tiers) and puzzle number (the highest is
// puzzle.MaxEndlessNumber).
const (
	minDifficulty = 1
	minNumber     = 1
)

type endlessSeedResponse struct {
	Seed string `json:"seed"`
}

func (s *Server) getEndless(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, endlessSeedResponse{Seed: seed.ForEndless([]byte(s.deps.Config.ServerSecret))})
}

// endlessPuzzleFor regenerates endless puzzle number of tier difficulty, both
// already validated.
func (s *Server) endlessPuzzleFor(difficulty int, number int64) puzzle.Puzzle {
	// ForEndless always yields 16 hex digits, which ParseWeekSeed accepts, and
	// the arguments are in range, so generating cannot fail.
	es, _ := puzzle.ParseWeekSeed(seed.ForEndless([]byte(s.deps.Config.ServerSecret)))
	p, _ := puzzle.GenerateEndless(es, difficulty, number)
	return p
}

type endlessResultJSON struct {
	Difficulty  int    `json:"difficulty"`
	Number      int64  `json:"number"`
	ElapsedMs   int64  `json:"elapsedMs"`
	CompletedAt string `json:"completedAt"`
}

func toEndlessResultJSON(r store.EndlessResult) endlessResultJSON {
	return endlessResultJSON{Difficulty: r.Difficulty, Number: r.Number, ElapsedMs: r.ElapsedMs, CompletedAt: r.CompletedAt}
}

type myEndlessResponse struct {
	Results []endlessResultJSON `json:"results"`
}

func (s *Server) getMyEndless(w http.ResponseWriter, r *http.Request) {
	results, err := s.deps.Store.UserEndlessResults(r.Context(), currentUser(r).ID)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	out := myEndlessResponse{Results: make([]endlessResultJSON, len(results))}
	for i, res := range results {
		out.Results[i] = toEndlessResultJSON(res)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// endlessSubmitRequest uses pointers so missing fields are distinguishable
// from zero.
type endlessSubmitRequest struct {
	Difficulty  *int    `json:"difficulty"`
	Number      *int64  `json:"number"`
	ElapsedMs   *int64  `json:"elapsedMs"`
	CompletedAt *string `json:"completedAt"`
	// Replay is decoded separately so a bad one is invalid_result, not a
	// malformed body.
	Replay json.RawMessage `json:"replay"`
}

func (s *Server) postEndlessResult(w http.ResponseWriter, r *http.Request) {
	var req endlessSubmitRequest
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
	if req.Difficulty == nil || req.Number == nil || req.ElapsedMs == nil || req.CompletedAt == nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "difficulty, number, elapsedMs and completedAt are required")
		return
	}
	if err := validateEndlessResult(req); err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}

	rep, hasReplay, err := parseReplay(req.Replay)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeInvalidResult, err.Error())
		return
	}

	result := store.EndlessResult{
		UserID:      currentUser(r).ID,
		Difficulty:  *req.Difficulty,
		Number:      *req.Number,
		ElapsedMs:   *req.ElapsedMs,
		CompletedAt: *req.CompletedAt,
	}
	if !hasReplay {
		result.ReplayStatus = replayMissing
		result.AutoFlag = "No replay submitted"
	} else {
		p := s.endlessPuzzleFor(*req.Difficulty, *req.Number)
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
	stored, created, err := s.deps.Store.InsertEndlessResult(r.Context(), result)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, toEndlessResultJSON(stored))
}

// validateEndlessResult applies the sanity caps to an endless submission.
func validateEndlessResult(req endlessSubmitRequest) error {
	if d := *req.Difficulty; d < minDifficulty || d > puzzle.Tiers {
		return fmt.Errorf("difficulty must be %d..%d", minDifficulty, puzzle.Tiers)
	}
	if n := *req.Number; n < minNumber || n > puzzle.MaxEndlessNumber {
		return fmt.Errorf("number must be %d..%d", minNumber, puzzle.MaxEndlessNumber)
	}
	if ms := *req.ElapsedMs; ms < minElapsedMs {
		return errors.New("elapsedMs below minimum")
	} else if ms > maxElapsedMs {
		return errors.New("elapsedMs above maximum")
	}
	if _, err := time.Parse(time.RFC3339, *req.CompletedAt); err != nil {
		return errors.New("completedAt must be an RFC 3339 timestamp")
	}
	return nil
}

type endlessLeaderboardResponse struct {
	Difficulties []difficultyBoard `json:"difficulties"`
}

type difficultyBoard struct {
	Difficulty int             `json:"difficulty"`
	Players    []progressEntry `json:"players"`
}

type progressEntry struct {
	Rank        int    `json:"rank"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Completed   int    `json:"completed"`
	Highest     int64  `json:"highest"`
	Suspicious  bool   `json:"suspicious"`
}

func (s *Server) getEndlessLeaderboard(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.Store.EndlessProgressAll(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, buildEndlessLeaderboard(rows))
}

// buildEndlessLeaderboard ranks each tier's players by puzzles solved, most
// first.
func buildEndlessLeaderboard(rows []store.EndlessProgress) endlessLeaderboardResponse {
	byTier := make([][]store.EndlessProgress, puzzle.Tiers+1)
	for _, p := range rows {
		byTier[p.Difficulty] = append(byTier[p.Difficulty], p)
	}
	out := endlessLeaderboardResponse{Difficulties: make([]difficultyBoard, 0, puzzle.Tiers)}
	for d := minDifficulty; d <= puzzle.Tiers; d++ {
		// rank orders by ascending score, so score by minus the count.
		items := make([]scored, len(byTier[d]))
		byUser := make(map[int64]store.EndlessProgress, len(byTier[d]))
		for i, p := range byTier[d] {
			items[i] = scored{p.UserID, p.DisplayName, -int64(p.Completed), p.Flagged}
			byUser[p.UserID] = p
		}
		ranks := rank(items)
		players := make([]progressEntry, len(items))
		for i, it := range items {
			p := byUser[it.userID]
			players[i] = progressEntry{Rank: ranks[i], UserID: userID(it.userID), DisplayName: it.name, Completed: p.Completed, Highest: p.Highest, Suspicious: it.flagged}
		}
		out.Difficulties = append(out.Difficulties, difficultyBoard{Difficulty: d, Players: players})
	}
	return out
}

type endlessPuzzleBoard struct {
	Difficulty int           `json:"difficulty"`
	Number     int64         `json:"number"`
	Entries    []puzzleEntry `json:"entries"`
}

func (s *Server) getEndlessPuzzleLeaderboard(w http.ResponseWriter, r *http.Request) {
	difficulty, number, ok := endlessPuzzleParams(w, r)
	if !ok {
		return
	}
	rows, err := s.deps.Store.EndlessPuzzleResults(r.Context(), difficulty, number)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	items := make([]scored, len(rows))
	for i, row := range rows {
		items[i] = scored{row.UserID, row.DisplayName, row.ElapsedMs, row.Flagged}
	}
	ranks := rank(items)
	out := endlessPuzzleBoard{Difficulty: difficulty, Number: number, Entries: make([]puzzleEntry, len(items))}
	for i, it := range items {
		out.Entries[i] = puzzleEntry{Rank: ranks[i], UserID: userID(it.userID), DisplayName: it.name, ElapsedMs: it.ms, Suspicious: it.flagged}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// endlessPuzzleParams reads {difficulty} and {number} from the path. On a bad
// value it writes a 400 and returns false.
func endlessPuzzleParams(w http.ResponseWriter, r *http.Request) (difficulty int, number int64, ok bool) {
	difficulty, err := strconv.Atoi(r.PathValue("difficulty"))
	if err != nil || difficulty < minDifficulty || difficulty > puzzle.Tiers {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, fmt.Sprintf("difficulty must be %d..%d", minDifficulty, puzzle.Tiers))
		return 0, 0, false
	}
	number, err = strconv.ParseInt(r.PathValue("number"), 10, 64)
	if err != nil || number < minNumber || number > puzzle.MaxEndlessNumber {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, fmt.Sprintf("number must be %d..%d", minNumber, puzzle.MaxEndlessNumber))
		return 0, 0, false
	}
	return difficulty, number, true
}
