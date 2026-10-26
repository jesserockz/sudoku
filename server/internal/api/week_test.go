package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/clock"
)

func TestGetWeekRollsOverAtAucklandMidnight(t *testing.T) {
	// 2026-10-25T10:59:59Z is Sunday 23:59:59 in Auckland (NZDT, +13).
	clk := clock.NewFake(time.Date(2026, 10, 25, 10, 59, 59, 0, time.UTC))
	srv := newTestServer(t, Deps{Clock: clk})

	get := func() weekResponse {
		t.Helper()
		resp := do(t, srv, "GET", "/api/v1/week", alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		return decode[weekResponse](t, resp)
	}

	sunday := get()
	want := weekResponse{
		ISOWeek: "2026-W43", WeekStart: "2026-10-19", WeekEnd: "2026-10-25",
		Today: "2026-10-25", DayOfWeek: 7, Timezone: "Pacific/Auckland",
	}
	want.Seed = sunday.Seed
	if sunday != want {
		t.Errorf("sunday = %+v\nwant %+v", sunday, want)
	}

	clk.Advance(time.Second)
	monday := get()
	want = weekResponse{
		ISOWeek: "2026-W44", Seed: "e4d2e1e00e3549cc", WeekStart: "2026-10-26", WeekEnd: "2026-11-01",
		Today: "2026-10-26", DayOfWeek: 1, Timezone: "Pacific/Auckland",
	}
	if monday != want {
		t.Errorf("monday = %+v\nwant %+v", monday, want)
	}
	if sunday.Seed == monday.Seed {
		t.Error("seed should change with the week")
	}
}

func TestGetWeekUsesConfiguredTimezone(t *testing.T) {
	// Monday 00:00 in Auckland, but still Sunday morning in London.
	cfg := testConfig()
	cfg.Timezone = "Europe/London"
	clk := clock.NewFake(time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC))
	srv := newTestServer(t, Deps{Config: cfg, Clock: clk})

	got := decode[weekResponse](t, do(t, srv, "GET", "/api/v1/week", alice, nil))
	if got.ISOWeek != "2026-W43" || got.Today != "2026-10-25" || got.DayOfWeek != 7 || got.Timezone != "Europe/London" {
		t.Errorf("week = %+v", got)
	}

	// London's Monday starts at 00:00 GMT (after the 25 Oct DST end).
	clk.Set(time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC))
	if got := decode[weekResponse](t, do(t, srv, "GET", "/api/v1/week", alice, nil)); got.ISOWeek != "2026-W44" || got.Today != "2026-10-26" {
		t.Errorf("after London midnight = %+v", got)
	}
}

func TestGetWeekRequiresAuth(t *testing.T) {
	srv := newTestServer(t, Deps{})
	expectError(t, do(t, srv, "GET", "/api/v1/week", "", nil), http.StatusUnauthorized, "unauthorized")
}
