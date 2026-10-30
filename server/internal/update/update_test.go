package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestInfoAndDefaults(t *testing.T) {
	u := &Updater{}
	info := u.Info()
	if info.Version == "" || info.OS == "" || info.Arch == "" || info.Asset != "sudoku-server-"+info.OS+"-"+info.Arch {
		t.Errorf("info = %+v", info)
	}
	if u.apiBase() != DefaultAPIBase || u.repo() != DefaultRepo || u.client() != http.DefaultClient {
		t.Error("defaults not applied")
	}
	u = &Updater{APIBase: "http://x/", Repo: "a/b", CurrentVersion: "9.9.9", GOOS: "linux", GOARCH: "arm64"}
	if u.apiBase() != "http://x" || u.repo() != "a/b" {
		t.Error("overrides not applied")
	}
	if got := u.Info(); got != (Info{Version: "9.9.9", OS: "linux", Arch: "arm64", Asset: "sudoku-server-linux-arm64"}) {
		t.Errorf("info = %+v", got)
	}
}

func TestStatusIdleAndExePath(t *testing.T) {
	// Default ExePath resolves the test binary; nothing is kept next to it.
	st := (&Updater{}).Status()
	if st.State != StateIdle || st.Action != "" || st.RollbackAvailable {
		t.Errorf("status = %+v", st)
	}

	u := &Updater{executable: func() (string, error) { return "", errors.New("no exe") }}
	if _, err := u.exePath(); err == nil {
		t.Error("expected error from executable")
	}
	if st := u.Status(); st.RollbackAvailable {
		t.Error("rollback available without an executable")
	}
	u = &Updater{executable: func() (string, error) { return "/nonexistent/dir/sudoku", nil }}
	if _, err := u.exePath(); err == nil {
		t.Error("expected EvalSymlinks error")
	}
}

func TestStatusRollbackAvailable(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)
	if tu.Status().RollbackAvailable {
		t.Fatal("rollback available before .previous exists")
	}
	// A directory named .previous does not count.
	os.Mkdir(tu.exe+".previous", 0o755)
	if tu.Status().RollbackAvailable {
		t.Fatal("directory counted as a previous binary")
	}
	os.Remove(tu.exe + ".previous")
	os.WriteFile(tu.exe+".previous", []byte("p"), 0o755)
	if !tu.Status().RollbackAvailable {
		t.Fatal("rollback not available")
	}
}

func TestReleases(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.2.0-rc.1", relOpts{prerelease: true})
	g.add("v1.1.0", relOpts{})
	g.add("v1.0.0", relOpts{})
	g.add("v0.9.0", relOpts{skip: []string{"sudoku-server-linux-amd64"}})
	g.add("v0.8.0", relOpts{skip: []string{"SHA256SUMS"}})
	g.add("v2.0.0", relOpts{draft: true})
	g.add("nightly", relOpts{})
	tu := newTestUpdater(t, g)

	rels, err := tu.Releases(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		tag, cmp, reason    string
		latest, current, ok bool
	}
	var got []row
	for _, r := range rels {
		got = append(got, row{r.Tag, r.Comparison, r.NotInstallableReason, r.Latest, r.Current, r.Installable})
	}
	want := []row{
		{"v1.1.0", Newer, "", true, false, true},
		{"v1.0.0", Same, "", false, true, true},
		{"v0.9.0", Older, "no sudoku-server-linux-amd64 asset", false, false, false},
		{"v0.8.0", Older, "no SHA256SUMS", false, false, false},
		{"nightly", Unknown, "", false, false, true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("releases:\n got %+v\nwant %+v", got, want)
	}
	if rels[0].Version != "1.1.0" || rels[0].Name != "v1.1.0" || rels[0].PublishedAt != "2026-10-30T01:02:03Z" ||
		rels[0].URL != "https://github.com/owner/repo/releases/tag/v1.1.0" || rels[0].Prerelease {
		t.Errorf("release fields = %+v", rels[0])
	}

	rels, err = tu.Releases(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rels) != 6 || rels[0].Tag != "v1.2.0-rc.1" || !rels[0].Prerelease || rels[0].Latest {
		t.Errorf("with prereleases: %+v", rels)
	}
	if !rels[1].Latest {
		t.Error("latest should stay the highest non-prerelease")
	}

	for _, p := range g.paths {
		if !strings.HasPrefix(p, "/repos/"+testRepo+"/") {
			t.Errorf("unexpected path %q", p)
		}
	}
}

func TestReleasesNoneAndLatestIgnoresNonSemver(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)
	rels, err := tu.Releases(context.Background(), false)
	if err != nil || rels == nil || len(rels) != 0 {
		t.Errorf("rels = %v, %v", rels, err)
	}
	g.add("nightly", relOpts{})
	g.add("v0.5.0", relOpts{})
	rels, _ = tu.Releases(context.Background(), false)
	if rels[0].Latest || !rels[1].Latest {
		t.Errorf("latest = %v %v", rels[0].Latest, rels[1].Latest)
	}
}

