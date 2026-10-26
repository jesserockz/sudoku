package api

import (
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/week"
)

// 2026-10-26 09:00 in Auckland (Monday).
var mondayMorning = time.Date(2026, 10, 26, 9, 0, 0, 0, week.Location)

func validResult() map[string]any {
	return map[string]any{
		"date":        "2026-10-26",
		"level":       1,
		"elapsedMs":   183000,
		"completedAt": "2026-10-26T09:15:00+13:00",
	}
}

func with(m map[string]any, k string, v any) map[string]any {
	out := map[string]any{}
	for kk, vv := range m {
		out[kk] = vv
	}
	if v == nil {
		delete(out, k)
	} else {
		out[k] = v
	}
	return out
}

func TestPostResultCaps(t *testing.T) {
	srv := newTestServer(t, Deps{Clock: clock.NewFake(mondayMorning)})
	base := validResult()
	tests := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"valid", base, http.StatusCreated, ""},
		{"level 5", with(base, "level", 5), http.StatusCreated, ""},
		{"level 0", with(base, "level", 0), http.StatusBadRequest, "invalid_result"},
		{"level 6", with(base, "level", 6), http.StatusBadRequest, "invalid_result"},
		{"min elapsed", with(with(base, "level", 2), "elapsedMs", 5000), http.StatusCreated, ""},
		{"below min elapsed", with(base, "elapsedMs", 4999), http.StatusBadRequest, "invalid_result"},
		{"negative elapsed", with(base, "elapsedMs", -1), http.StatusBadRequest, "invalid_result"},
		{"max elapsed", with(with(base, "level", 3), "elapsedMs", 86400000), http.StatusCreated, ""},
		{"above max elapsed", with(base, "elapsedMs", 86400001), http.StatusBadRequest, "invalid_result"},
		{"8 days ago", with(base, "date", "2026-10-18"), http.StatusCreated, ""},
		{"9 days ago", with(base, "date", "2026-10-17"), http.StatusBadRequest, "invalid_result"},
		{"tomorrow", with(base, "date", "2026-10-27"), http.StatusBadRequest, "invalid_result"},
		{"bad date", with(base, "date", "26/10/2026"), http.StatusBadRequest, "invalid_result"},
		{"bad completedAt", with(base, "completedAt", "yesterday"), http.StatusBadRequest, "invalid_result"},
		{"completedAt without offset", with(base, "completedAt", "2026-10-26T09:15:00"), http.StatusBadRequest, "invalid_result"},
		{"missing level", with(base, "level", nil), http.StatusBadRequest, "bad_request"},
		{"missing completedAt", with(base, "completedAt", nil), http.StatusBadRequest, "bad_request"},
		{"fractional elapsed", with(base, "elapsedMs", 1.5), http.StatusBadRequest, "bad_request"},
		{"string level", with(base, "level", "1"), http.StatusBadRequest, "bad_request"},
		{"not an object", []int{1, 2}, http.StatusBadRequest, "bad_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A fresh user per case so earlier results don't make this one a duplicate.
			resp := do(t, srv, "POST", "/api/v1/results", "dev:"+tt.name+":X", tt.body)
			if tt.code != "" {
				expectError(t, resp, tt.status, tt.code)
				return
			}
			if resp.StatusCode != tt.status {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.status)
			}
			resp.Body.Close()
		})
	}
}

func TestPostResultRequiresAuth(t *testing.T) {
	srv := newTestServer(t, Deps{Clock: clock.NewFake(mondayMorning)})
	expectError(t, do(t, srv, "POST", "/api/v1/results", "", validResult()), http.StatusUnauthorized, "unauthorized")
}

func TestPostResultIdempotent(t *testing.T) {
	srv := newTestServer(t, Deps{Clock: clock.NewFake(mondayMorning)})

	resp := do(t, srv, "POST", "/api/v1/results", alice, validResult())
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first status = %d", resp.StatusCode)
	}
	first := decode[resultJSON](t, resp)
	want := resultJSON{Date: "2026-10-26", Level: 1, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00"}
	if first != want {
		t.Errorf("first = %+v", first)
	}

	// A different retry: first one wins, stored result returned.
	resp = do(t, srv, "POST", "/api/v1/results", alice, with(with(validResult(), "elapsedMs", 6000), "completedAt", "2026-10-26T10:00:00Z"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("duplicate status = %d", resp.StatusCode)
	}
	if dup := decode[resultJSON](t, resp); dup != want {
		t.Errorf("duplicate returned %+v, want stored %+v", dup, want)
	}

	// Another user is independent.
	resp = do(t, srv, "POST", "/api/v1/results", "dev:bob:Bob", validResult())
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("bob status = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestPostResultUsesAucklandToday(t *testing.T) {
	// 2026-10-26T10:59:59Z is still Monday in Auckland; 11:00Z is Tuesday.
	clk := clock.NewFake(time.Date(2026, 10, 26, 10, 59, 59, 0, time.UTC))
	srv := newTestServer(t, Deps{Clock: clk})
	tuesday := with(validResult(), "date", "2026-10-27")
	expectError(t, do(t, srv, "POST", "/api/v1/results", alice, tuesday), http.StatusBadRequest, "invalid_result")

	clk.Advance(time.Second)
	resp := do(t, srv, "POST", "/api/v1/results", alice, tuesday)
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("status after rollover = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestGetMyResults(t *testing.T) {
	clk := clock.NewFake(mondayMorning)
	srv := newTestServer(t, Deps{Clock: clk})
	post := func(token string, body map[string]any) {
		t.Helper()
		resp := do(t, srv, "POST", "/api/v1/results", token, body)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("post status = %d", resp.StatusCode)
		}
		resp.Body.Close()
	}
	post(alice, with(validResult(), "level", 3))
	post(alice, validResult())
	post(alice, with(validResult(), "date", "2026-10-25"))
	post("dev:bob:Bob", with(validResult(), "level", 2))

	get := func(path string) myResultsResponse {
		t.Helper()
		resp := do(t, srv, "GET", path, alice, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		return decode[myResultsResponse](t, resp)
	}

	today := get("/api/v1/me/results")
	if today.Date != "2026-10-26" || len(today.Results) != 2 || today.Results[0].Level != 1 || today.Results[1].Level != 3 {
		t.Errorf("today = %+v", today)
	}
	sunday := get("/api/v1/me/results?date=2026-10-25")
	want := myResultsResponse{Date: "2026-10-25", Results: []resultJSON{
		{Date: "2026-10-25", Level: 1, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00"},
	}}
	if !reflect.DeepEqual(sunday, want) {
		t.Errorf("sunday = %+v", sunday)
	}
	// Empty days give an empty array, not null.
	resp := do(t, srv, "GET", "/api/v1/me/results?date=2026-01-01", alice, nil)
	raw := decode[map[string]any](t, resp)
	if res, ok := raw["results"].([]any); !ok || len(res) != 0 {
		t.Errorf("empty results = %#v", raw["results"])
	}

	expectError(t, do(t, srv, "GET", "/api/v1/me/results?date=bad", alice, nil), http.StatusBadRequest, "bad_request")
	expectError(t, do(t, srv, "GET", "/api/v1/me/results", "", nil), http.StatusUnauthorized, "unauthorized")
}
