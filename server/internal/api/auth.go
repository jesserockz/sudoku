package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/version"
)

type userKey struct{}

// currentUser returns the user set by requireAuth.
func currentUser(r *http.Request) store.User {
	return r.Context().Value(userKey{}).(store.User)
}

// userID is the opaque id the API exposes for a user.
func userID(id int64) string { return strconv.FormatInt(id, 10) }

// requireAuth verifies the bearer token, upserts the caller's user record
// and makes it available via currentUser.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := auth.BearerToken(r)
		if !ok {
			unauthorized(w, "missing bearer token")
			return
		}
		id, err := s.deps.Verifier.Verify(r.Context(), token)
		if errors.Is(err, auth.ErrInvalidToken) {
			slog.Info("rejected token", "err", err)
			unauthorized(w, "invalid or expired token")
			return
		}
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		user, err := s.deps.Store.UpsertUser(r.Context(), id.Subject, id.DisplayName)
		if err != nil {
			httpx.Internal(w, r, err)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey{}, user)))
	}
}

func unauthorized(w http.ResponseWriter, msg string) {
	w.Header().Set("WWW-Authenticate", `Bearer`)
	httpx.Error(w, http.StatusUnauthorized, httpx.CodeUnauthorized, msg)
}

type meResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	httpx.WriteJSON(w, http.StatusOK, meResponse{ID: userID(u.ID), DisplayName: u.DisplayName})
}

type configResponse struct {
	Timezone string     `json:"timezone"`
	OIDC     oidcConfig `json:"oidc"`
	AuthMode string     `json:"authMode"`
	Version  string     `json:"version"`
}

type oidcConfig struct {
	Issuer   string   `json:"issuer"`
	ClientID string   `json:"clientId"`
	Scopes   []string `json:"scopes"`
}

func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	c := s.deps.Config
	scopes := c.OIDC.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	httpx.WriteJSON(w, http.StatusOK, configResponse{
		Timezone: c.Timezone,
		OIDC:     oidcConfig{Issuer: c.OIDC.Issuer, ClientID: c.OIDC.ClientID, Scopes: scopes},
		AuthMode: c.Auth.Mode,
		Version:  version.Version,
	})
}