func TestReleasesUpstreamErrors(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)

	g.listStatus = http.StatusNotFound
	if _, err := tu.Releases(context.Background(), false); !errors.Is(err, ErrUpstream) {
		t.Errorf("404: err = %v", err)
	}
	g.listStatus = http.StatusInternalServerError
	if _, err := tu.Releases(context.Background(), false); !errors.Is(err, ErrUpstream) {
		t.Errorf("500: err = %v", err)
	}
	g.listStatus = 0
	g.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not json")) })
	if _, err := tu.Releases(context.Background(), false); !errors.Is(err, ErrUpstream) {
		t.Errorf("bad json: err = %v", err)
	}
	tu.APIBase = "http://\x7f"
	if _, err := tu.Releases(context.Background(), false); !errors.Is(err, ErrUpstream) {
		t.Errorf("bad base: err = %v", err)
	}
	g.srv.Close()
	tu.APIBase = g.srv.URL
	if _, err := tu.Releases(context.Background(), false); !errors.Is(err, ErrUpstream) {
		t.Errorf("down: err = %v", err)
	}
}

func TestStartInstallsAndKeepsPrevious(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{binary: strings.Repeat("new-binary-", 1000)})
	tu := newTestUpdater(t, g)

	st, err := tu.Start(context.Background(), "v1.1.0", false)
	if err != nil {
		t.Fatal(err)
	}
	if st.Action != "update" || st.Target != "v1.1.0" || st.StartedAt == nil || st.State == StateIdle || st.State == StateFailed {
		t.Errorf("initial status = %+v", st)
	}
	final := waitDone(t, tu.Updater)
	if final.State != StateRestarting || final.Error != "" || final.FinishedAt == nil || !final.RollbackAvailable {
		t.Errorf("final status = %+v", final)
	}
	if final.BytesDone != final.BytesTotal || final.BytesTotal != int64(len(strings.Repeat("new-binary-", 1000))) {
		t.Errorf("bytes = %d/%d", final.BytesDone, final.BytesTotal)
	}
	<-tu.restarted

	if got := readFile(t, tu.exe); got != strings.Repeat("new-binary-", 1000) {
		t.Errorf("binary not replaced: %.30q", got)
	}
	if got := readFile(t, tu.exe+".previous"); got != "old-binary" {
		t.Errorf("previous = %q", got)
	}
	fi, _ := os.Stat(tu.exe)
	if fi.Mode().Perm() != 0o750 {
		t.Errorf("mode = %v, want 0750", fi.Mode().Perm())
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server", "sudoku-server.previous"}) {
		t.Errorf("dir = %v", names)
	}
	// Only GitHub API paths and the redirect target were requested.
	for _, p := range g.paths {
		if !strings.HasPrefix(p, "/repos/"+testRepo+"/") && !strings.HasPrefix(p, "/storage/") {
			t.Errorf("unexpected path %q", p)
		}
	}
}

