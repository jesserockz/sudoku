package httpx

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestErrorEnvelope(t *testing.T) {
	rec := httptest.NewRecorder()
	Error(rec, http.StatusBadRequest, CodeInvalidResult, "elapsedMs below minimum")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"code": "invalid_result", "message": "elapsedMs below minimum"}
	if got["error"]["code"] != want["code"] || got["error"]["message"] != want["message"] {
		t.Errorf("body = %s", rec.Body)
	}
}

func TestRecoverWrites500(t *testing.T) {
	h := Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["error"]["code"] != CodeInternal {
		t.Errorf("body = %s", rec.Body)
	}
}

func TestErrorUntil(t *testing.T) {
	until := "2026-11-17T02:00:00Z"
	rec := httptest.NewRecorder()
	ErrorUntil(rec, http.StatusServiceUnavailable, CodeMaintenance, "down", &until)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
	if got, want := rec.Body.String(), `{"error":{"code":"maintenance","message":"down","until":"2026-11-17T02:00:00Z"}}`+"\n"; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}

	// Without an end time the field is left out.
	rec = httptest.NewRecorder()
	ErrorUntil(rec, http.StatusServiceUnavailable, CodeMaintenance, "down", nil)
	if got, want := rec.Body.String(), `{"error":{"code":"maintenance","message":"down"}}`+"\n"; got != want {
		t.Errorf("body = %s, want %s", got, want)
	}
}
