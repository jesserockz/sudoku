package update

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// failRenames returns a rename hook that fails the given 1-based calls and
// otherwise renames for real.
func failRenames(calls ...int) func(a, b string) error {
	var n atomic.Int32
	return func(a, b string) error {
		c := int(n.Add(1))
		for _, f := range calls {
			if c == f {
				return errors.New("rename refused")
			}
		}
		return os.Rename(a, b)
	}
}

// runUpdateJob starts the update to tag and waits for the job to finish.
func runUpdateJob(t *testing.T, tu *testUpdater, tag string) Status {
	t.Helper()
	if _, err := tu.Start(context.Background(), tag, false); err != nil {
		t.Fatal(err)
	}
	return waitDone(t, tu.Updater)
}

// runRollbackJob starts a rollback and waits for the job to finish.
func runRollbackJob(t *testing.T, tu *testUpdater) Status {
	t.Helper()
	if _, err := tu.Rollback(); err != nil {
		t.Fatal(err)
	}
	return waitDone(t, tu.Updater)
}

func TestInfoUpdatesWeb(t *testing.T) {
	u := &Updater{GOOS: "linux", GOARCH: "amd64", CurrentVersion: "1.0.0"}
	if u.Info().WebDir {
		t.Error("updatesWeb without a web dir")
	}
	u.WebDir = "/opt/sudoku/web"
	if !u.Info().WebDir {
		t.Error("updatesWeb with a web dir")
	}
}

func TestReleasesNeedWebBundleOnlyWithWebDir(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{skip: []string{"sudoku-web.zip"}})
	tu := newTestUpdater(t, g)

	rels, err := tu.Releases(context.Background(), false)
	if err != nil || len(rels) != 1 || !rels[0].Installable {
		t.Fatalf("without web dir: %+v, %v", rels, err)
	}
	withWeb(t, tu)
	rels, err = tu.Releases(context.Background(), false)
	if err != nil || len(rels) != 1 || rels[0].Installable || rels[0].NotInstallableReason != "no sudoku-web.zip asset" {
		t.Fatalf("with web dir: %+v, %v", rels, err)
	}
	if _, err := tu.Start(context.Background(), "v1.1.0", false); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "no sudoku-web.zip asset") {
		t.Errorf("Start err = %v", err)
	}
}

func TestStartInstallsWebAndKeepsPrevious(t *testing.T) {
	g := newFakeGH(t)
	zip1 := makeZip(t,
		zipEntry{name: "./", mode: fs.ModeDir | 0o755},
		zipEntry{name: "./index.html", body: "new-index"},
		zipEntry{name: "assets/", mode: fs.ModeDir | 0o700},
		zipEntry{name: "assets/app.js", body: "new-app", mode: 0o777},
		zipEntry{name: "empty/", mode: fs.ModeDir | 0o755},
		zipEntry{name: "a/./b//c.txt", body: "deep"},
	)
	rel := g.add("v1.1.0", relOpts{zip: zip1})
	g.add("v1.2.0", relOpts{})
	tu := newTestUpdater(t, g)
	web := withWeb(t, tu)

	st := runUpdateJob(t, tu, "v1.1.0")
	if st.State != StateRestarting || st.Error != "" {
		t.Fatalf("status = %+v", st)
	}
	<-tu.restarted
	wantTotal := int64(len("binary-v1.1.0")) + int64(len(zip1))
	if st.BytesTotal != wantTotal || st.BytesDone != wantTotal {
		t.Errorf("bytes = %d/%d, want %d", st.BytesDone, st.BytesTotal, wantTotal)
	}
	if a, _ := rel.asset("sudoku-web.zip"); a.Size != int64(len(zip1)) {
		t.Errorf("zip asset size = %d", a.Size)
	}
	for file, want := range map[string]string{
		"index.html": "new-index", "assets/app.js": "new-app", "a/b/c.txt": "deep",
		"../web.previous/index.html": "old-index", "../web.previous/old": "",
	} {
		if file == "../web.previous/old" {
			if fi, err := os.Stat(filepath.Join(web, file)); err != nil || !fi.IsDir() {
				t.Errorf("previous web lost its old dir: %v", err)
			}
			continue
		}
		if got := readFile(t, filepath.Join(web, file)); got != want {
			t.Errorf("%s = %q, want %q", file, got, want)
		}
	}
	if fi, err := os.Stat(filepath.Join(web, "empty")); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o755&^umask(t) {
		t.Errorf("empty dir: %v %v", fi, err)
	}
	if fi, _ := os.Stat(filepath.Join(web, "assets/app.js")); fi.Mode().Perm()&0o111 != 0 {
		t.Errorf("extracted file is executable: %v", fi.Mode())
	}
	if readFile(t, tu.exe) != "binary-v1.1.0" || readFile(t, tu.exe+".previous") != "old-binary" {
		t.Error("binary not replaced")
	}
	want := []string{"sudoku-server", "sudoku-server.previous", "web", "web.previous"}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, want) {
		t.Errorf("dir = %v", names)
	}

	// A second update replaces web.previous with the web client it replaced.
	tu.CurrentVersion = "1.1.0"
	if st := runUpdateJob(t, tu, "v1.2.0"); st.State != StateRestarting {
		t.Fatalf("second status = %+v", st)
	}
	if readFile(t, filepath.Join(web, "index.html")) != "index-v1.2.0" || readFile(t, web+".previous/index.html") != "new-index" {
		t.Error("second update did not rotate the web client")
	}
	if _, err := os.Stat(web + ".previous/old"); !os.IsNotExist(err) {
		t.Error("stale web.previous content survived")
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, want) {
		t.Errorf("dir = %v", names)
	}
}

