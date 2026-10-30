// Package update replaces the running server binary with a release from
// GitHub, verified against the release's SHA256SUMS, and can swap the
// previous binary back in. It only ever talks to the configured GitHub API
// base and repository, never to a URL supplied by a client.
package update

import (
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
	maxReleases    = 30
	metaTimeout    = 30 * time.Second
	jobTimeout     = 15 * time.Minute
	previousSuffix = ".previous"
)

// Size limits for downloads; variables so tests can lower them.
var (
	maxSumsBytes   int64 = 64 << 10
	maxBinaryBytes int64 = 256 << 20
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
	return Info{Version: u.currentVersion(), OS: u.goos(), Arch: u.goarch(), Asset: u.assetName()}
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

// checkAssets verifies the release carries this platform's binary and its
// checksums.
func (u *Updater) checkAssets(g ghRelease) error {
	if _, ok := g.asset(u.assetName()); !ok {
		return fmt.Errorf("no %s asset", u.assetName())
	}
	if _, ok := g.asset(sumsAsset); !ok {
		return fmt.Errorf("no %s", sumsAsset)
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
	return u.launch("update", rel.TagName, func(ctx context.Context) error {
		return u.runUpdate(ctx, exe, bin, sums)
	}), nil
}

func (u *Updater) preflight(ctx context.Context, tag string, allowDowngrade bool) (string, ghRelease, error) {
	exe, err := u.exePath()
	if err != nil {
		return "", ghRelease{}, fail(ErrUnavailable, "cannot locate the running binary: %v", err)
	}
	if err := checkWritable(filepath.Dir(exe)); err != nil {
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

func (u *Updater) fetchSums(ctx context.Context, a ghAsset, name string) (string, error) {
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
	return parseSums(string(data), name)
}

// progressWriter counts bytes written into the job status.
type progressWriter struct{ u *Updater }

func (p progressWriter) Write(b []byte) (int, error) {
	p.u.mu.Lock()
	p.u.status.BytesDone += int64(len(b))
	p.u.mu.Unlock()
	return len(b), nil
}

// runUpdate downloads, verifies and installs the release binary. The new
// binary is only renamed over exe once it is complete and checked, so any
// failure leaves the running binary untouched.
func (u *Updater) runUpdate(ctx context.Context, exe string, bin, sums ghAsset) error {
	u.set(StateDownloading, "Downloading "+sumsAsset)
	want, err := u.fetchSums(ctx, sums, bin.Name)
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(filepath.Dir(exe), ".sudoku-server-*.new")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed into place

	u.set(StateDownloading, "Downloading "+bin.Name)
	u.mu.Lock()
	u.status.BytesTotal = bin.Size
	u.mu.Unlock()
	got, err := u.download(ctx, bin, tmp)
	if err != nil {
		return err
	}
	u.set(StateVerifying, "Verifying "+bin.Name)
	if got != want {
		return errors.New("checksum mismatch: the download does not match " + sumsAsset)
	}

	u.set(StateInstalling, "Installing "+bin.Name)
	return install(exe, tmp.Name())
}

// download streams the asset into tmp, hashing as it goes, then fsyncs and
// closes tmp. It returns the hex SHA-256 of what was written; it is only
// meaningful if the error is nil.
func (u *Updater) download(ctx context.Context, a ghAsset, tmp *os.File) (string, error) {
	defer tmp.Close()
	body, err := u.fetchAsset(ctx, a)
	if err != nil {
		return "", err
	}
	defer body.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h, progressWriter{u}), io.LimitReader(body, maxBinaryBytes+1))
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", a.Name, err)
	}
	if n > maxBinaryBytes {
		return "", fmt.Errorf("%s is larger than %d bytes", a.Name, maxBinaryBytes)
	}
	return hex.EncodeToString(h.Sum(nil)), tmp.Sync()
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
// exe.previous. It returns the initial status; the restart happens in the
// background.
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
		u.set(StateInstalling, "Restoring the previous binary")
		return rollback(exe)
	}), nil
}

func (u *Updater) rollbackPreflight() (string, error) {
	exe, err := u.exePath()
	if err != nil {
		return "", fail(ErrUnavailable, "cannot locate the running binary: %v", err)
	}
	if err := checkWritable(filepath.Dir(exe)); err != nil {
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
