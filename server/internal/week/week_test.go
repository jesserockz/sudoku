package week

import (
	"testing"
	"time"
)

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestInfoAt(t *testing.T) {
	tests := []struct {
		name  string
		at    string // instant, any offset
		week  string
		start string
		end   string
		today string
		dow   int
	}{
		// Plain mid-week day. NZDT is +13.
		{"wednesday", "2026-10-28T01:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-28", 3},

		// Week rollover at Auckland midnight, not UTC midnight.
		{"sunday last second", "2026-10-25T10:59:59Z", "2026-W43", "2026-10-19", "2026-10-25", "2026-10-25", 7},
		{"monday first second", "2026-10-25T11:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-26", 1},

		// DST starts Sun 2026-09-27 02:00 NZST -> 03:00 NZDT.
		{"before DST start", "2026-09-26T13:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7},
		{"after DST start", "2026-09-26T14:00:00Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7},
		// The following Monday starts at 00:00 +13 = 11:00Z Sunday.
		{"week after DST start, Sunday end", "2026-09-27T10:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7},
		{"week after DST start, Monday", "2026-09-27T11:00:00Z", "2026-W40", "2026-09-28", "2026-10-04", "2026-09-28", 1},

		// DST ends Sun 2026-04-05 03:00 NZDT -> 02:00 NZST. Monday 00:00 +12 = 12:00Z.
		{"DST end Sunday late", "2026-04-05T11:59:59Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7},
		{"DST end next Monday", "2026-04-05T12:00:00Z", "2026-W15", "2026-04-06", "2026-04-12", "2026-04-06", 1},
		// Ambiguous hour (02:30 happens twice) is still the same day.
		{"DST end repeated hour", "2026-04-04T14:30:00Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7},

		// 2020 has 53 ISO weeks: 2020-W53 = 2020-12-28..2021-01-03.
		{"2020-W53 new year's day", "2021-01-01T00:00:00+13:00", "2020-W53", "2020-12-28", "2021-01-03", "2021-01-01", 5},
		{"2021-W01 monday", "2021-01-04T00:00:00+13:00", "2021-W01", "2021-01-04", "2021-01-10", "2021-01-04", 1},
		// 2025-12-29 belongs to 2026-W01.
		{"2026-W01 starts in 2025", "2025-12-29T09:00:00+13:00", "2026-W01", "2025-12-29", "2026-01-04", "2025-12-29", 1},
		// 2026 starts on a Thursday, so it also has a W53: 2026-12-28..2027-01-03.
		{"2026-W53", "2026-12-31T12:00:00+13:00", "2026-W53", "2026-12-28", "2027-01-03", "2026-12-31", 4},
		// UTC is still 2026-12-31 but Auckland is already 2027-01-01.
		{"auckland new year before UTC", "2026-12-31T11:00:00Z", "2026-W53", "2026-12-28", "2027-01-03", "2027-01-01", 5},
		{"2027-W01", "2027-01-04T00:00:00+13:00", "2027-W01", "2027-01-04", "2027-01-10", "2027-01-04", 1},
		// 2027 starts on a Friday: no 2027-W53, 2027-12-27 starts 2027-W52.
		{"2027-W52 last week", "2028-01-02T12:00:00+13:00", "2027-W52", "2027-12-27", "2028-01-02", "2028-01-02", 7},
		{"2028-W01", "2028-01-03T00:00:00+13:00", "2028-W01", "2028-01-03", "2028-01-09", "2028-01-03", 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := InfoAt(utc(tt.at))
			if got.ISOWeek != tt.week || got.WeekStart.String() != tt.start || got.WeekEnd.String() != tt.end ||
				got.Today.String() != tt.today || got.DayOfWeek != tt.dow {
				t.Errorf("InfoAt(%s) = {%s %s %s %s %d}, want {%s %s %s %s %d}", tt.at,
					got.ISOWeek, got.WeekStart, got.WeekEnd, got.Today, got.DayOfWeek,
					tt.week, tt.start, tt.end, tt.today, tt.dow)
			}
		})
	}
}

func TestIndependentOfHostTimezone(t *testing.T) {
	at := utc("2026-10-25T11:00:00Z")
	for _, name := range []string{"UTC", "America/Los_Angeles", "Asia/Tokyo"} {
		loc, err := time.LoadLocation(name)
		if err != nil {
			t.Fatal(err)
		}
		if got := InfoAt(at.In(loc)); got.Today.String() != "2026-10-26" || got.ISOWeek != "2026-W44" {
			t.Errorf("%s: got %s %s", name, got.Today, got.ISOWeek)
		}
	}
}

func TestDateHelpers(t *testing.T) {
	d, err := ParseDate("2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	if got := d.AddDays(-8).String(); got != "2026-10-18" {
		t.Errorf("AddDays(-8) = %s", got)
	}
	if got := d.AddDays(7).String(); got != "2026-11-02" {
		t.Errorf("AddDays(7) = %s", got)
	}
	// Across DST start: still whole days.
	a, _ := ParseDate("2026-09-20")
	b, _ := ParseDate("2026-10-04")
	if n := b.DaysSince(a); n != 14 {
		t.Errorf("DaysSince = %d", n)
	}
	if !a.Before(b) || !b.After(a) || a.After(a) {
		t.Error("Before/After wrong")
	}
	if got := d.Start().Format(time.RFC3339); got != "2026-10-26T00:00:00+13:00" {
		t.Errorf("Start = %s", got)
	}
	for _, bad := range []string{"", "2026-1-26", "2026-02-30", "26-10-2026", "2026-10-26T00:00:00Z"} {
		if _, err := ParseDate(bad); err == nil {
			t.Errorf("ParseDate(%q) should fail", bad)
		}
	}
}
