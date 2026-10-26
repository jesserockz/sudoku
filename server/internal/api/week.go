package api

import (
	"net/http"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/seed"
	"github.com/jesserockz/sudoku/server/internal/week"
)

type weekResponse struct {
	ISOWeek   string `json:"isoWeek"`
	Seed      string `json:"seed"`
	WeekStart string `json:"weekStart"`
	WeekEnd   string `json:"weekEnd"`
	Today     string `json:"today"`
	DayOfWeek int    `json:"dayOfWeek"`
	Timezone  string `json:"timezone"`
	// Levels is how many puzzles (levels 1..Levels) each day of this week has.
	Levels int `json:"levels"`
}

func (s *Server) getWeek(w http.ResponseWriter, r *http.Request) {
	info := week.InfoAt(s.deps.Clock.Now(), s.loc)
	levels, err := s.levelsFor(r.Context(), info.Today)
	if err != nil {
		httpx.Internal(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, weekResponse{
		ISOWeek:   info.ISOWeek,
		Seed:      seed.ForWeek([]byte(s.deps.Config.ServerSecret), info.ISOWeek),
		WeekStart: info.WeekStart.String(),
		WeekEnd:   info.WeekEnd.String(),
		Today:     info.Today.String(),
		DayOfWeek: info.DayOfWeek,
		Timezone:  s.deps.Config.Timezone,
		Levels:    levels,
	})
}
