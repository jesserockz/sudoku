package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jesserockz/sudoku/server/internal/httpx"
	"github.com/jesserockz/sudoku/server/internal/update"
)

// Updater is what the admin routes need from the self-updater
// (*update.Updater).
type Updater interface {
	Info() update.Info
	Status() update.Status
	Releases(ctx context.Context, prereleases bool) ([]update.Release, error)
	Start(ctx context.Context, tag string, allowDowngrade bool) (update.Status, error)
	Rollback() (update.Status, error)
}

// writeUpdateError maps an update failure to the API error envelope.
func writeUpdateError(w http.ResponseWriter, r *http.Request, err error) {
	var (
		status int
		code   string
	)
	switch {
	case errors.Is(err, update.ErrInvalidTag):
		status, code = http.StatusBadRequest, httpx.CodeBadRequest
	case errors.Is(err, update.ErrBusy):
		status, code = http.StatusConflict, httpx.CodeUpdateInProgress
	case errors.Is(err, update.ErrUnavailable):
		status, code = http.StatusConflict, httpx.CodeUpdateUnavailable
	case errors.Is(err, update.ErrDowngrade):
		status, code = http.StatusConflict, httpx.CodeDowngradeNotConfirmed
	case errors.Is(err, update.ErrNotFound):
		status, code = http.StatusNotFound, httpx.CodeReleaseNotFound
	case errors.Is(err, update.ErrUpstream):
		status, code = http.StatusBadGateway, httpx.CodeUpstreamError
	default:
		httpx.Internal(w, r, err)
		return
	}
	httpx.Error(w, status, code, err.Error())
}

// updater returns the configured updater, or answers 409 and returns false.
func (s *Server) updater(w http.ResponseWriter) (Updater, bool) {
	if s.deps.Updater == nil {
		httpx.Error(w, http.StatusConflict, httpx.CodeUpdateUnavailable, "self-update is not available on this server")
		return nil, false
	}
	return s.deps.Updater, true
}

type releasesResponse struct {
	Current  update.Info      `json:"current"`
	Releases []update.Release `json:"releases"`
	Update   update.Status    `json:"update"`
}

func (s *Server) getAdminReleases(w http.ResponseWriter, r *http.Request) {
	u, ok := s.updater(w)
	if !ok {
		return
	}
	releases, err := u.Releases(r.Context(), r.URL.Query().Get("prereleases") == "true")
	if err != nil {
		writeUpdateError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, releasesResponse{Current: u.Info(), Releases: releases, Update: u.Status()})
}

func (s *Server) getAdminUpdate(w http.ResponseWriter, r *http.Request) {
	if u, ok := s.updater(w); ok {
		httpx.WriteJSON(w, http.StatusOK, u.Status())
	}
}

type updateRequest struct {
	Tag            string `json:"tag"`
	AllowDowngrade bool   `json:"allowDowngrade"`
}

func (s *Server) postAdminUpdate(w http.ResponseWriter, r *http.Request) {
	u, ok := s.updater(w)
	if !ok {
		return
	}
	var req updateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, httpx.CodeBadRequest, "malformed JSON body")
		return
	}
	st, err := u.Start(r.Context(), req.Tag, req.AllowDowngrade)
	if err != nil {
		writeUpdateError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, st)
}

func (s *Server) postAdminRollback(w http.ResponseWriter, r *http.Request) {
	u, ok := s.updater(w)
	if !ok {
		return
	}
	st, err := u.Rollback()
	if err != nil {
		writeUpdateError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, st)
}