func TestStartTwiceKeepsOnlyLastPrevious(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	g.add("v1.2.0", relOpts{})
	tu := newTestUpdater(t, g)
	for _, tag := range []string{"v1.1.0", "v1.2.0"} {
		if _, err := tu.Start(context.Background(), tag, false); err != nil {
			t.Fatal(err)
		}
		waitDone(t, tu.Updater)
		tu.CurrentVersion = strings.TrimPrefix(tag, "v")
	}
	if readFile(t, tu.exe) != "binary-v1.2.0" || readFile(t, tu.exe+".previous") != "binary-v1.1.0" {
		t.Error("previous should be the binary replaced by the last update")
	}
}

func TestStartWithoutRestartCallbackAndLinkFallback(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.Restart = nil
	setHooks(t, func(a, b string) error { return errors.New("no hard links here") }, nil)
	if _, err := tu.Start(context.Background(), "1.1.0", false); err == nil {
		t.Fatal("tag without v should not be found on GitHub")
	}
	if _, err := tu.Start(context.Background(), "v1.1.0", false); err != nil {
		t.Fatal(err)
	}
	if st := waitDone(t, tu.Updater); st.State != StateRestarting {
		t.Fatalf("status = %+v", st)
	}
	if readFile(t, tu.exe) != "binary-v1.1.0" || readFile(t, tu.exe+".previous") != "old-binary" {
		t.Error("copy fallback did not keep the previous binary")
	}
	fi, _ := os.Stat(tu.exe + ".previous")
	if fi.Mode().Perm() != 0o750 {
		t.Errorf("previous mode = %v", fi.Mode().Perm())
	}
}

func TestStartRejects(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	g.add("v1.0.0", relOpts{})
	g.add("v0.9.0", relOpts{})
	g.add("nightly", relOpts{})
	g.add("v1.3.0", relOpts{draft: true})
	g.add("v1.4.0", relOpts{skip: []string{"sudoku-server-linux-amd64"}})
	g.add("v1.5.0", relOpts{skip: []string{"SHA256SUMS"}})
	tu := newTestUpdater(t, g)

	tests := []struct {
		name string
		tag  string
		kind error
		msg  string
	}{
		{"bad tag", "../etc/passwd", ErrInvalidTag, "tag must look like"},
		{"not found", "v7.0.0", ErrNotFound, "v7.0.0 not found"},
		{"draft", "v1.3.0", ErrNotFound, "v1.3.0 not found"},
		{"no asset", "v1.4.0", ErrUnavailable, "no sudoku-server-linux-amd64 asset"},
		{"no sums", "v1.5.0", ErrUnavailable, "no SHA256SUMS"},
		{"same", "v1.0.0", ErrDowngrade, "the same version as"},
		{"older", "v0.9.0", ErrDowngrade, "older"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := tu.Start(context.Background(), tt.tag, false)
			if !errors.Is(err, tt.kind) || !strings.Contains(err.Error(), tt.msg) {
				t.Errorf("err = %v, want %v containing %q", err, tt.kind, tt.msg)
			}
		})
	}
	if st := tu.Status(); st.State != StateIdle {
		t.Errorf("refused starts changed the status: %+v", st)
	}
	if readFile(t, tu.exe) != "old-binary" || len(dirNames(t, tu.dir)) != 1 {
		t.Error("refused starts touched the directory")
	}

	// Refusals release the job slot.
	if _, err := tu.Start(context.Background(), "v1.1.0", false); err != nil {
		t.Fatalf("start after refusals: %v", err)
	}
	waitDone(t, tu.Updater)
}

func TestStartUnknownVersionNeedsConfirmation(t *testing.T) {
	g := newFakeGH(t)
	g.add("nightly-1.0.0", relOpts{})
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.CurrentVersion = "dev"
	_, err := tu.Start(context.Background(), "v1.1.0", false)
	if !errors.Is(err, ErrDowngrade) || !strings.Contains(err.Error(), "not comparable with") {
		t.Errorf("err = %v", err)
	}
	if _, err := tu.Start(context.Background(), "v1.1.0", true); err != nil {
		t.Fatal(err)
	}
	waitDone(t, tu.Updater)
}