// umask returns the process umask without changing it for good.
func umask(t *testing.T) fs.FileMode {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "probe")
	if err := os.Mkdir(p, 0o777); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return 0o777 &^ fi.Mode().Perm()
}

func TestStartInstallsWebWhenNoneExistsYet(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.WebDir = filepath.Join(tu.dir, "web")

	if st := runUpdateJob(t, tu, "v1.1.0"); st.State != StateRestarting {
		t.Fatalf("status = %+v", st)
	}
	if readFile(t, filepath.Join(tu.WebDir, "index.html")) != "index-v1.1.0" {
		t.Error("web client not installed")
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server", "sudoku-server.previous", "web"}) {
		t.Errorf("dir = %v", names)
	}
}

func TestStartWithoutWebDirLeavesWebAlone(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{skip: []string{"sudoku-web.zip"}})
	tu := newTestUpdater(t, g)
	if st := runUpdateJob(t, tu, "v1.1.0"); st.State != StateRestarting {
		t.Fatalf("status = %+v", st)
	}
	for _, p := range g.paths {
		if strings.Contains(p, "web") {
			t.Errorf("unexpected request %q", p)
		}
	}
}

func TestPreflightNeedsWritableWebParent(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.WebDir = filepath.Join(tu.dir, "missing-parent", "web")
	if _, err := tu.Start(context.Background(), "v1.1.0", false); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "missing-parent") {
		t.Errorf("Start err = %v", err)
	}
	if _, err := tu.Rollback(); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "missing-parent") {
		t.Errorf("Rollback err = %v", err)
	}
}

