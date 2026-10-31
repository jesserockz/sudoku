// Package update replaces the running server binary, and optionally the web
// client directory, with a release from GitHub, verified against the
// release's SHA256SUMS, and can swap the previous versions back in. It only
// ever talks to the configured GitHub API base and repository, never to a URL
// supplied by a client.
package update

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jesserockz/sudoku/server/internal/version"
)

// Defaults for Updater fields.
const (
	DefaultAPIBase = "https://api.github.com"
	DefaultRepo    = "jesserockz/sudoku"
)

const (
	sumsAsset      = "SHA256SUMS"
	webAsset       = "sudoku-web.zip"
	maxReleases    = 30
	metaTimeout    = 30 * time.Second
	jobTimeout     = 15 * time.Minute
	previousSuffix = ".previous"
)

// Size limits for downloads; variables so tests can lower them.
var (
	maxSumsBytes   int64 = 64 << 10
	maxBinaryBytes int64 = 256 << 20
	// maxWebBytes bounds both the web bundle download and its total
	// uncompressed size; maxWebEntries bounds the number of archive entries.
	maxWebBytes   int64 = 64 << 20
	maxWebEntries       = 10000
)

// Filesystem hooks, replaced in tests to inject failures.
var (
	fsLink   = os.Link
	fsRename = os.Rename
)

// Kinds of failure, matched with errors.Is; the API maps each to a status.
var (
	ErrInvalidTag  = errors.New("invalid tag")
	ErrBusy        = errors.New("update in progress")
	ErrUnavailable = errors.New("update unavailable")
	ErrNotFound    = errors.New("release not found")
	ErrDowngrade   = errors.New("downgrade not confirmed")
	ErrUpstream    = errors.New("upstream error")
)

// Error is a failure of one of the kinds above, with a message that is safe
// to show to an admin.
type Error struct {
	Kind error
	Msg  string
}

func (e *Error) Error() string        { return e.Msg }
func (e *Error) Is(target error) bool { return target == e.Kind }

func fail(kind error, format string, args ...any) error {
	return &Error{Kind: kind, Msg: fmt.Sprintf(format, args...)}
}

// Job states.
const (
	StateIdle        = "idle"
	StateDownloading = "downloading"
	StateVerifying   = "verifying"
	StateInstalling  = "installing"
	StateRestarting  = "restarting"
	StateFailed      = "failed"
)

// Info describes the running server.
type Info struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Asset   string `json:"asset"`
	// WebDir is true when updates also replace the web client.
	WebDir bool `json:"updatesWeb"`
}

// Release is one GitHub release, as shown to the admin.
type Release struct {
	Tag                  string `json:"tag"`
	Version              string `json:"version"`
	Name                 string `json:"name"`
	PublishedAt          string `json:"publishedAt"`
	Prerelease           bool   `json:"prerelease"`
	Latest               bool   `json:"latest"`
	Current              bool   `json:"current"`
	Comparison           string `json:"comparison"`
	Installable          bool   `json:"installable"`
	NotInstallableReason string `json:"notInstallableReason"`
	URL                  string `json:"url"`
}

// Status is the progress of the current or last job.
type Status struct {
	State             string     `json:"state"`
	Action            string     `json:"action"`
	Target            string     `json:"target"`
	Message           string     `json:"message"`
	Error             string     `json:"error"`
	BytesDone         int64      `json:"bytesDone"`
	BytesTotal        int64      `json:"bytesTotal"`
	StartedAt         *time.Time `json:"startedAt"`
	FinishedAt        *time.Time `json:"finishedAt"`
	RollbackAvailable bool       `json:"rollbackAvailable"`
}

// Updater installs releases. Only one job (update or rollback) runs at a time.
type Updater struct {
	// APIBase is the GitHub API root; Repo is "owner/name".
	APIBase string
	Repo    string
	// HTTPClient fetches releases and assets; nil means a default client.
	HTTPClient *http.Client
	// ExePath is the binary to replace; empty means the running executable
	// with symlinks resolved.
	ExePath string
	// GOOS and GOARCH select the release asset; empty means the runtime's.
	GOOS   string
	GOARCH string
	// CurrentVersion is the running version; empty means version.Version.
	CurrentVersion string
	// WebDir is the web client directory to replace with the release's
	// sudoku-web.zip; empty means only the binary is updated.
	WebDir string
	// Restart is called after a new binary is in place; it should make the
	// process exit so the service manager starts the new one.
	Restart func()

	// executable overrides os.Executable (tests).
	executable func() (string, error)

	mu      sync.Mutex
	running bool
	status  Status
}