func TestStartAllowDowngrade(t *testing.T) {
	g := newFakeGH(t)
	g.add("v0.9.0", relOpts{})
	g.add("v1.0.0", relOpts{})
	tu := newTestUpdater(t, g)
	for _, tag := range []string{"v0.9.0", "v1.0.0"} {
		if _, err := tu.Start(context.Background(), tag, true); err != nil {
			t.Fatalf("%s: %v", tag, err)
		}
		if st := waitDone(t, tu.Updater); st.State != StateRestarting {
			t.Fatalf("%s: %+v", tag, st)
		}
	}
	if readFile(t, tu.exe) != "binary-v1.0.0" {
		t.Error("reinstall did not happen")
	}
}

func TestStartUpstreamFailure(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	g.tagStatus = http.StatusBadGateway
	if _, err := tu.Start(context.Background(), "v1.1.0", false); !errors.Is(err, ErrUpstream) {
		t.Errorf("err = %v", err)
	}
}

func TestStartExecutableUnknown(t *testing.T) {
	tu := &Updater{executable: func() (string, error) { return "", errors.New("no exe") }}
	if _, err := tu.Start(context.Background(), "v1.1.0", false); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Start err = %v", err)
	}
	if _, err := tu.Rollback(); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Rollback err = %v", err)
	}
}

func TestJobFailuresLeaveBinaryAndNoTempFiles(t *testing.T) {
	type tc struct {
		name  string
		setup func(g *fakeGH, tu *testUpdater) string // returns the tag
		want  string
	}
	tests := []tc{
		{"checksum mismatch", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: strings.Repeat("0", 64) + "  sudoku-server-linux-amd64\n"})
			return "v1.1.0"
		}, "checksum mismatch"},
		{"no sums entry", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: sha("x") + "  other-file\n"})
			return "v1.1.0"
		}, "no entry for sudoku-server-linux-amd64"},
		{"malformed sums entry", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: "nothex  sudoku-server-linux-amd64\n"})
			return "v1.1.0"
		}, "malformed entry"},
		{"short hash", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: "abcd  sudoku-server-linux-amd64\n"})
			return "v1.1.0"
		}, "malformed entry"},
		{"sums too large", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{sums: strings.Repeat("#", 200)})
			setLimits(t, 100, 1<<20)
			return "v1.1.0"
		}, "SHA256SUMS is larger than 100 bytes"},
		{"binary too large", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{binary: strings.Repeat("b", 500)})
			setLimits(t, 64<<10, 100)
			return "v1.1.0"
		}, "is larger than 100 bytes"},
		{"sums download fails", func(g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "SHA256SUMS")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					http.Error(w, "gone", http.StatusInternalServerError)
					return true
				}
				return false
			}
			return "v1.1.0"
		}, "downloading SHA256SUMS: 500"},
		{"sums body cut short", func(g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "SHA256SUMS")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					truncated(w)
					return true
				}
				return false
			}
			return "v1.1.0"
		}, "downloading SHA256SUMS"},
		{"binary download fails", func(g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "sudoku-server-linux-amd64")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					http.Error(w, "gone", http.StatusForbidden)
					return true
				}
				return false
			}
			return "v1.1.0"
		}, "downloading sudoku-server-linux-amd64: 403"},
		{"binary body cut short", func(g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "sudoku-server-linux-amd64")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					truncated(w)
					return true
				}
				return false
			}
			return "v1.1.0"
		}, "downloading sudoku-server-linux-amd64"},
		{"directory vanishes", func(g *fakeGH, tu *testUpdater) string {
			rel := g.add("v1.1.0", relOpts{})
			id := g.assetID(rel, "SHA256SUMS")
			g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
				if got == id {
					os.RemoveAll(tu.dir)
				}
				return false
			}
			return "v1.1.0"
		}, "sudoku-server"},
		{"install fails", func(g *fakeGH, tu *testUpdater) string {
			g.add("v1.1.0", relOpts{})
			setHooks(t, nil, func(a, b string) error { return errors.New("rename refused") })
			return "v1.1.0"
		}, "keeping the previous binary: rename refused"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newFakeGH(t)
			tu := newTestUpdater(t, g)
			tag := tt.setup(g, tu)
			if _, err := tu.Start(context.Background(), tag, false); err != nil {
				t.Fatal(err)
			}
			st := waitDone(t, tu.Updater)
			if st.State != StateFailed || !strings.Contains(st.Error, tt.want) || st.FinishedAt == nil {
				t.Fatalf("status = %+v, want failure containing %q", st, tt.want)
			}
			select {
			case <-tu.restarted:
				t.Error("Restart called after a failed update")
			default:
			}
			if tt.name != "directory vanishes" {
				if got := readFile(t, tu.exe); got != "old-binary" {
					t.Errorf("running binary changed: %q", got)
				}
				if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server"}) {
					t.Errorf("leftover files: %v", names)
				}
			}
			// The slot is free again.
			g.assetHook = nil
			if st := tu.Status(); st.State != StateFailed {
				t.Errorf("state = %q", st.State)
			}
			tu.mu.Lock()
			running := tu.running
			tu.mu.Unlock()
			if running {
				t.Error("job slot still held after failure")
			}
		})
	}
}

