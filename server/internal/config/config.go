// Package config loads server configuration from an optional TOML file,
// then applies SUDOKU_* environment variable overrides.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	// Embed zoneinfo so any IANA timezone works without system tzdata.
	_ "time/tzdata"

	"github.com/BurntSushi/toml"
)

const (
	AuthModeOIDC = "oidc"
	AuthModeDev  = "dev"
)

// minSecretLen is the minimum server secret length in bytes. The secret keys
// the weekly seed HMAC, so a short one would make seeds guessable.
const minSecretLen = 16

// Bounds and default for the number of puzzle levels per day.
const (
	DefaultLevels = 5
	MinLevels     = 1
	MaxLevels     = 10
)

// DefaultTimezone is the game timezone when none is configured.
const DefaultTimezone = "UTC"

type Config struct {
	// Bind is the listen address. Defaults to localhost; Caddy proxies to it.
	Bind string `toml:"bind"`
	// DBPath is the SQLite database file.
	DBPath string `toml:"db_path"`
	// ServerSecret keys the weekly seed derivation. Its UTF-8 bytes are the
	// HMAC key. Must never change for the life of the deployment.
	ServerSecret string `toml:"server_secret"`
	// WebDir is the compiled web client. Empty disables static serving.
	WebDir string `toml:"web_dir"`
	// Timezone is the IANA zone that defines the game's days and weeks for
	// every player, regardless of host or device timezone.
	Timezone string `toml:"timezone"`
	// Levels is the number of puzzles (difficulty levels 1..Levels) per day.
	// A change applies from the next ISO week; see store.ScheduleLevels.
	Levels int `toml:"levels"`

	Auth Auth `toml:"auth"`
	OIDC OIDC `toml:"oidc"`
}

type Auth struct {
	// Mode is "oidc" (production) or "dev" (unsigned dev tokens).
	Mode string `toml:"mode"`
}

type OIDC struct {
	// Issuer must exactly match the token's iss claim, e.g.
	// "https://auth.example.com/application/o/sudoku/".
	Issuer string `toml:"issuer"`
	// Audience lists the accepted aud values. Authentik sets aud to the
	// client id, so list every client (web, android). Defaults to [ClientID].
	Audience []string `toml:"audience"`
	// ClientID and Scopes are what the web client uses to log in; they are
	// published via /api/v1/config.
	ClientID string   `toml:"client_id"`
	Scopes   []string `toml:"scopes"`
}

func Default() Config {
	return Config{
		Bind:     "127.0.0.1:8080",
		DBPath:   "sudoku.db",
		Timezone: DefaultTimezone,
		Levels:   DefaultLevels,
		Auth:     Auth{Mode: AuthModeOIDC},
		OIDC: OIDC{
			Scopes: []string{"openid", "profile", "offline_access"},
		},
	}
}

// Load reads the TOML file at path (skipped when path is empty), applies
// environment overrides from getenv, fills derived defaults and validates.
func Load(path string, getenv func(string) string) (Config, error) {
	cfg := Default()
	if path != "" {
		md, err := toml.DecodeFile(path, &cfg)
		if err != nil {
			return Config{}, fmt.Errorf("read config %s: %w", path, err)
		}
		if undec := md.Undecoded(); len(undec) > 0 {
			return Config{}, fmt.Errorf("read config %s: unknown keys %v", path, undec)
		}
	}
	if err := applyEnv(&cfg, getenv); err != nil {
		return Config{}, err
	}
	if len(cfg.OIDC.Audience) == 0 && cfg.OIDC.ClientID != "" {
		cfg.OIDC.Audience = []string{cfg.OIDC.ClientID}
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(cfg *Config, getenv func(string) string) error {
	str := func(key string, dst *string) {
		if v := getenv(key); v != "" {
			*dst = v
		}
	}
	list := func(key string, dst *[]string) {
		if v := getenv(key); v != "" {
			*dst = splitList(v)
		}
	}
	str("SUDOKU_BIND", &cfg.Bind)
	str("SUDOKU_DB_PATH", &cfg.DBPath)
	str("SUDOKU_SERVER_SECRET", &cfg.ServerSecret)
	str("SUDOKU_WEB_DIR", &cfg.WebDir)
	str("SUDOKU_TIMEZONE", &cfg.Timezone)
	str("SUDOKU_AUTH_MODE", &cfg.Auth.Mode)
	str("SUDOKU_OIDC_ISSUER", &cfg.OIDC.Issuer)
	list("SUDOKU_OIDC_AUDIENCE", &cfg.OIDC.Audience)
	str("SUDOKU_OIDC_CLIENT_ID", &cfg.OIDC.ClientID)
	list("SUDOKU_OIDC_SCOPES", &cfg.OIDC.Scopes)
	if v := getenv("SUDOKU_LEVELS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("SUDOKU_LEVELS: %q is not a number", v)
		}
		cfg.Levels = n
	}
	return nil
}

// splitList splits on commas and whitespace, dropping empty items.
func splitList(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
}

func (c Config) Validate() error {
	var errs []error
	if c.Bind == "" {
		errs = append(errs, errors.New("bind must be set"))
	}
	if c.DBPath == "" {
		errs = append(errs, errors.New("db_path must be set"))
	}
	if c.Timezone == "" {
		errs = append(errs, errors.New("timezone must be set"))
	} else if _, err := time.LoadLocation(c.Timezone); err != nil {
		errs = append(errs, fmt.Errorf("timezone: %w", err))
	}
	if c.Levels < MinLevels || c.Levels > MaxLevels {
		errs = append(errs, fmt.Errorf("levels must be %d..%d, got %d", MinLevels, MaxLevels, c.Levels))
	}
	if len(c.ServerSecret) < minSecretLen {
		errs = append(errs, fmt.Errorf("server_secret must be at least %d bytes", minSecretLen))
	}
	switch c.Auth.Mode {
	case AuthModeDev:
	case AuthModeOIDC:
		if c.OIDC.Issuer == "" {
			errs = append(errs, errors.New("oidc.issuer must be set in oidc auth mode"))
		}
		if len(c.OIDC.Audience) == 0 {
			errs = append(errs, errors.New("oidc.audience or oidc.client_id must be set in oidc auth mode"))
		}
	default:
		errs = append(errs, fmt.Errorf("auth.mode must be %q or %q, got %q", AuthModeOIDC, AuthModeDev, c.Auth.Mode))
	}
	return errors.Join(errs...)
}
