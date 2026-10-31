package update

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}

const testRepo = "owner/repo"

// fakeGH is a fake GitHub API: releases, redirecting asset downloads and a
// storage endpoint.
type fakeGH struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	releases []ghRelease
	content  map[int64][]byte
	paths    []string
	nextID   int64
	// listStatus, if set, is returned by the release listing.
	listStatus int
	// tagStatus, if set, is returned by the tag lookup.
	tagStatus int
	// assetHook, if set, may take over serving an asset; true means handled.
	assetHook func(id int64, w http.ResponseWriter, r *http.Request) bool
}

func newFakeGH(t *testing.T) *fakeGH {
	t.Helper()
	g := &fakeGH{t: t, content: map[int64][]byte{}, nextID: 100}
	g.srv = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGH) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	g.paths = append(g.paths, r.URL.Path)
	g.mu.Unlock()
	base := "/repos/" + testRepo
	switch {
	case r.URL.Path == base+"/releases":
		if r.URL.Query().Get("per_page") != "30" {
			g.t.Errorf("per_page = %q", r.URL.Query().Get("per_page"))
		}
		if g.listStatus != 0 {
			http.Error(w, "boom", g.listStatus)
			return
		}
		json.NewEncoder(w).Encode(g.releases)
	case strings.HasPrefix(r.URL.Path, base+"/releases/tags/"):
		if g.tagStatus != 0 {
			http.Error(w, "boom", g.tagStatus)
			return
		}
		tag := strings.TrimPrefix(r.URL.Path, base+"/releases/tags/")
		for _, rel := range g.releases {
			if rel.TagName == tag {
				json.NewEncoder(w).Encode(rel)
				return
			}
		}
		http.NotFound(w, r)
	case strings.HasPrefix(r.URL.Path, base+"/releases/assets/"):
		if got := r.Header.Get("Accept"); got != "application/octet-stream" {
			g.t.Errorf("asset Accept = %q", got)
		}
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, base+"/releases/assets/"), 10, 64)
		if g.assetHook != nil && g.assetHook(id, w, r) {
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/storage/%d", id), http.StatusFound)
	case strings.HasPrefix(r.URL.Path, "/storage/"):
		id, _ := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/storage/"), 10, 64)
		data, ok := g.content[id]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	default:
		g.t.Errorf("unexpected request path %q", r.URL.Path)
		http.NotFound(w, r)
	}
}

// relOpts shape a release added with add.
type relOpts struct {
	prerelease, draft bool
	// skip lists asset names to leave out.
	skip []string
	// binary is the content of the linux/amd64 binary.
	binary string
	// sums overrides the SHA256SUMS content.
	sums string
	// zip overrides the web bundle; the default holds index.html and
	// assets/app.js for the tag.
	zip []byte
}

// add publishes a release with the platform binary, SHA256SUMS and the web
// bundle, and returns it.
func (g *fakeGH) add(tag string, o relOpts) ghRelease {
	g.t.Helper()
	if o.binary == "" {
		o.binary = "binary-" + tag
	}
	if o.zip == nil {
		o.zip = makeZip(g.t, zipEntry{name: "index.html", body: "index-" + tag}, zipEntry{name: "assets/app.js", body: "app-" + tag})
	}
	files := map[string]string{
		"sudoku-server-linux-amd64": o.binary,
		"sudoku-server-linux-arm64": "arm-" + tag,
		"sudoku-web.zip":            string(o.zip),
	}
	sums := o.sums
	if sums == "" {
		var lines []string
		for _, name := range []string{"sudoku-server-linux-amd64", "sudoku-server-linux-arm64", "sudoku-web.zip"} {
			lines = append(lines, sha(files[name])+"  "+name)
		}
		sums = strings.Join(lines, "\n") + "\n"
	}
	files["SHA256SUMS"] = sums
	rel := ghRelease{
		TagName:     tag,
		Name:        tag,
		PublishedAt: "2026-10-30T01:02:03Z",
		Prerelease:  o.prerelease,
		Draft:       o.draft,
		HTMLURL:     "https://github.com/" + testRepo + "/releases/tag/" + tag,
	}
	for name, data := range files {
		if sliceHas(o.skip, name) {
			continue
		}
		g.nextID++
		g.content[g.nextID] = []byte(data)
		rel.Assets = append(rel.Assets, ghAsset{ID: g.nextID, Name: name, Size: int64(len(data))})
	}
	g.releases = append(g.releases, rel)
	return rel
}