// truncated promises more bytes than it sends, then drops the connection.
func truncated(w http.ResponseWriter) {
	w.Header().Set("Content-Length", "1000")
	w.Write([]byte("short"))
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	panic(http.ErrAbortHandler)
}

func TestConcurrentStartIsBusy(t *testing.T) {
	g := newFakeGH(t)
	rel := g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	id := g.assetID(rel, "sudoku-server-linux-amd64")
	reached, release := make(chan struct{}), make(chan struct{})
	g.assetHook = func(got int64, w http.ResponseWriter, r *http.Request) bool {
		if got == id {
			close(reached)
			<-release
		}
		return false
	}
	if _, err := tu.Start(context.Background(), "v1.1.0", false); err != nil {
		t.Fatal(err)
	}
	<-reached
	if st := tu.Status(); st.State != StateDownloading || !strings.Contains(st.Message, "sudoku-server-linux-amd64") {
		t.Errorf("status while downloading = %+v", st)
	}
	if _, err := tu.Start(context.Background(), "v1.1.0", true); !errors.Is(err, ErrBusy) {
		t.Errorf("second Start err = %v, want ErrBusy", err)
	}
	if _, err := tu.Rollback(); !errors.Is(err, ErrBusy) {
		t.Errorf("Rollback err = %v, want ErrBusy", err)
	}
	close(release)
	if st := waitDone(t, tu.Updater); st.State != StateRestarting {
		t.Fatalf("status = %+v", st)
	}
	<-tu.restarted
}

func TestCheckWritable(t *testing.T) {
	dir := t.TempDir()
	if err := checkWritable(dir); err != nil {
		t.Fatal(err)
	}
	if names := dirNames(t, dir); len(names) != 0 {
		t.Errorf("probe left files: %v", names)
	}

	err := checkWritable(filepath.Join(dir, "missing"))
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "ReadWritePaths") || !strings.Contains(err.Error(), "missing") {
		t.Errorf("missing dir err = %v", err)
	}

	if os.Geteuid() == 0 {
		t.Log("running as root: skipping the permission-denied case")
		return
	}
	ro := filepath.Join(dir, "ro")
	if err := os.Mkdir(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	err = checkWritable(ro)
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), ro) || !strings.Contains(err.Error(), "not writable by the service user") || !strings.Contains(err.Error(), "ReadWritePaths") {
		t.Errorf("permission err = %v", err)
	}
}

func TestUnwritableMessage(t *testing.T) {
	ro := unwritableMessage("/opt/sudoku/bin", &fs.PathError{Op: "open", Path: "x", Err: syscall.EROFS})
	if !strings.Contains(ro, "read-only filesystem") || !strings.Contains(ro, "/opt/sudoku/bin") || !strings.Contains(ro, "ReadWritePaths") {
		t.Errorf("EROFS message = %q", ro)
	}
	perm := unwritableMessage("/opt/sudoku/bin", fs.ErrPermission)
	if !strings.Contains(perm, "not writable by the service user") || !strings.Contains(perm, "owned by") || !strings.Contains(perm, "ReadWritePaths") {
		t.Errorf("permission message = %q", perm)
	}
}

