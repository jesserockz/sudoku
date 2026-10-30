package api

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"testing"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/config"
	"github.com/jesserockz/sudoku/server/internal/version"
)

func TestMe(t *testing.T) {
	srv := newTestServer(t, Deps{})

	resp := do(t, srv, "GET", "/api/v1/me", alice, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	me := decode[meResponse](t, resp)
	if me.ID == "" || me.DisplayName != "Alice" {
		t.Errorf("me = %+v", me)
	}

	// Same subject, new display name: same id, name refreshed.
	me2 := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", "dev:alice:Alice Smith", nil))
	if me2.ID != me.ID || me2.DisplayName != "Alice Smith" {
		t.Errorf("after rename = %+v, first = %+v", me2, me)
	}

	bob := decode[meResponse](t, do(t, srv, "GET", "/api/v1/me", "dev:bob:Bob", nil))
	if bob.ID == me.ID {
		t.Error("different subjects share an id")
	}
}

func TestMeUnauthorized(t *testing.T) {
	srv := newTestServer(t, Deps{})
	for _, token := range []string{"", "garbage", "dev:"} {
		resp := do(t, srv, "GET", "/api/v1/me", token, nil)
		if resp.Header.Get("WWW-Authenticate") == "" {
			t.Errorf("token %q: missing WWW-Authenticate", token)
		}
		expectError(t, resp, http.StatusUnauthorized, "unauthorized")
	}
}

type failingVerifier struct{}

func (failingVerifier) Verify(context.Context, string) (auth.Identity, error) {
	return auth.Identity{}, errors.New("issuer unreachable")
}

func TestVerifierOutageIs500Not401(t *testing.T) {
	srv := newTestServer(t, Deps{Verifier: failingVerifier{}})
	expectError(t, do(t, srv, "GET", "/api/v1/me", "whatever", nil), http.StatusInternalServerError, "internal")
}

func TestConfigIsPublic(t *testing.T) {
	cfg := testConfig()
	cfg.Auth.Mode = config.AuthModeOIDC
	cfg.Timezone = "Europe/London"
	cfg.OIDC = config.OIDC{
		Issuer:   "https://auth.example.com/application/o/sudoku/",
		ClientID: "sudoku-web",
		Audience: []string{"sudoku-web"},
		Scopes:   []string{"openid", "profile", "offline_access"},
	}
	srv := newTestServer(t, Deps{Config: cfg})
	resp := do(t, srv, "GET", "/api/v1/config", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	got := decode[configResponse](t, resp)
	want := configResponse{
		Timezone: "Europe/London",
		OIDC: oidcConfig{
			Issuer:   "https://auth.example.com/application/o/sudoku/",
			ClientID: "sudoku-web",
			Scopes:   []string{"openid", "profile", "offline_access"},
		},
		AuthMode: "oidc",
		Version:  version.Version,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("config = %+v\nwant %+v", got, want)
	}
}