func (g *fakeGH) assetID(rel ghRelease, name string) int64 {
	g.t.Helper()
	a, ok := rel.asset(name)
	if !ok {
		g.t.Fatalf("release %s has no %s", rel.TagName, name)
	}
	return a.ID
}

func sliceHas(s []string, v string) bool {
	for _, e := range s {
		if e == v {
			return true
		}
	}
	return false
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// testUpdater is an Updater against g with a temp-dir binary.
type testUpdater struct {
	*Updater
	dir, exe  string
	restarted chan struct{}
}

func newTestUpdater(t *testing.T, g *fakeGH) *testUpdater {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "sudoku-server")
	if err := os.WriteFile(exe, []byte("old-binary"), 0o750); err != nil {
		t.Fatal(err)
	}
	tu := &testUpdater{dir: dir, exe: exe, restarted: make(chan struct{}, 4)}
	tu.Updater = &Updater{
		APIBase:        g.srv.URL + "/",
		Repo:           testRepo,
		HTTPClient:     g.srv.Client(),
		ExePath:        exe,
		GOOS:           "linux",
		GOARCH:         "amd64",
		CurrentVersion: "1.0.0",
		Restart:        func() { tu.restarted <- struct{}{} },
	}
	return tu
}

// waitDone waits for the job to finish, successfully or not, and returns the
// final status.
func waitDone(t *testing.T, u *Updater) Status {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := u.Status(); st.State == StateRestarting || st.State == StateFailed {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job did not finish; status %+v", u.Status())
	return Status{}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// dirNames lists the entries of dir.
func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	return names
}

// setHooks replaces the filesystem hooks for the test.
func setHooks(t *testing.T, link, rename func(a, b string) error) {
	t.Helper()
	oldLink, oldRename := fsLink, fsRename
	if link != nil {
		fsLink = link
	}
	if rename != nil {
		fsRename = rename
	}
	t.Cleanup(func() { fsLink, fsRename = oldLink, oldRename })
}

// setLimits lowers the download size limits for the test.
func setLimits(t *testing.T, sums, bin int64) {
	t.Helper()
	oldSums, oldBin := maxSumsBytes, maxBinaryBytes
	maxSumsBytes, maxBinaryBytes = sums, bin
	t.Cleanup(func() { maxSumsBytes, maxBinaryBytes = oldSums, oldBin })
}

// zipEntry is one archive entry for makeZip. A name ending in "/" is a
// directory; a non-zero mode is stored as the entry's mode (e.g. a symlink).
type zipEntry struct {
	name, body string
	mode       os.FileMode
}

// makeZip builds an archive holding the entries in order.
func makeZip(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		fh := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			fh.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(fh)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// withWeb gives the updater a web directory holding an old index.html, and
// returns its path. Its parent is the updater's temp dir.
func withWeb(t *testing.T, tu *testUpdater) string {
	t.Helper()
	web := filepath.Join(tu.dir, "web")
	if err := os.MkdirAll(filepath.Join(web, "old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("old-index"), 0o644); err != nil {
		t.Fatal(err)
	}
	tu.WebDir = web
	return web
}

// setWebLimits lowers the web bundle limits for the test.
func setWebLimits(t *testing.T, bytes int64, entries int) {
	t.Helper()
	oldBytes, oldEntries := maxWebBytes, maxWebEntries
	maxWebBytes, maxWebEntries = bytes, entries
	t.Cleanup(func() { maxWebBytes, maxWebEntries = oldBytes, oldEntries })
}