func TestStartAndRollbackNeedWritableDir(t *testing.T) {
	g := newFakeGH(t)
	g.add("v1.1.0", relOpts{})
	tu := newTestUpdater(t, g)
	tu.ExePath = filepath.Join(tu.dir, "missing-dir", "sudoku-server")
	if _, err := tu.Start(context.Background(), "v1.1.0", false); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Start err = %v", err)
	}
	if _, err := tu.Rollback(); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Rollback err = %v", err)
	}
	// The failed preflights released the slot.
	tu.mu.Lock()
	defer tu.mu.Unlock()
	if tu.running {
		t.Error("slot held after refused start")
	}
}

func TestRollback(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)

	if _, err := tu.Rollback(); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "no previous binary") {
		t.Errorf("without previous: err = %v", err)
	}
	if err := os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750); err != nil {
		t.Fatal(err)
	}
	st, err := tu.Rollback()
	if err != nil {
		t.Fatal(err)
	}
	if st.Action != "rollback" || st.StartedAt == nil {
		t.Errorf("initial status = %+v", st)
	}
	final := waitDone(t, tu.Updater)
	if final.State != StateRestarting || final.Action != "rollback" || final.Error != "" {
		t.Errorf("final = %+v", final)
	}
	<-tu.restarted
	if readFile(t, tu.exe) != "older-binary" || readFile(t, tu.exe+".previous") != "old-binary" {
		t.Error("binaries not swapped")
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server", "sudoku-server.previous"}) {
		t.Errorf("dir = %v", names)
	}
	// Rolling back twice swaps again.
	if _, err := tu.Rollback(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, tu.Updater)
	if readFile(t, tu.exe) != "old-binary" || readFile(t, tu.exe+".previous") != "older-binary" {
		t.Error("second rollback did not swap back")
	}
}

func TestRollbackFailures(t *testing.T) {
	tests := []struct {
		name   string
		link   func(a, b string) error
		rename func(a, b string) error
		remove bool
		want   string
	}{
		{"current binary missing", nil, nil, true, "no such file"},
		{"restoring fails", nil, func(a, b string) error { return errors.New("rename refused") }, false, "rename refused"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := newFakeGH(t)
			tu := newTestUpdater(t, g)
			os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750)
			if tt.remove {
				os.Remove(tu.exe)
			}
			setHooks(t, tt.link, tt.rename)
			if _, err := tu.Rollback(); err != nil {
				t.Fatal(err)
			}
			st := waitDone(t, tu.Updater)
			if st.State != StateFailed || !strings.Contains(st.Error, tt.want) {
				t.Fatalf("status = %+v", st)
			}
			if readFile(t, tu.exe+".previous") != "older-binary" {
				t.Error("previous binary lost")
			}
			for _, n := range dirNames(t, tu.dir) {
				if strings.HasSuffix(n, ".tmp") {
					t.Errorf("leftover %s", n)
				}
			}
		})
	}
}

func TestRollbackCannotKeepReplacedBinary(t *testing.T) {
	g := newFakeGH(t)
	tu := newTestUpdater(t, g)
	os.WriteFile(tu.exe+".previous", []byte("older-binary"), 0o750)
	calls := 0
	setHooks(t, nil, func(a, b string) error {
		if calls++; calls == 2 {
			return errors.New("second rename refused")
		}
		return os.Rename(a, b)
	})
	if _, err := tu.Rollback(); err != nil {
		t.Fatal(err)
	}
	if st := waitDone(t, tu.Updater); st.State != StateRestarting {
		t.Fatalf("status = %+v", st)
	}
	if readFile(t, tu.exe) != "older-binary" {
		t.Error("rollback did not install the previous binary")
	}
	if names := dirNames(t, tu.dir); !reflect.DeepEqual(names, []string{"sudoku-server"}) {
		t.Errorf("dir = %v", names)
	}
}