func (u *Updater) apiBase() string {
	if u.APIBase != "" {
		return strings.TrimSuffix(u.APIBase, "/")
	}
	return DefaultAPIBase
}

func (u *Updater) repo() string {
	if u.Repo != "" {
		return u.Repo
	}
	return DefaultRepo
}

func (u *Updater) client() *http.Client {
	if u.HTTPClient != nil {
		return u.HTTPClient
	}
	return http.DefaultClient
}

func (u *Updater) goos() string {
	if u.GOOS != "" {
		return u.GOOS
	}
	return runtime.GOOS
}

func (u *Updater) goarch() string {
	if u.GOARCH != "" {
		return u.GOARCH
	}
	return runtime.GOARCH
}

func (u *Updater) currentVersion() string {
	if u.CurrentVersion != "" {
		return u.CurrentVersion
	}
	return version.Version
}

func (u *Updater) assetName() string { return "sudoku-server-" + u.goos() + "-" + u.goarch() }

func (u *Updater) exePath() (string, error) {
	if u.ExePath != "" {
		return u.ExePath, nil
	}
	executable := u.executable
	if executable == nil {
		executable = os.Executable
	}
	p, err := executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// Info describes the running server.
func (u *Updater) Info() Info {
	return Info{Version: u.currentVersion(), OS: u.goos(), Arch: u.goarch(), Asset: u.assetName(), WebDir: u.WebDir != ""}
}

// Status returns the progress of the current or last job.
func (u *Updater) Status() Status {
	u.mu.Lock()
	st := u.status
	u.mu.Unlock()
	if st.State == "" {
		st.State = StateIdle
	}
	if exe, err := u.exePath(); err == nil {
		if fi, err := os.Stat(exe + previousSuffix); err == nil && fi.Mode().IsRegular() {
			st.RollbackAvailable = true
		}
	}
	return st
}

// ghRelease and ghAsset are the parts of GitHub's release JSON we use.
type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	PublishedAt string    `json:"published_at"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	HTMLURL     string    `json:"html_url"`
	Assets      []ghAsset `json:"assets"`
}

type ghAsset struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func (r ghRelease) asset(name string) (ghAsset, bool) {
	for _, a := range r.Assets {
		if a.Name == name {
			return a, true
		}
	}
	return ghAsset{}, false
}

// get performs a GET below APIBase/repos/{Repo}. The caller closes the body.
func (u *Updater) get(ctx context.Context, path, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.apiBase()+"/repos/"+u.repo()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", "sudoku-server/"+u.currentVersion())
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	return u.client().Do(req)
}

// getJSON fetches path and decodes the JSON body into v. A 404 is reported
// as ErrNotFound, every other failure as ErrUpstream.
func (u *Updater) getJSON(ctx context.Context, path string, v any) error {
	ctx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()
	resp, err := u.get(ctx, path, "application/vnd.github+json")
	if err != nil {
		return fail(ErrUpstream, "github request: %v", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return fail(ErrNotFound, "github: not found")
	case resp.StatusCode != http.StatusOK:
		return fail(ErrUpstream, "github: %s", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return fail(ErrUpstream, "github response: %v", err)
	}
	return nil
}

// Releases lists up to 30 recent published releases, newest first, with how
// each relates to the running version. Prereleases are omitted unless asked
// for.
func (u *Updater) Releases(ctx context.Context, prereleases bool) ([]Release, error) {
	var list []ghRelease
	if err := u.getJSON(ctx, fmt.Sprintf("/releases?per_page=%d", maxReleases), &list); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, fail(ErrUpstream, "github: repository or releases not found")
		}
		return nil, err
	}
	var latest string
	var latestVer semver
	out := []Release{}
	for _, g := range list {
		if g.Draft {
			continue
		}
		v := strings.TrimPrefix(g.TagName, "v")
		rel := Release{
			Tag:         g.TagName,
			Version:     v,
			Name:        g.Name,
			PublishedAt: g.PublishedAt,
			Prerelease:  g.Prerelease,
			Comparison:  Compare(v, u.currentVersion()),
			Installable: true,
			URL:         g.HTMLURL,
		}
		rel.Current = v == strings.TrimPrefix(u.currentVersion(), "v")
		if err := u.checkAssets(g); err != nil {
			rel.Installable, rel.NotInstallableReason = false, err.Error()
		}
		if !g.Prerelease {
			if sv, ok := parseSemver(v); ok && (latest == "" || sv.compare(latestVer) > 0) {
				latest, latestVer = g.TagName, sv
			}
		}
		if g.Prerelease && !prereleases {
			continue
		}
		out = append(out, rel)
	}
	for i := range out {
		out[i].Latest = out[i].Tag == latest
	}
	return out, nil
}

// checkAssets verifies the release carries this platform's binary, its
// checksums and, when the web client is updated too, the web bundle.
func (u *Updater) checkAssets(g ghRelease) error {
	if _, ok := g.asset(u.assetName()); !ok {
		return fmt.Errorf("no %s asset", u.assetName())
	}
	if _, ok := g.asset(sumsAsset); !ok {
		return fmt.Errorf("no %s", sumsAsset)
	}
	if u.WebDir != "" {
		if _, ok := g.asset(webAsset); !ok {
			return fmt.Errorf("no %s asset", webAsset)
		}
	}
	return nil
}

// begin claims the single job slot.
func (u *Updater) begin() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.running {
		return fail(ErrBusy, "an update or rollback is already in progress")
	}
	u.running = true
	return nil
}

// abort releases the job slot when a job was refused before it started.
func (u *Updater) abort() {
	u.mu.Lock()
	u.running = false
	u.mu.Unlock()
}

// launch records the job as started and runs it in the background.
func (u *Updater) launch(action, target string, job func(ctx context.Context) error) Status {
	now := time.Now()
	u.mu.Lock()
	u.status = Status{State: StateDownloading, Action: action, Target: target, StartedAt: &now}
	u.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), jobTimeout)
		defer cancel()
		if err := job(ctx); err != nil {
			slog.Error("self-update failed", "action", action, "target", target, "err", err)
			u.finish(StateFailed, "", err.Error())
			return
		}
		u.finish(StateRestarting, "Restarting the server", "")
		slog.Warn("restart requested for self-update", "action", action, "target", target)
		if u.Restart != nil {
			u.Restart()
		}
	}()
	return u.Status()
}

func (u *Updater) finish(state, msg, errMsg string) {
	now := time.Now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status.State, u.status.Error, u.status.FinishedAt = state, errMsg, &now
	if msg != "" {
		u.status.Message = msg
	}
	u.running = false
}

// set updates the state and message of the running job.
func (u *Updater) set(state, msg string) {
	u.mu.Lock()
	u.status.State, u.status.Message = state, msg
	u.mu.Unlock()
}

// checkWritableDirs proves everything an update or rollback replaces can be
// written: the binary's directory and, swapping the web directory, its parent.
func (u *Updater) checkWritableDirs(exe string) error {
	if err := checkWritable(filepath.Dir(exe)); err != nil {
		return err
	}
	if u.WebDir != "" {
		return checkWritable(filepath.Dir(u.WebDir))
	}
	return nil
}

// checkWritable proves files can be created in dir, which an update needs.
func checkWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".sudoku-writable-*")
	if err != nil {
		return fail(ErrUnavailable, "%s", unwritableMessage(dir, err))
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return nil
}

func unwritableMessage(dir string, err error) string {
	switch {
	case errors.Is(err, syscall.EROFS):
		return fmt.Sprintf("the directory %s is on a read-only filesystem; add it to ReadWritePaths in the systemd unit (see deploy/README.md)", dir)
	case errors.Is(err, fs.ErrPermission):
		return fmt.Sprintf("the directory %s is not writable by the service user; it must be owned by that user and listed in ReadWritePaths in the systemd unit (see deploy/README.md)", dir)
	}
	return fmt.Sprintf("cannot write to the directory %s (see ReadWritePaths in deploy/README.md): %v", dir, err)
}

// Start begins installing the release with the given tag and returns the
// initial status. It checks everything it can synchronously; the download and
// install run in the background. Anything that is not an upgrade needs
// allowDowngrade.
func (u *Updater) Start(ctx context.Context, tag string, allowDowngrade bool) (Status, error) {
	if !ValidTag(tag) {
		return Status{}, fail(ErrInvalidTag, "tag must look like v1.2.3")
	}
	if err := u.begin(); err != nil {
		return Status{}, err
	}
	exe, rel, err := u.preflight(ctx, tag, allowDowngrade)
	if err != nil {
		u.abort()
		return Status{}, err
	}
	bin, _ := rel.asset(u.assetName())
	sums, _ := rel.asset(sumsAsset)
	var web ghAsset
	if u.WebDir != "" {
		web, _ = rel.asset(webAsset)
	}
	return u.launch("update", rel.TagName, func(ctx context.Context) error {
		return u.runUpdate(ctx, exe, bin, sums, web)
	}), nil
}

func (u *Updater) preflight(ctx context.Context, tag string, allowDowngrade bool) (string, ghRelease, error) {
	exe, err := u.exePath()
	if err != nil {
		return "", ghRelease{}, fail(ErrUnavailable, "cannot locate the running binary: %v", err)
	}
	if err := u.checkWritableDirs(exe); err != nil {
		return "", ghRelease{}, err
	}
	var rel ghRelease
	if err := u.getJSON(ctx, "/releases/tags/"+url.PathEscape(tag), &rel); err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", ghRelease{}, fail(ErrNotFound, "release %s not found", tag)
		}
		return "", ghRelease{}, err
	}
	if rel.Draft {
		return "", ghRelease{}, fail(ErrNotFound, "release %s not found", tag)
	}
	if err := u.checkAssets(rel); err != nil {
		return "", ghRelease{}, fail(ErrUnavailable, "release %s cannot be installed: %v", rel.TagName, err)
	}
	if cmp := Compare(rel.TagName, u.currentVersion()); cmp != Newer && !allowDowngrade {
		return "", ghRelease{}, fail(ErrDowngrade, "%s is %s than the running version %s; confirm to install it anyway",
			rel.TagName, map[string]string{Same: "the same version as", Older: "older", Unknown: "not comparable with"}[cmp], u.currentVersion())
	}
	return exe, rel, nil
}

// fetchAsset opens an asset's content by id. The caller closes the body.
func (u *Updater) fetchAsset(ctx context.Context, a ghAsset) (io.ReadCloser, error) {
	resp, err := u.get(ctx, fmt.Sprintf("/releases/assets/%d", a.ID), "application/octet-stream")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("downloading %s: %s", a.Name, resp.Status)
	}
	return resp.Body, nil
}

// parseSums finds name's SHA-256 in the contents of a SHA256SUMS file.
func parseSums(sums, name string) (string, error) {
	for _, line := range strings.Split(sums, "\n") {
		hash, file, ok := strings.Cut(strings.TrimSpace(line), " ")
		file = strings.TrimPrefix(strings.TrimSpace(file), "*")
		if ok && file == name {
			if b, err := hex.DecodeString(hash); err != nil || len(b) != sha256.Size {
				return "", fmt.Errorf("%s has a malformed entry for %s", sumsAsset, name)
			}
			return strings.ToLower(hash), nil
		}
	}
	return "", fmt.Errorf("%s has no entry for %s", sumsAsset, name)
}

// fetchSums downloads the SHA256SUMS file, which callers look entries up in
// with parseSums.
func (u *Updater) fetchSums(ctx context.Context, a ghAsset) (string, error) {
	body, err := u.fetchAsset(ctx, a)
	if err != nil {
		return "", err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxSumsBytes+1))
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", sumsAsset, err)
	}
	if int64(len(data)) > maxSumsBytes {
		return "", fmt.Errorf("%s is larger than %d bytes", sumsAsset, maxSumsBytes)
	}
	return string(data), nil
}

// progressWriter counts bytes written into the job status.
type progressWriter struct{ u *Updater }

func (p progressWriter) Write(b []byte) (int, error) {
	p.u.mu.Lock()
	p.u.status.BytesDone += int64(len(b))
	p.u.mu.Unlock()
	return len(b), nil
}

// runUpdate downloads, verifies and installs the release binary and, when
// WebDir is set, its web bundle (web is the zero asset otherwise). Both are
// downloaded, verified and staged before anything is replaced, so any failure
// up to then leaves the running install untouched. The web directory is
// swapped first, then the binary; if the binary cannot be installed the old
// web directory is put back.
func (u *Updater) runUpdate(ctx context.Context, exe string, bin, sums, web ghAsset) error {
	u.set(StateDownloading, "Downloading "+sumsAsset)
	sumsText, err := u.fetchSums(ctx, sums)
	if err != nil {
		return err
	}
	want, err := parseSums(sumsText, bin.Name)
	if err != nil {
		return err
	}
	var wantWeb string
	if u.WebDir != "" {
		if wantWeb, err = parseSums(sumsText, web.Name); err != nil {
			return err
		}
	}

	tmp, err := os.CreateTemp(filepath.Dir(exe), ".sudoku-server-*.new")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed into place

	u.set(StateDownloading, "Downloading "+bin.Name)
	u.mu.Lock()
	u.status.BytesTotal = bin.Size + web.Size
	u.mu.Unlock()
	got, err := u.download(ctx, bin, tmp, maxBinaryBytes)
	if err != nil {
		return err
	}
	u.set(StateVerifying, "Verifying "+bin.Name)
	if got != want {
		return errors.New("checksum mismatch: the download does not match " + sumsAsset)
	}

	var staging string
	if u.WebDir != "" {
		if staging, err = u.stageWeb(ctx, web, wantWeb); err != nil {
			return err
		}
		defer os.RemoveAll(staging) // a no-op once renamed into place
	}

	var hadOldWeb bool
	if u.WebDir != "" {
		u.set(StateInstalling, "Installing the web client")
		if hadOldWeb, err = installDir(u.WebDir, staging); err != nil {
			return err
		}
	}
	u.set(StateInstalling, "Installing "+bin.Name)
	if err := install(exe, tmp.Name()); err != nil {
		if u.WebDir != "" {
			restoreDir(u.WebDir, hadOldWeb)
		}
		return err
	}
	return nil
}

// stageWeb downloads the web bundle next to WebDir, verifies it against want
// and unpacks it into a fresh staging directory, which it returns. Nothing
// is left behind on failure.
func (u *Updater) stageWeb(ctx context.Context, a ghAsset, want string) (string, error) {
	parent := filepath.Dir(u.WebDir)
	zipTmp, err := os.CreateTemp(parent, ".sudoku-web-*.zip")
	if err != nil {
		return "", err
	}
	defer os.Remove(zipTmp.Name())

	u.set(StateDownloading, "Downloading "+a.Name)
	got, err := u.download(ctx, a, zipTmp, maxWebBytes)
	if err != nil {
		return "", err
	}
	u.set(StateVerifying, "Verifying "+a.Name)
	if got != want {
		return "", errors.New("checksum mismatch: the download does not match " + sumsAsset)
	}

	u.set(StateInstalling, "Unpacking "+a.Name)
	staging, err := os.MkdirTemp(parent, ".sudoku-web-*.new")
	if err != nil {
		return "", err
	}
	if err := extractZip(zipTmp.Name(), staging); err != nil {
		os.RemoveAll(staging)
		return "", fmt.Errorf("unpacking %s: %w", a.Name, err)
	}
	return staging, nil
}

// download streams the asset into tmp, hashing as it goes, then fsyncs and
// closes tmp. It fails if the asset is larger than limit bytes. It returns
// the hex SHA-256 of what was written; it is only meaningful if the error is
// nil.
func (u *Updater) download(ctx context.Context, a ghAsset, tmp *os.File, limit int64) (string, error) {
	defer tmp.Close()
	body, err := u.fetchAsset(ctx, a)
	if err != nil {
		return "", err
	}
	defer body.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h, progressWriter{u}), io.LimitReader(body, limit+1))
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", a.Name, err)
	}
	if n > limit {
		return "", fmt.Errorf("%s is larger than %d bytes", a.Name, limit)
	}
	return hex.EncodeToString(h.Sum(nil)), tmp.Sync()
}

// extractZip unpacks the archive at zipPath into the existing directory dest.
// Everything is created through an os.Root on dest, and only plain files and
// directories with relative, non-escaping names are accepted. Modes in the
// archive are ignored: files get 0644 and directories 0755. The archive must
// hold an index.html at its top level.
func extractZip(zipPath, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	if len(zr.File) > maxWebEntries {
		return fmt.Errorf("the archive has more than %d entries", maxWebEntries)
	}
	root, err := os.OpenRoot(dest)
	if err != nil {
		return err
	}
	defer root.Close()

	left := maxWebBytes
	for _, f := range zr.File {
		name, err := entryName(f.Name)
		if err != nil {
			return err
		}
		if name == "" { // the archive root itself
			continue
		}
		switch mode := f.Mode(); {
		case mode.IsDir():
			err = root.MkdirAll(name, 0o755)
		case mode.IsRegular():
			var n int64
			if n, err = extractFile(root, f, name, left); err == nil {
				left -= n
			}
		default:
			err = fmt.Errorf("%s is not a regular file or directory", f.Name)
		}
		if err != nil {
			return err
		}
	}
	if fi, err := root.Stat("index.html"); err != nil || !fi.Mode().IsRegular() {
		return errors.New("the archive has no index.html at its top level")
	}
	return nil
}

// entryName turns an archive entry name into a clean relative slash path,
// "" for the archive root. Names that are absolute, contain backslashes or
// have ".." components are refused, not repaired.
func entryName(name string) (string, error) {
	if strings.HasPrefix(name, "/") || strings.Contains(name, "\\") {
		return "", fmt.Errorf("unsafe entry name %q", name)
	}
	var parts []string
	for _, p := range strings.Split(name, "/") {
		switch p {
		case "..":
			return "", fmt.Errorf("unsafe entry name %q", name)
		case "", ".":
		default:
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, "/"), nil
}

// extractFile writes one archive file below root and returns its size. It
// fails if the file is larger than limit bytes.
func extractFile(root *os.Root, f *zip.File, name string, limit int64) (int64, error) {
	if dir := path.Dir(name); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return 0, err
		}
	}
	in, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(in, limit+1))
	if err == nil && n > limit {
		err = fmt.Errorf("the archive is larger than %d bytes uncompressed", maxWebBytes)
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, err
}

// installDir makes staging the directory dir, keeping the old one as
// dir.previous (replacing an older dir.previous). hadOld reports whether
// there was an old dir to keep, for restoreDir. The final rename is the
// commit point.
func installDir(dir, staging string) (hadOld bool, err error) {
	prev := dir + previousSuffix
	os.RemoveAll(prev) // if this fails, the rename below does too
	if _, err := os.Stat(dir); err == nil {
		hadOld = true
		if err := fsRename(dir, prev); err != nil {
			return false, fmt.Errorf("keeping the previous web client: %w", err)
		}
	}
	if err := fsRename(staging, dir); err != nil {
		restoreDir(dir, hadOld)
		return false, err
	}
	syncDir(filepath.Dir(dir))
	return hadOld, nil
}

// restoreDir undoes installDir: it removes dir and, if there was one, puts
// dir.previous back. Best effort; failures are logged.
func restoreDir(dir string, hadOld bool) {
	os.RemoveAll(dir)
	if hadOld {
		if err := os.Rename(dir+previousSuffix, dir); err != nil {
			slog.Error("could not put the previous web client back", "dir", dir, "err", err)
		}
	}
	syncDir(filepath.Dir(dir))
}

// install makes newPath the binary at exe, keeping the old one as
// exe.previous. The final rename is the commit point.
func install(exe, newPath string) error {
	mode := fs.FileMode(0o755)
	if fi, err := os.Stat(exe); err == nil {
		mode = fi.Mode().Perm()
	}
	if err := os.Chmod(newPath, mode); err != nil {
		return err
	}
	if err := keepAs(exe, exe+previousSuffix); err != nil {
		return fmt.Errorf("keeping the previous binary: %w", err)
	}
	if err := fsRename(newPath, exe); err != nil {
		return err
	}
	syncDir(filepath.Dir(exe))
	return nil
}

// keepAs makes dst a second name for src's current content (a hard link, or
// a copy if linking is not possible), replacing dst atomically.
func keepAs(src, dst string) error {
	tmp := dst + ".tmp"
	os.Remove(tmp)
	if err := fsLink(src, tmp); err != nil {
		if err := copyFile(src, tmp); err != nil {
			return err
		}
	}
	if err := fsRename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func copyFile(src, dst string) (err error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	mode := fs.FileMode(0o755)
	if fi, err := in.Stat(); err == nil {
		mode = fi.Mode().Perm()
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(dst)
		}
	}()
	if _, err = io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// syncDir flushes a directory's entries to disk, best effort: some
// filesystems do not support it.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}

// Rollback swaps exe.previous back in; the replaced binary becomes the new
// exe.previous. The same goes for the web directory, when WebDir is set and
// has a .previous (an update made by an older version left none, and then
// only the binary is rolled back). It returns the initial status; the restart
// happens in the background.
func (u *Updater) Rollback() (Status, error) {
	if err := u.begin(); err != nil {
		return Status{}, err
	}
	exe, err := u.rollbackPreflight()
	if err != nil {
		u.abort()
		return Status{}, err
	}
	return u.launch("rollback", "", func(context.Context) error {
		return u.runRollback(exe)
	}), nil
}

func (u *Updater) rollbackPreflight() (string, error) {
	exe, err := u.exePath()
	if err != nil {
		return "", fail(ErrUnavailable, "cannot locate the running binary: %v", err)
	}
	if err := u.checkWritableDirs(exe); err != nil {
		return "", err
	}
	if fi, err := os.Stat(exe + previousSuffix); err != nil || !fi.Mode().IsRegular() {
		return "", fail(ErrUnavailable, "there is no previous binary to roll back to")
	}
	return exe, nil
}

func rollback(exe string) error {
	prev := exe + previousSuffix
	tmp := exe + ".rollback.tmp"
	os.Remove(tmp)
	if err := fsLink(exe, tmp); err != nil {
		if err := copyFile(exe, tmp); err != nil {
			return err
		}
	}
	if err := fsRename(prev, exe); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := fsRename(tmp, prev); err != nil {
		os.Remove(tmp)
		slog.Warn("rolled back, but could not keep the replaced binary", "err", err)
	}
	syncDir(filepath.Dir(exe))
	return nil
}

// runRollback swaps the web directory back first, then the binary; if the
// binary cannot be swapped the web directory is swapped forward again.
func (u *Updater) runRollback(exe string) error {
	var swappedWeb bool
	if u.WebDir != "" {
		if fi, err := os.Stat(u.WebDir + previousSuffix); err == nil && fi.IsDir() {
			u.set(StateInstalling, "Restoring the previous web client")
			if err := rollbackDir(u.WebDir); err != nil {
				return err
			}
			swappedWeb = true
		} else {
			slog.Info("no previous web client to restore; rolling back the binary only", "dir", u.WebDir+previousSuffix)
		}
	}
	u.set(StateInstalling, "Restoring the previous binary")
	if err := rollback(exe); err != nil {
		if swappedWeb {
			if werr := rollbackDir(u.WebDir); werr != nil {
				slog.Error("could not put the web client back after a failed rollback", "err", werr)
			}
		}
		return err
	}
	return nil
}

// rollbackDir swaps dir and dir.previous, like rollback does for the binary.
func rollbackDir(dir string) error {
	prev := dir + previousSuffix
	tmp := dir + ".rollback.tmp"
	os.RemoveAll(tmp)
	if err := fsRename(dir, tmp); err != nil {
		return err
	}
	if err := fsRename(prev, dir); err != nil {
		os.Rename(tmp, dir)
		return err
	}
	if err := fsRename(tmp, prev); err != nil {
		os.RemoveAll(tmp)
		slog.Warn("rolled back, but could not keep the replaced web client", "err", err)
	}
	syncDir(filepath.Dir(dir))
	return nil
}
