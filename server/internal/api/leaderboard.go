package api

import (
	"cmp"
	"net/http"
	"slices"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/store"
)

type leaderboardResponse struct {
	Date    string        `json:"date"`
	Puzzles []puzzleBoard `json:"puzzles"`
	Total   totalBoard    `json:"total"`
	Players []playerJSON  `json:"players"`
}

type puzzleBoard struct {
	Level   int           `json:"level"`
	Entries []puzzleEntry `json:"entries"`
}

type puzzleEntry struct {
	Rank        int    `json:"rank"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	ElapsedMs   int64  `json:"elapsedMs"`
}

type totalBoard struct {
	Entries []totalEntry `json:"entries"`
}

type totalEntry struct {
	Rank        int    `json:"rank"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	TotalMs     int64  `json:"totalMs"`
}

type playerJSON struct {
	UserID          string `json:"userId"`
	DisplayName     string `json:"displayName"`
	CompletedLevels []int  `json:"completedLevels"`
}

func (s *Server) getLeaderboard(w http.ResponseWriter, r *http.Request) {
	date, ok := s.dateParam(w, r)
	if !ok {
		return
	}
	rows, err := s.deps.Store.DayResults(r.Context(), date.String())
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	levels, err := s.levelsFor(r.Context(), date)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	lb := buildLeaderboard(rows, levels)
	lb.Date = date.String()
	httpx.WriteJSON(w, http.StatusOK, lb)
}

// scored is one user's time on a board, before ranking.
type scored struct {
	userID int64
	name   string
	ms     int64
}

// rank sorts by time, then display name for stable display, and assigns
// standard competition ranks: equal times share a rank (1, 2, 2, 4).
func rank(items []scored) []int {
	slices.SortFunc(items, func(a, b scored) int {
		return cmp.Or(cmp.Compare(a.ms, b.ms), cmp.Compare(a.name, b.name), cmp.Compare(a.userID, b.userID))
	})
	ranks := make([]int, len(items))
	for i := range items {
		if i > 0 && items[i].ms == items[i-1].ms {
			ranks[i] = ranks[i-1]
		} else {
			ranks[i] = i + 1
		}
	}
	return ranks
}

// buildLeaderboard ranks rows for a day with levels 1..levels.
func buildLeaderboard(rows []store.DayResult, levels int) leaderboardResponse {
	byLevel := make([][]scored, levels+1)
	type player struct {
		name    string
		levels  []int
		totalMs int64
	}
	players := map[int64]*player{}
	for _, r := range rows {
		if r.Level < minLevel || r.Level > levels {
			continue
		}
		byLevel[r.Level] = append(byLevel[r.Level], scored{r.UserID, r.DisplayName, r.ElapsedMs})
		p := players[r.UserID]
		if p == nil {
			p = &player{name: r.DisplayName}
			players[r.UserID] = p
		}
		p.levels = append(p.levels, r.Level)
		p.totalMs += r.ElapsedMs
	}

	out := leaderboardResponse{
		Puzzles: make([]puzzleBoard, 0, levels),
		Total:   totalBoard{Entries: []totalEntry{}},
		Players: make([]playerJSON, 0, len(players)),
	}
	for level := minLevel; level <= levels; level++ {
		items := byLevel[level]
		ranks := rank(items)
		entries := make([]puzzleEntry, len(items))
		for i, it := range items {
			entries[i] = puzzleEntry{Rank: ranks[i], UserID: userID(it.userID), DisplayName: it.name, ElapsedMs: it.ms}
		}
		out.Puzzles = append(out.Puzzles, puzzleBoard{Level: level, Entries: entries})
	}

	var totals []scored
	for id, p := range players {
		slices.Sort(p.levels)
		out.Players = append(out.Players, playerJSON{UserID: userID(id), DisplayName: p.name, CompletedLevels: p.levels})
		if len(p.levels) == levels-minLevel+1 {
			totals = append(totals, scored{id, p.name, p.totalMs})
		}
	}
	ranks := rank(totals)
	for i, it := range totals {
		out.Total.Entries = append(out.Total.Entries, totalEntry{Rank: ranks[i], UserID: userID(it.userID), DisplayName: it.name, TotalMs: it.ms})
	}
	slices.SortFunc(out.Players, func(a, b playerJSON) int {
		return cmp.Or(cmp.Compare(a.DisplayName, b.DisplayName), cmp.Compare(a.UserID, b.UserID))
	})
	return out
}
