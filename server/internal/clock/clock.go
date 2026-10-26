// Package clock abstracts the current time so tests can control it.
package clock

import (
	"sync"
	"time"
)

type Clock interface {
	Now() time.Time
}

// System is the real wall clock.
type System struct{}

func (System) Now() time.Time { return time.Now() }

// Fake is a settable clock for tests.
type Fake struct {
	mu sync.Mutex
	t  time.Time
}

func NewFake(t time.Time) *Fake { return &Fake{t: t} }

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *Fake) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = t
}

func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}
