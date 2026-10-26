package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func get(t *testing.T, h http.Handler, path string) (int, string, http.Header) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b), rec.Header()
}

func TestHandler(t *testing.T) {
	dir := writeTree(t, map[string]string{
		"index.html":       "INDEX",
		"app.js":           "JS",
		"assets/style.css": "CSS",
		"docs/index.html":  "DOCS",
		"emptydir/.keep":   "",
	})
	// A file outside the web dir that traversal must not reach.
	os.WriteFile(filepath.Join(filepath.Dir(dir), "secret.txt"), []byte("SECRET"), 0o644)

	h, err := Handler(dir)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		path   string
		status int
		body   string
	}{
		{"/", 200, "INDEX"},
		{"/app.js", 200, "JS"},
		{"/assets/style.css", 200, "CSS"},
		{"/leaderboard", 200, "INDEX"},       // client-side route
		{"/play/2026-10-26/3", 200, "INDEX"}, // nested client route
		{"/missing.js", 200, "INDEX"},
		{"/emptydir/", 200, "INDEX"}, // no directory listings
		{"/docs/", 200, "DOCS"},
		{"/index.html", 200, "INDEX"},
		{"/../secret.txt", 200, "INDEX"},
		{"/%2e%2e/secret.txt", 200, "INDEX"},
	}
	for _, tt := range tests {
		status, body, _ := get(t, h, tt.path)
		if status != tt.status || body != tt.body {
			t.Errorf("GET %s = %d %q, want %d %q", tt.path, status, body, tt.status, tt.body)
		}
	}
	if _, _, hdr := get(t, h, "/some/route"); hdr.Get("Cache-Control") != "no-cache" {
		t.Errorf("index fallback Cache-Control = %q", hdr.Get("Cache-Control"))
	}
	if _, _, hdr := get(t, h, "/app.js"); hdr.Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Errorf("app.js Content-Type = %q", hdr.Get("Content-Type"))
	}
}

func TestHandlerRequiresIndex(t *testing.T) {
	if _, err := Handler(writeTree(t, map[string]string{"app.js": "x"})); err == nil {
		t.Error("expected error without index.html")
	}
	if _, err := Handler(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("expected error for missing dir")
	}
}