func TestInstallErrors(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sudoku-server")
	os.WriteFile(exe, []byte("old"), 0o755)

	// Chmod of a file that does not exist.
	if err := install(exe, filepath.Join(dir, "missing")); err == nil {
		t.Error("expected chmod error")
	}

	// A missing running binary: the mode falls back to 0755, then keeping the
	// previous binary fails.
	nonexistent := filepath.Join(dir, "gone")
	newPath := filepath.Join(dir, "new")
	os.WriteFile(newPath, []byte("new"), 0o600)
	if err := install(nonexistent, newPath); err == nil || !strings.Contains(err.Error(), "keeping the previous binary") {
		t.Errorf("err = %v", err)
	}
	if fi, _ := os.Stat(newPath); fi.Mode().Perm() != 0o755 {
		t.Errorf("fallback mode = %v", fi.Mode().Perm())
	}

	// The commit rename fails after the previous binary was kept.
	calls := 0
	setHooks(t, nil, func(a, b string) error {
		if calls++; calls == 2 {
			return errors.New("commit refused")
		}
		return os.Rename(a, b)
	})
	if err := install(exe, newPath); err == nil || err.Error() != "commit refused" {
		t.Errorf("err = %v", err)
	}
	if readFile(t, exe) != "old" {
		t.Error("binary changed although the commit failed")
	}
}

func TestKeepAsErrors(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	os.WriteFile(src, []byte("data"), 0o755)
	dst := filepath.Join(dir, "dst")

	// The temp name is taken by a non-empty directory: linking and the
	// exclusive create both fail.
	os.MkdirAll(filepath.Join(dst+".tmp", "x"), 0o755)
	if err := keepAs(src, dst); err == nil {
		t.Error("expected error when the temp name is occupied")
	}
	os.RemoveAll(dst + ".tmp")

	// Renaming into place fails: the temp file is cleaned up.
	setHooks(t, nil, func(a, b string) error { return errors.New("rename refused") })
	if err := keepAs(src, dst); err == nil {
		t.Error("expected rename error")
	}
	if _, err := os.Stat(dst + ".tmp"); !os.IsNotExist(err) {
		t.Error("temp file left behind")
	}
}

func TestCopyFileErrors(t *testing.T) {
	dir := t.TempDir()
	if err := copyFile(filepath.Join(dir, "missing"), filepath.Join(dir, "out")); err == nil {
		t.Error("expected open error")
	}
	// Reading a directory fails mid-copy and removes the partial output.
	out := filepath.Join(dir, "out")
	if err := copyFile(dir, out); err == nil {
		t.Error("expected copy error")
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Error("partial copy left behind")
	}
	// The destination already exists.
	src := filepath.Join(dir, "src")
	os.WriteFile(src, []byte("x"), 0o644)
	os.WriteFile(out, []byte("taken"), 0o644)
	if err := copyFile(src, out); err == nil {
		t.Error("expected exclusive-create error")
	}
	if readFile(t, out) != "taken" {
		t.Error("existing destination clobbered")
	}
}

func TestParseSums(t *testing.T) {
	h1, h2 := sha("a"), sha("b")
	sums := h1 + "  one\n" + strings.ToUpper(h2) + " *two\n\n  \nline-without-hash\n"
	if got, err := parseSums(sums, "one"); err != nil || got != h1 {
		t.Errorf("one: %q, %v", got, err)
	}
	if got, err := parseSums(sums, "two"); err != nil || got != h2 {
		t.Errorf("two (binary marker, uppercase): %q, %v", got, err)
	}
	if _, err := parseSums(sums, "three"); err == nil {
		t.Error("expected missing entry error")
	}
}

func TestErrorType(t *testing.T) {
	err := fail(ErrBusy, "busy %d", 1)
	if err.Error() != "busy 1" || !errors.Is(err, ErrBusy) || errors.Is(err, ErrUpstream) {
		t.Errorf("err = %v", err)
	}
	wrapped := fmt.Errorf("outer: %w", err)
	if !errors.Is(wrapped, ErrBusy) {
		t.Error("wrapped error lost its kind")
	}
}

func TestSyncDirMissingIsIgnored(t *testing.T) {
	syncDir(filepath.Join(t.TempDir(), "missing"))
}

func TestFetchAssetRequestFailure(t *testing.T) {
	tu := &Updater{APIBase: "http://\x7f"}
	if _, err := tu.fetchAsset(context.Background(), ghAsset{ID: 1, Name: "x"}); err == nil {
		t.Error("expected request error")
	}
}
