// Package httpx holds small HTTP helpers shared by the handlers: JSON
// responses, the API error envelope, and middleware.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// Error codes from docs/API.md.
const (
	CodeBadRequest       = "bad_request"
	CodeInvalidResult    = "invalid_result"
	CodeUnauthorized     = "unauthorized"
	CodeTooLarge         = "too_large"
	CodeNotFound         = "not_found"
	CodeMethodNotAllowed = "method_not_allowed"
	CodeInternal         = "internal"
	CodeAuthUnavailable  = "auth_unavailable"

	CodeForbidden             = "forbidden"
	CodeUpdateInProgress      = "update_in_progress"
	CodeDowngradeNotConfirmed = "downgrade_not_confirmed"
	CodeUpdateUnavailable     = "update_unavailable"
	CodeReleaseNotFound       = "release_not_found"
	CodeUpstreamError         = "upstream_error"

	// CodeMaintenance is the code of the 503 a non-admin gets while the
	// admin has maintenance mode on. Clients key off the code, not the
	// status: other 503s exist (identity server outages).
	CodeMaintenance = "maintenance"
)

// WriteJSON writes v as a JSON response with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("write json response", "err", err)
	}
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Until is an RFC 3339 UTC time, only on maintenance errors that have one.
	Until *string `json:"until,omitempty"`
}

// Error writes the API error envelope: {"error":{"code":...,"message":...}}.
func Error(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

// ErrorUntil is Error with the optional until time (RFC 3339 UTC) of a
// maintenance error; nil leaves it out.
func ErrorUntil(w http.ResponseWriter, status int, code, message string, until *string) {
	WriteJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message, Until: until}})
}

// Internal logs err and writes a generic 500 so internals don't leak.
func Internal(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("internal error", "method", r.Method, "path", r.URL.Path, "err", err)
	Error(w, http.StatusInternalServerError, CodeInternal, "internal server error")
}

// statusRecorder captures the status code for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Logging logs one line per request.
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "dur", time.Since(start))
	})
}

// Recover turns a handler panic into a 500 instead of a dropped connection.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				slog.Error("panic", "method", r.Method, "path", r.URL.Path, "panic", v)
				Error(w, http.StatusInternalServerError, CodeInternal, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
