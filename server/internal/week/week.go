// Package week computes game days and ISO weeks in the fixed game timezone,
// Pacific/Auckland, independent of the host timezone.
package week

import (
	"fmt"
	"time"

	// Embed zoneinfo so the static binary needs no system tzdata.
	_ "time/tzdata"
)

const TimeZone = "Pacific/Auckland"

// DateLayout is the API's calendar date format.
const DateLayout = "2006-01-02"

// Location is Pacific/Auckland.
var Location = mustLoad(TimeZone)

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("load %s: %v", name, err))
	}
	return loc
}

// Date is a calendar date in the game timezone.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// DateOf returns the game date containing instant t.
func DateOf(t time.Time) Date {
	y, m, d := t.In(Location).Date()
	return Date{y, m, d}
}

// ParseDate parses YYYY-MM-DD strictly.
func ParseDate(s string) (Date, error) {
	t, err := time.ParseInLocation(DateLayout, s, Location)
	if err != nil {
		return Date{}, err
	}
	return DateOf(t), nil
}

func (d Date) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.Year, d.Month, d.Day) }

// Start is midnight at the start of d in the game timezone.
func (d Date) Start() time.Time { return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, Location) }

// AddDays returns d shifted by n calendar days.
func (d Date) AddDays(n int) Date {
	y, m, dd := time.Date(d.Year, d.Month, d.Day+n, 12, 0, 0, 0, time.UTC).Date()
	return Date{y, m, dd}
}

// DaysSince returns the number of calendar days from o to d (d - o).
func (d Date) DaysSince(o Date) int {
	a := time.Date(d.Year, d.Month, d.Day, 12, 0, 0, 0, time.UTC)
	b := time.Date(o.Year, o.Month, o.Day, 12, 0, 0, 0, time.UTC)
	return int(a.Sub(b).Hours() / 24)
}

func (d Date) Before(o Date) bool { return d.DaysSince(o) < 0 }
func (d Date) After(o Date) bool  { return d.DaysSince(o) > 0 }

// Weekday returns the ISO day of week: 1 = Monday … 7 = Sunday.
func (d Date) Weekday() int {
	wd := int(time.Date(d.Year, d.Month, d.Day, 12, 0, 0, 0, time.UTC).Weekday())
	if wd == 0 {
		return 7
	}
	return wd
}

// ISOWeek returns the ISO 8601 week containing d, e.g. "2026-W44".
func (d Date) ISOWeek() string {
	y, w := time.Date(d.Year, d.Month, d.Day, 12, 0, 0, 0, time.UTC).ISOWeek()
	return fmt.Sprintf("%04d-W%02d", y, w)
}

// Info describes the game day and ISO week containing an instant.
type Info struct {
	ISOWeek   string
	WeekStart Date
	WeekEnd   Date
	Today     Date
	DayOfWeek int
}

func InfoAt(t time.Time) Info {
	today := DateOf(t)
	dow := today.Weekday()
	start := today.AddDays(1 - dow)
	return Info{
		ISOWeek:   today.ISOWeek(),
		WeekStart: start,
		WeekEnd:   start.AddDays(6),
		Today:     today,
		DayOfWeek: dow,
	}
}