func TestWebJobFailuresLeaveEverythingUntouched(t *testing.T) {
	type tc struct {
		name  string
		setup func(t *testing.T, g *fakeGH, tu *testUpdater) string // returns the tag
		want  string
	}
	withZip := func(z []byte) func(t *testing.T, g *fakeGH, tu *testUpdater) string {
		return func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{zip: z})
			return "v1.1.0"
		}
	}
	zipFailing := func(handle func(w http.ResponseWriter)) func(t *testing.T, g *fakeGH, tu *testUpdater) string {
		return func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "sudoku-web.zip")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					handle(w)
					return true
				}
				return false
			}
			return "v1.1.0"
		}
	}
	idx := zipEntry{name: "index.html", body: "i"}
	tests := []tc{
		{"zip checksum mismatch", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			sums := sha("x") + "  sudoku-server-linux-amd64\n" + strings.Repeat("0", 64) + "  sudoku-web.zip\n"
			g.add("v1.1.0", relOpts{binary: "x", sums: sums})
			return "v1.1.0"
		}, "checksum mismatch"},
		{"sums lack the zip", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: sha("binary-v1.1.0") + "  sudoku-server-linux-amd64\n"})
			return "v1.1.0"
		}, "no entry for sudoku-web.zip"},
		{"zip download fails", zipFailing(func(w http.ResponseWriter) { http.Error(w, "gone", http.StatusForbidden) }), "downloading sudoku-web.zip: 403"},
		{"zip body cut short", zipFailing(truncated), "downloading sudoku-web.zip"},
		{"zip too large", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{})
			setWebLimits(t, 20, 100)
			return "v1.1.0"
		}, "sudoku-web.zip is larger than 20 bytes"},
		{"not a zip", withZip([]byte("definitely not a zip file")), "unpacking sudoku-web.zip"},
		{"too many entries", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{zip: makeZip(t, idx, zipEntry{name: "b", body: "b"})})
			setWebLimits(t, 1<<20, 1)
			return "v1.1.0"
		}, "more than 1 entries"},
		{"too large uncompressed", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{zip: makeZip(t, idx, zipEntry{name: "a", body: strings.Repeat("a", 3000)}, zipEntry{name: "b", body: strings.Repeat("b", 3000)})})
			setWebLimits(t, 5000, 100)
			return "v1.1.0"
		}, "larger than 5000 bytes uncompressed"},
		{"parent traversal", withZip(makeZip(t, idx, zipEntry{name: "../evil", body: "x"})), "unsafe entry name"},
		{"nested traversal", withZip(makeZip(t, idx, zipEntry{name: "a/../../evil", body: "x"})), "unsafe entry name"},
		{"absolute path", withZip(makeZip(t, idx, zipEntry{name: "/etc/evil", body: "x"})), "unsafe entry name"},
		{"backslash", withZip(makeZip(t, idx, zipEntry{name: `a\..\evil`, body: "x"})), "unsafe entry name"},
		{"symlink", withZip(makeZip(t, idx, zipEntry{name: "link", body: "/etc", mode: fs.ModeSymlink | 0o777})), "link is not a regular file or directory"},
		{"no index.html", withZip(makeZip(t, zipEntry{name: "sub/index.html", body: "x"})), "no index.html"},
		{"index.html is a directory", withZip(makeZip(t, zipEntry{name: "index.html/", mode: fs.ModeDir | 0o755})), "no index.html"},
		{"duplicate file", withZip(makeZip(t, idx, idx)), "index.html"},
		{"directory over file", withZip(makeZip(t, idx, zipEntry{name: "f", body: "x"}, zipEntry{name: "f/", mode: fs.ModeDir | 0o755})), "f"},
		{"file below file", withZip(makeZip(t, idx, zipEntry{name: "f", body: "x"}, zipEntry{name: "f/g", body: "x"})), "f"},
		{"unsupported compression", withZip(rawZip(t, 99)), "unsupported compression"},
		{"corrupt data", withZip(corruptZip(t)), "checksum"},
		{"binary install fails", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{})
			// Renames: web aside (1), staging into place (2), previous binary (3).
			setHooks(t, nil, failRenames(3))
			return "v1.1.0"
		}, "keeping the previous binary: rename refused"},
		{"keeping the old web client fails", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{})
			setHooks(t, nil, failRenames(1))
			return "v1.1.0"
		}, "keeping the previous web client: rename refused"},
		{"swapping the new web client in fails", func(t *testing.T, g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{})
			setHooks(t, nil, failRenames(2))
			return "v1.1.0"
		}, "rename refused"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newFakeGH(t)
			tu := newTestUpdater(t, g)
			web := withWeb(t, tu)
			tag := tt.setup(t, g, tu)
			st := runUpdateJob(t, tu, tag)
			if st.State != StateFailed || !strings.Contains(st.Error, tt.want) {
				t.Fatalf("status = %+v, want failure containing %q", st, tt.want)
			}
			select {
			case <-tu.restarted:
				t.Error("Restart called after a failed update")
			default:
			}
			if got := readFile(t, tu.exe); got != "old-binary" {
				t.Errorf("running binary changed: %q", got)
			}
			if got := readFile(t, filepath.Join(web, "index.html")); got != "old-index" {
				t.Errorf("web client changed: %q", got)
			}
			if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server", "web"}) {
				t.Errorf("leftover files: %v", names)
			}
		})
	}
}

