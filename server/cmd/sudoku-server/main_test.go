package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}

// testEnv is a dev-mode configuration on an ephemeral port.
func testEnv(t *testing.T) func(string) string {
	t.Helper()
	env := map[string]string{
		"SUDOKU_AUTH_MODE":     "dev",
		"SUDOKU_SERVER_SECRET": "test-secret-0123456789",
		"SUDOKU_BIND":          "127.0.0.1:0",
		"SUDOKU_DB_PATH":       filepath.Join(t.TempDir(), "test.db"),
	}
	return func(k string) string { return env[k] }
}

type runResult struct {
	addr    string
	restart func()
	done    chan error
}

// start runs the server and waits until it listens.
func start(t *testing.T, ctx context.Context, args []string, getenv func(string) string) runResult {
	t.Helper()
	ready := make(chan runResult, 1)
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, args, getenv, func(addr string, restart func()) {
			ready <- runResult{addr: addr, restart: restart}
		})
	}()
	select {
	case r := <-ready:
		r.done = done
		return r
	case err := <-done:
		t.Fatalf("run returned before listening: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start")
	}
	return runResult{}
}

func wait(t *testing.T, done chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(15 * time.Second):
		t.Fatal("run did not return")
	}
	return nil
}

func TestRunServesAndStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := start(t, ctx, nil, testEnv(t))
	resp, err := http.Get("http://" + r.addr + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %v %v", resp, err)
	}
	resp.Body.Close()
	cancel()
	if err := wait(t, r.done); err != nil {
		t.Errorf("run = %v, want nil", err)
	}
}

func TestRunRestartRequested(t *testing.T) {
	r := start(t, context.Background(), nil, testEnv(t))
	r.restart()
	err := wait(t, r.done)
	if !errors.Is(err, errRestartRequested) {
		t.Fatalf("run = %v, want errRestartRequested", err)
	}
	if code := exitCode(err); code != 75 {
		t.Errorf("exit code = %d, want 75", code)
	}
}

func TestRunWiresUpdaterToAdminRoutes(t *testing.T) {
	env := testEnv(t)
	base := env
	env = func(k string) string {
		switch k {
		case "SUDOKU_ADMIN_CLAIM":
			return "sub"
		case "SUDOKU_ADMIN_VALUES":
			return "ann"
		}
		return base(k)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := start(t, ctx, nil, env)
	req, _ := http.NewRequest("GET", "http://"+r.addr+"/api/v1/admin/update", nil)
	req.Header.Set("Authorization", "Bearer dev:ann:Ann")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("admin status = %d, want 200 (updater wired)", resp.StatusCode)
	}
	cancel()
	wait(t, r.done)
}

func TestRunErrors(t *testing.T) {
	if err := run(context.Background(), []string{"-bogus"}, testEnv(t), nil); err == nil {
		t.Error("bad flag accepted")
	}
	if err := run(context.Background(), []string{"-config", "/nonexistent/config.toml"}, testEnv(t), nil); err == nil {
		t.Error("missing config accepted")
	}

	t.Run("oidc mode", func(t *testing.T) {
		env := testEnv(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		oidcEnv := func(k string) string {
			switch k {
			case "SUDOKU_AUTH_MODE":
				return "oidc"
			case "SUDOKU_OIDC_ISSUER":
				return "https://auth.invalid/"
			case "SUDOKU_OIDC_CLIENT_ID":
				return "c"
			}
			return env(k)
		}
		r := start(t, ctx, nil, oidcEnv)
		cancel()
		wait(t, r.done)
	})

	t.Run("web dir", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644)
		env := testEnv(t)
		withWeb := func(k string) string {
			if k == "SUDOKU_WEB_DIR" {
				return dir
			}
			return env(k)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		r := start(t, ctx, nil, withWeb)
		cancel()
		wait(t, r.done)

		bad := func(k string) string {
			if k == "SUDOKU_WEB_DIR" {
				return filepath.Join(dir, "missing")
			}
			return env(k)
		}
		if err := run(context.Background(), nil, bad, nil); err == nil {
			t.Error("missing web dir accepted")
		}
	})

	t.Run("bad store path", func(t *testing.T) {
		env := testEnv(t)
		bad := func(k string) string {
			if k == "SUDOKU_DB_PATH" {
				return "/nonexistent/dir/x.db"
			}
			return env(k)
		}
		if err := run(context.Background(), nil, bad, nil); err == nil {
			t.Error("bad db path accepted")
		}
	})

	t.Run("address in use", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		first := start(t, ctx, nil, testEnv(t))
		env := testEnv(t)
		clash := func(k string) string {
			if k == "SUDOKU_BIND" {
				return first.addr
			}
			return env(k)
		}
		if err := run(context.Background(), nil, clash, nil); err == nil {
			t.Error("port clash accepted")
		}
		cancel()
		wait(t, first.done)
	})
}

func TestExitCode(t *testing.T) {
	if exitCode(nil) != 0 {
		t.Error("nil should exit 0")
	}
	if exitCode(errors.New("boom")) != 1 {
		t.Error("errors should exit 1")
	}
	if exitCode(errRestartRequested) != exitRestart || exitRestart != 75 {
		t.Error("restart should exit 75")
	}
}

func TestMainExitsWithRunStatus(t *testing.T) {
	oldArgs, oldExit := os.Args, exit
	defer func() { os.Args, exit = oldArgs, oldExit }()
	got := -1
	exit = func(code int) { got = code }

	os.Args = []string{"sudoku-server", "-config", "/nonexistent/config.toml"}
	main()
	if got != 1 {
		t.Errorf("exit status = %d, want 1", got)
	}
}
