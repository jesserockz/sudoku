package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadFile(t *testing.T) {
	path := writeFile(t, `
bind = "127.0.0.1:9000"
db_path = "/var/lib/sudoku/sudoku.db"
server_secret = "`+testSecret+`"
web_dir = "/opt/sudoku/web"

[auth]
mode = "oidc"

[oidc]
issuer = "https://auth.example.com/application/o/sudoku/"
client_id = "sudoku-web"
`)
	cfg, err := Load(path, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Bind:         "127.0.0.1:9000",
		DBPath:       "/var/lib/sudoku/sudoku.db",
		ServerSecret: testSecret,
		WebDir:       "/opt/sudoku/web",
		Timezone:     "UTC",
		Levels:       5,
		Auth:         Auth{Mode: AuthModeOIDC},
		OIDC: OIDC{
			Issuer:   "https://auth.example.com/application/o/sudoku/",
			Audience: []string{"sudoku-web"},
			ClientID: "sudoku-web",
			Scopes:   []string{"openid", "profile", "offline_access"},
		},
	}
	if !reflect.DeepEqual(cfg, want) {
		t.Errorf("got %+v\nwant %+v", cfg, want)
	}
}

func TestEnvOverridesFile(t *testing.T) {
	path := writeFile(t, `
server_secret = "file-secret-is-long-enough"
[auth]
mode = "oidc"
[oidc]
issuer = "https://file.example.com/"
client_id = "file-client"
`)
	cfg, err := Load(path, envMap(map[string]string{
		"SUDOKU_BIND":           "0.0.0.0:1234",
		"SUDOKU_DB_PATH":        "/tmp/x.db",
		"SUDOKU_SERVER_SECRET":  testSecret,
		"SUDOKU_WEB_DIR":        "/web",
		"SUDOKU_TIMEZONE":       "Europe/London",
		"SUDOKU_LEVELS":         "3",
		"SUDOKU_OIDC_ISSUER":    "https://env.example.com/",
		"SUDOKU_OIDC_AUDIENCE":  "sudoku-web, sudoku-android",
		"SUDOKU_OIDC_CLIENT_ID": "env-client",
		"SUDOKU_OIDC_SCOPES":    "openid profile",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Bind != "0.0.0.0:1234" || cfg.DBPath != "/tmp/x.db" || cfg.ServerSecret != testSecret || cfg.WebDir != "/web" || cfg.Timezone != "Europe/London" || cfg.Levels != 3 {
		t.Errorf("scalar overrides not applied: %+v", cfg)
	}
	if cfg.OIDC.Issuer != "https://env.example.com/" || cfg.OIDC.ClientID != "env-client" {
		t.Errorf("oidc overrides not applied: %+v", cfg.OIDC)
	}
	if !reflect.DeepEqual(cfg.OIDC.Audience, []string{"sudoku-web", "sudoku-android"}) {
		t.Errorf("audience = %q", cfg.OIDC.Audience)
	}
	if !reflect.DeepEqual(cfg.OIDC.Scopes, []string{"openid", "profile"}) {
		t.Errorf("scopes = %q", cfg.OIDC.Scopes)
	}
}

func TestDevModeFromEnvOnly(t *testing.T) {
	cfg, err := Load("", envMap(map[string]string{
		"SUDOKU_SERVER_SECRET": testSecret,
		"SUDOKU_AUTH_MODE":     "dev",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Bind != "127.0.0.1:8080" {
		t.Errorf("default bind = %q, want localhost", cfg.Bind)
	}
	if cfg.Timezone != "UTC" {
		t.Errorf("default timezone = %q, want UTC", cfg.Timezone)
	}
	if cfg.Auth.Mode != AuthModeDev {
		t.Errorf("mode = %q", cfg.Auth.Mode)
	}
}

func TestValidationErrors(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing secret", map[string]string{"SUDOKU_AUTH_MODE": "dev"}, "server_secret"},
		{"short secret", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": "short"}, "server_secret"},
		{"unknown timezone", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_TIMEZONE": "Mars/Olympus_Mons"}, "timezone"},
		{"zero levels", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_LEVELS": "0"}, "levels"},
		{"too many levels", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_LEVELS": "11"}, "levels"},
		{"non-numeric levels", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_LEVELS": "five"}, "SUDOKU_LEVELS"},
		{"bad mode", map[string]string{"SUDOKU_AUTH_MODE": "none", "SUDOKU_SERVER_SECRET": testSecret}, "auth.mode"},
		{"oidc without issuer", map[string]string{"SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_OIDC_CLIENT_ID": "c"}, "oidc.issuer"},
		{"admin claim without values", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_ADMIN_CLAIM": "groups"}, "admin.claim and admin.values must be set together"},
		{"admin values without claim", map[string]string{"SUDOKU_AUTH_MODE": "dev", "SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_ADMIN_VALUES": "a"}, "admin.claim and admin.values must be set together"},
		{"oidc without audience", map[string]string{"SUDOKU_SERVER_SECRET": testSecret, "SUDOKU_OIDC_ISSUER": "https://x/"}, "oidc.audience"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load("", envMap(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want mention of %q", err, tt.want)
			}
		})
	}
}

func TestUnknownKeyRejected(t *testing.T) {
	path := writeFile(t, `
server_secret = "`+testSecret+`"
bnid = "typo"
[auth]
mode = "dev"
`)
	if _, err := Load(path, envMap(nil)); err == nil || !strings.Contains(err.Error(), "bnid") {
		t.Errorf("err = %v, want unknown key error", err)
	}
}

func TestAdminFromFileAndEnv(t *testing.T) {
	path := writeFile(t, `
server_secret = "`+testSecret+`"
[auth]
mode = "dev"
[admin]
claim = "groups"
values = ["sudoku-admins"]
`)
	cfg, err := Load(path, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if want := (Admin{Claim: "groups", Values: []string{"sudoku-admins"}}); !reflect.DeepEqual(cfg.Admin, want) {
		t.Errorf("admin = %+v, want %+v", cfg.Admin, want)
	}

	cfg, err = Load(path, envMap(map[string]string{
		"SUDOKU_ADMIN_CLAIM":  "realm_access.roles",
		"SUDOKU_ADMIN_VALUES": "a, b",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if want := (Admin{Claim: "realm_access.roles", Values: []string{"a", "b"}}); !reflect.DeepEqual(cfg.Admin, want) {
		t.Errorf("admin = %+v, want %+v", cfg.Admin, want)
	}
}