func TestBinaryInstallFailureWithoutOldWebRemovesNewWeb(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.WebDir = filepath.Join(tu.dir, "web")
	// Renames: staging into place (1), previous binary (2).
	setHooks(t, nil, failRenames(2))
	if st := runUpdateJob(t, tu, "v1.1.0"); st.State != StateFailed {
		t.Fatalf("status = %+v", st)
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server"}) {
		t.Errorf("dir = %v", names)
	}
}

func TestZipStagingFailsWhenParentVanishes(t *testing.T) {
	for _, during := range []string{"sudoku-server-linux-amd64", "sudoku-web.zip"} {
		t.Run(during, func(t *testing.T) {
			g := newFakeGH(t)
			rel := g.add("v1.1.0", relOpts{})
			tu := newTestUpdater(t, g)
			parent := t.TempDir()
			tu.WebDir = filepath.Join(parent, "web")
			id := g.assetID(rel, during)
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					os.RemoveAll(parent)
				}
				return false
			}
			// Removing the parent while the binary downloads stops the zip
			// temp file; removing it while the zip downloads stops the
			// staging directory.
			if st := runUpdateJob(t, tu, "v1.1.0"); st.State != StateFailed || !strings.Contains(st.Error, "sudoku-web") {
				t.Fatalf("status = %+v", st)
			}
			if readFile(t, tu.exe) != "old-binary" {
				t.Error("running binary changed")
			}
		})
	}
}

// rawZip is an archive whose only entry, index.html, uses a compression
// method id that archive/zip does not know.
func rawZip(t *testing.T, method uint16) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateRaw(&zip.FileHeader{Name: "index.html", Method: method, CompressedSize64: 3, UncompressedSize64: 3})
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("abc"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// corruptZip is a stored archive whose index.html data no longer matches its
// CRC.
func corruptZip(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "index.html", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte("0123456789"))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	i := bytes.Index(b, []byte("0123456789"))
	b[i] = 'X'
	return b
}

func TestEntryName(t *testing.T) {
	tests := []struct{ in, want string }{
		{"index.html", "index.html"},
		{"./index.html", "index.html"},
		{"a//b/./c/", "a/b/c"},
		{"./", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got, err := entryName(tt.in); err != nil || got != tt.want {
			t.Errorf("entryName(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
	for _, bad := range []string{"/abs", "../x", "a/../b", "..", `a\b`} {
		if _, err := entryName(bad); err == nil {
			t.Errorf("entryName(%q) accepted", bad)
		}
	}
}

func TestExtractZipUnusableDestination(t *testing.T) {
	zipPath := filepath.Join(t.TempDir(), "w.zip")
	os.WriteFile(zipPath, makeZip(t, zipEntry{name: "index.html", body: "i"}), 0o644)
	if err := extractZip(zipPath, filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("expected error for a missing destination")
	}
	if err := extractZip(filepath.Join(t.TempDir(), "missing.zip"), t.TempDir()); err == nil {
		t.Error("expected error for a missing archive")
	}
}

func TestRestoreDirLogsWhenPreviousIsMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "web")
	os.Mkdir(dir, 0o755)
	restoreDir(dir, true) // no web.previous to put back: only logged
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("new web dir not removed")
	}
}

func TestRollbackSwapsWebDir(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)
	web := withWeb(t, tu)
	os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750)
	os.Mkdir(web+".previous", 0o755)
	os.WriteFile(web+".previous/index.html", []byte("older-index"), 0o644)

	st := runRollbackJob(t, tu)
	if st.State != StateRestarting || st.Error != "" {
		t.Fatalf("status = %+v", st)
	}
	<-tu.restarted
	if readFile(t, web+"/index.html") != "older-index" || readFile(t, web+".previous/index.html") != "old-index" {
		t.Error("web dirs not swapped")
	}
	if readFile(t, tu.exe) != "older-binary" || readFile(t, tu.exe+".previous") != "old-binary" {
		t.Error("binaries not swapped")
	}
	want := []string{"sudoku-server", "sudoku-server.previous", "web", "web.previous"}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, want) {
		t.Errorf("dir = %v", names)
	}
	// Rolling back again swaps both back.
	runRollbackJob(t, tu)
	if readFile(t, web+"/index.html") != "old-index" || readFile(t, tu.exe) != "old-binary" {
		t.Error("second rollback did not swap back")
	}
}

