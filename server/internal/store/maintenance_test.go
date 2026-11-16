package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestMaintenanceDefaultsToOff(t *testing.T) {
	s, _ := openTemp(t)
	m, err := s.Maintenance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m.Enabled || m.Until != nil {
		t.Errorf("default = %+v, want off with no end", m)
	}
}

func TestSetMaintenance(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	// An offset time is stored as UTC.
	nz := time.FixedZone("NZDT", 13*3600)
	end := time.Date(2026, 11, 17, 15, 0, 0, 0, nz)
	if err := s.SetMaintenance(ctx, Maintenance{Enabled: true, Until: &end}); err != nil {
		t.Fatal(err)
	}
	m, err := s.Maintenance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !m.Enabled || m.Until == nil || !m.Until.Equal(end) || m.Until.Location() != time.UTC {
		t.Errorf("got %+v, want enabled until %v in UTC", m, end)
	}
	var raw string
	if err := s.db.QueryRow(`SELECT until FROM maintenance_settings`).Scan(&raw); err != nil || raw != "2026-11-17T02:00:00Z" {
		t.Errorf("stored until = %q (%v)", raw, err)
	}

	// Clearing the end and switching off.
	if err := s.SetMaintenance(ctx, Maintenance{}); err != nil {
		t.Fatal(err)
	}
	if m, err = s.Maintenance(ctx); err != nil || m.Enabled || m.Until != nil {
		t.Errorf("after clearing: %+v, %v", m, err)
	}

	// Without the row (never the case after migrating), setting creates it.
	if _, err := s.db.Exec(`DELETE FROM maintenance_settings`); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMaintenance(ctx, Maintenance{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if m, err = s.Maintenance(ctx); err != nil || !m.Enabled {
		t.Errorf("recreated row: %+v, %v", m, err)
	}
}

func TestMaintenanceFailures(t *testing.T) {
	ctx := context.Background()
	s, _ := openTemp(t)
	if _, err := s.db.Exec(`UPDATE maintenance_settings SET until = 'soon'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Maintenance(ctx); err == nil || !strings.Contains(err.Error(), "maintenance until") {
		t.Errorf("bad until: err = %v", err)
	}
	if _, err := s.db.Exec(`DELETE FROM maintenance_settings`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Maintenance(ctx); err == nil || !strings.Contains(err.Error(), "maintenance:") {
		t.Errorf("missing row: err = %v", err)
	}
	s.Close()
	if err := s.SetMaintenance(ctx, Maintenance{Enabled: true}); err == nil || !strings.Contains(err.Error(), "set maintenance") {
		t.Errorf("closed store: err = %v", err)
	}
}

// A database from before maintenance mode (user_version 8) gets the
// maintenance table, switched off.
func TestMigrateAddsMaintenance(t *testing.T) {
	ctx := context.Background()
	s, path := openTemp(t)
	if _, err := s.db.Exec(`DROP TABLE maintenance_settings; PRAGMA user_version = 8`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	var version int
	if err := s2.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 9 {
		t.Errorf("user_version = %d (%v), want 9", version, err)
	}
	if m, err := s2.Maintenance(ctx); err != nil || m.Enabled {
		t.Errorf("maintenance after upgrade: %+v, %v", m, err)
	}
}
