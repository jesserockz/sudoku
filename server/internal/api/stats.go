package api

import (
	"net/http"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/puzzle"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// recentResults is how many of a tier's latest daily results the stats list.
const recentResults = 20

type streakJSON struct {
	Current  int     `json:"current"`
	Best     int     `json:"best"`
	LastDate *string `json:"lastDate"`
}

type recentJSON struct {
	Date      string `json:"date"`
	Level     int    `json:"level"`
	ElapsedMs int64  `json:"elapsedMs"`
}

type dailyStatJSON struct {
	Difficulty int          `json:"difficulty"`
	Completed  int          `json:"completed"`
	BestMs     *int64       `json:"bestMs"`
	AverageMs  *int64       `json:"averageMs"`
	Recent     []recentJSON `json:"recent"`
}

type endlessStatJSON struct {
	Difficulty int    `json:"difficulty"`
	Completed  int    `json:"completed"`
	Highest    int64  `json:"highest"`
	BestMs     *int64 `json:"bestMs"`
	AverageMs  *int64 `json:"averageMs"`
}

type statsResponse struct {
	Today   string            `json:"today"`
	Streak  streakJSON        `json:"streak"`
	Daily   []dailyStatJSON   `json:"daily"`
	Endless []endlessStatJSON `json:"endless"`
}

func (s *Server) getMyStats(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r).ID
	results, err := s.deps.Store.UserDailyResults(r.Context(), uid)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	schedule, err := s.deps.Store.LevelSchedule(r.Context())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	endless, err := s.deps.Store.UserEndlessStats(r.Context(), uid)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	today := s.today()
	httpx.WriteJSON(w, http.StatusOK, buildStats(today, results, schedule, endless))
}

// dailyAcc accumulates one tier's daily results.
type dailyAcc struct {
	count  int
	best   int64
	total  int64
	recent []recentJSON
}

// buildStats summarises a user's results. results must be ordered by date,
// then level; each is assigned the tier its level has among that week's games
// in schedule.
func buildStats(today week.Date, results []store.UserDailyResult, schedule store.Schedule, endless []store.EndlessStat) statsResponse {
	var acc [puzzle.Tiers]dailyAcc
	var dates []week.Date
	levelsOf := map[string]int{} // by ISO week, so each is resolved once
	for _, r := range results {
		d := storedDate(r.Date)
		iso := d.ISOWeek()
		levels, ok := levelsOf[iso]
		if !ok {
			levels = schedule.LevelsFor(iso)
			levelsOf[iso] = levels
		}
		if !r.AdminFlagged && (len(dates) == 0 || dates[len(dates)-1] != d) {
			dates = append(dates, d)
		}
		tier, err := puzzle.TierFor(r.Level, levels)
		if err != nil {
			// A level beyond the week's count: the leaderboards skip it too.
			continue
		}
		a := &acc[tier-1]
		a.count++
		if a.count == 1 || r.ElapsedMs < a.best {
			a.best = r.ElapsedMs
		}
		a.total += r.ElapsedMs
		if len(a.recent) == recentResults {
			a.recent = a.recent[1:]
		}
		a.recent = append(a.recent, recentJSON{Date: r.Date, Level: r.Level, ElapsedMs: r.ElapsedMs})
	}

	out := statsResponse{
		Today:   today.String(),
		Streak:  computeStreak(dates, today),
		Daily:   make([]dailyStatJSON, puzzle.Tiers),
		Endless: make([]endlessStatJSON, puzzle.Tiers),
	}
	for i, a := range acc {
		d := dailyStatJSON{Difficulty: i + 1, Completed: a.count, Recent: append([]recentJSON{}, a.recent...)}
		if a.count > 0 {
			d.BestMs, d.AverageMs = &a.best, ptr(meanMs(a.total, int64(a.count)))
		}
		out.Daily[i] = d
	}
	for i := range out.Endless {
		out.Endless[i] = endlessStatJSON{Difficulty: i + 1}
	}
	for _, e := range endless {
		out.Endless[e.Difficulty-1] = endlessStatJSON{
			Difficulty: e.Difficulty,
			Completed:  e.Completed,
			Highest:    e.Highest,
			BestMs:     ptr(e.BestMs),
			AverageMs:  ptr(meanMs(e.TotalMs, int64(e.Completed))),
		}
	}
	return out
}

func ptr[T any](v T) *T { return &v }

// meanMs is total/n rounded to the nearest ms, halves up.
func meanMs(total, n int64) int64 { return (2*total + n) / (2 * n) }

// storedDate parses a stored game date. The server only ever stores dates it
// formatted itself, so they always parse.
func storedDate(s string) week.Date {
	d, _ := week.ParseDate(s)
	return d
}

// runs measures a list of game dates, oldest first (repeats allowed): the
// longest run of consecutive calendar days, the length of the run ending at
// the last date, and that date.
func runs(dates []week.Date) (best, final int, last week.Date) {
	for i, d := range dates {
		switch {
		case i > 0 && d == last:
			continue
		case i > 0 && d.DaysSince(last) == 1:
			final++
		default:
			final = 1
		}
		best = max(best, final)
		last = d
	}
	return best, final, last
}

// computeStreak is the streak of the days in dates (oldest first) as of
// today: the current run counts when it ends today, or yesterday while today
// has no game yet.
func computeStreak(dates []week.Date, today week.Date) streakJSON {
	if len(dates) == 0 {
		return streakJSON{}
	}
	best, final, last := runs(dates)
	s := streakJSON{Best: best, LastDate: ptr(last.String())}
	if today.DaysSince(last) == 0 || today.DaysSince(last) == 1 {
		s.Current = final
	}
	return s
}

// streakOn is the number of consecutive days in dates (oldest first) ending
// on day, which counts only if it is itself in dates.
func streakOn(dates []week.Date, day week.Date) int {
	if len(dates) == 0 {
		return 0
	}
	_, final, last := runs(dates)
	if last != day {
		return 0
	}
	return final
}
