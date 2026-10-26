package store

import (
	"context"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	s, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	s, path := openTemp(t)
	if _, err := s.UpsertUser(ctx, "alice", "Alice"); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s2, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	var version int
	if err := s2.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Errorf("user_version = %d", version)
	}
	u, err := s2.UpsertUser(ctx, "alice", "Alice")
	if err != nil || u.ID != 1 {
		t.Errorf("user lost across reopen: %+v %v", u, err)
	}
	var fk, journal string
	s2.db.QueryRow("PRAGMA foreign_keys").Scan(&fk)
	s2.db.QueryRow("PRAGMA journal_mode").Scan(&journal)
	if fk != "1" || journal != "wal" {
		t.Errorf("pragmas: foreign_keys=%s journal_mode=%s", fk, journal)
	}
}

func TestUpsertUser(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)

	a, err := s.UpsertUser(ctx, "sub-a", "Alice")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.UpsertUser(ctx, "sub-b", "Bob")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Fatal("distinct subjects share an id")
	}
	a2, err := s.UpsertUser(ctx, "sub-a", "Alice Smith")
	if err != nil {
		t.Fatal(err)
	}
	if a2.ID != a.ID || a2.DisplayName != "Alice Smith" {
		t.Errorf("rename: got %+v", a2)
	}
	var name string
	s.db.QueryRow("SELECT display_name FROM users WHERE id = ?", a.ID).Scan(&name)
	if name != "Alice Smith" {
		t.Errorf("stored name = %q", name)
	}
}

func TestUpsertUserConcurrent(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	var wg sync.WaitGroup
	ids := make([]int64, 10)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			u, err := s.UpsertUser(ctx, "same", "Same")
			if err != nil {
				t.Error(err)
			}
			ids[i] = u.ID
		}()
	}
	wg.Wait()
	for _, id := range ids {
		if id != ids[0] {
			t.Fatalf("ids differ: %v", ids)
		}
	}
}

func TestInsertResultIdempotent(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	u, _ := s.UpsertUser(ctx, "alice", "Alice")

	first := Result{UserID: u.ID, Date: "2026-10-26", Level: 1, ElapsedMs: 183000, CompletedAt: "2026-10-26T09:15:00+13:00"}
	got, created, err := s.InsertResult(ctx, first)
	if err != nil || !created || got != first {
		t.Fatalf("first insert: %+v %v %v", got, created, err)
	}

	dup := first
	dup.ElapsedMs = 1000
	dup.CompletedAt = "2026-10-26T10:00:00+13:00"
	got, created, err = s.InsertResult(ctx, dup)
	if err != nil || created {
		t.Fatalf("dup insert: created=%v err=%v", created, err)
	}
	if got != first {
		t.Errorf("dup returned %+v, want stored %+v", got, first)
	}

	other := first
	other.Level = 2
	if _, created, _ := s.InsertResult(ctx, other); !created {
		t.Error("different level should be created")
	}
}

func TestInsertResultRejectsUnknownUser(t *testing.T) {
	s, _ := openTemp(t)
	_, _, err := s.InsertResult(context.Background(), Result{UserID: 42, Date: "2026-10-26", Level: 1, ElapsedMs: 1, CompletedAt: "x"})
	if err == nil {
		t.Error("expected foreign key error")
	}
}

func TestUserAndDayResults(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	alice, _ := s.UpsertUser(ctx, "alice", "Alice")
	bob, _ := s.UpsertUser(ctx, "bob", "Bob")
	add := func(u User, date string, level int, ms int64) {
		t.Helper()
		if _, _, err := s.InsertResult(ctx, Result{UserID: u.ID, Date: date, Level: level, ElapsedMs: ms, CompletedAt: date + "T12:00:00+13:00"}); err != nil {
			t.Fatal(err)
		}
	}
	add(alice, "2026-10-26", 2, 300)
	add(alice, "2026-10-26", 1, 200)
	add(bob, "2026-10-26", 1, 100)
	add(alice, "2026-10-25", 1, 50)

	res, err := s.UserResults(ctx, alice.ID, "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || res[0].Level != 1 || res[1].Level != 2 {
		t.Errorf("user results = %+v", res)
	}
	empty, err := s.UserResults(ctx, bob.ID, "2026-10-01")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("empty results = %#v %v", empty, err)
	}

	day, err := s.DayResults(ctx, "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	want := []DayResult{
		{bob.ID, "Bob", 1, 100},
		{alice.ID, "Alice", 1, 200},
		{alice.ID, "Alice", 2, 300},
	}
	if !reflect.DeepEqual(day, want) {
		t.Errorf("day results = %+v\nwant %+v", day, want)
	}
}