func TestRollbackWithoutPreviousWebRollsBackBinaryOnly(t *testing.T) {
	for _, name := range []string{"absent", "a file"} {
		t.Run(name, func(t *testing.T) {
			g := newFakeGH(t)
			tu := newTestUpdater(t, g)
			web := withWeb(t, tu)
			os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750)
			want := []string{"sudoku-server", "sudoku-server.previous", "web"}
			if name == "a file" {
				os.WriteFile(web+".previous", []byte("x"), 0o644)
				want = append(want, "web.previous")
			}
			if st := runRollbackJob(t, tu); st.State != StateRestarting {
				t.Fatalf("status = %+v", st)
			}
			if readFile(t, tu.exe) != "older-binary" || readFile(t, web+"/index.html") != "old-index" {
				t.Error("unexpected result")
			}
			if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, want) {
				t.Errorf("dir = %v, want %v", names, want)
			}
		})
	}
}

func TestRollbackWebFailures(t *testing.T) {
	tests := []struct {
		name    string
		fail    []int
		wantErr bool
		// stuck means the web dirs stay swapped because swapping back failed.
		stuck bool
	}{
		// Web swap renames are 1-3 and the binary's is 4; swapping the web
		// dirs back after a failed binary rollback uses 5-7.
		{"web aside fails", []int{1}, true, false},
		{"previous web into place fails", []int{2}, true, false},
		{"cannot keep the replaced web client", []int{3}, false, false},
		{"binary fails, web swapped back", []int{4}, true, false},
		{"binary fails, web cannot be swapped back", []int{4, 5}, true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newFakeGH(t)
			tu := newTestUpdater(t, g)
			web := withWeb(t, tu)
			os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750)
			os.Mkdir(web+".previous", 0o755)
			os.WriteFile(web+".previous/index.html", []byte("older-index"), 0o644)
			setHooks(t, nil, failRenames(tt.fail...))

			st := runRollbackJob(t, tu)
			if !tt.wantErr {
				if st.State != StateRestarting || readFile(t, web+"/index.html") != "older-index" {
					t.Fatalf("status = %+v", st)
				}
				if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server", "sudoku-server.previous", "web"}) {
					t.Errorf("dir = %v", names)
				}
				return
			}
			if st.State != StateFailed || !strings.Contains(st.Error, "rename refused") {
				t.Fatalf("status = %+v", st)
			}
			if got := readFile(t, tu.exe); got != "old-binary" {
				t.Errorf("binary = %q", got)
			}
			wantWeb, wantPrev := "old-index", "older-index"
			if tt.stuck {
				wantWeb, wantPrev = wantPrev, wantWeb
			}
			if got := readFile(t, web+"/index.html"); got != wantWeb {
				t.Errorf("web = %q, want %q", got, wantWeb)
			}
			if got := readFile(t, web+".previous/index.html"); got != wantPrev {
				t.Errorf("web.previous = %q, want %q", got, wantPrev)
			}
			for _, n := range dirNames(t, tu.dir) {
				if strings.HasSuffix(n, ".tmp") {
					t.Errorf("leftover %s", n)
				}
			}
		})
	}
}
