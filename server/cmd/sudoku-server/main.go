// Command sudoku-server serves the daily sudoku API and web client.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jesserockz/sudoku/server/internal/api"
	"github.com/jesserockz/sudoku/server/internal/auth"
	"github.com/jesserockz/sudoku/server/internal/clock"
	"github.com/jesserockz/sudoku/server/internal/config"
	"github.com/jesserockz/sudoku/server/internal/store"
	"github.com/jesserockz/sudoku/server/internal/update"
	"github.com/jesserockz/sudoku/server/internal/version"
	"github.com/jesserockz/sudoku/server/internal/web"
)

// exitRestart is the exit status after an admin-requested restart
// (EX_TEMPFAIL). The systemd unit's Restart=on-failure starts the new binary.
const exitRestart = 75

// errRestartRequested is the cancel cause of a self-update restart, and what
// run returns once the server has shut down gracefully for it.
var errRestartRequested = errors.New("restart requested")

// exit is os.Exit, replaced in tests.
var exit = os.Exit

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if code := exitCode(run(ctx, os.Args[1:], os.Getenv, nil)); code != 0 {
		stop()
		exit(code)
	}
}

// exitCode maps run's result to the process exit status.
func exitCode(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, errRestartRequested):
		slog.Warn("exiting for restart", "status", exitRestart)
		return exitRestart
	}
	slog.Error("fatal", "err", err)
	return 1
}

// run serves until ctx is cancelled, then shuts down gracefully. onListen,
// if set, is called once the listener is up with its address and a function
// that requests a restart.
func run(parent context.Context, args []string, getenv func(string) string, onListen func(addr string, restart func())) error {
	flags := flag.NewFlagSet("sudoku-server", flag.ContinueOnError)
	configPath := flags.String("config", getenv("SUDOKU_CONFIG"), "path to TOML config file (env SUDOKU_CONFIG)")
	if err := flags.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(*configPath, getenv)
	if err != nil {
		return err
	}
	var verifier auth.Verifier
	if cfg.Auth.Mode == config.AuthModeDev {
		slog.Warn("!!! DEV AUTH MODE ENABLED: bearer tokens are NOT verified. Never use this in production. !!!")
		verifier = auth.Dev{}
	} else {
		verifier = &auth.OIDC{Issuer: cfg.OIDC.Issuer, Audience: cfg.OIDC.Audience}
	}

	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	restart := func() { cancel(errRestartRequested) }

	st, err := store.Open(ctx, cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	var webHandler http.Handler
	if cfg.WebDir != "" {
		if webHandler, err = web.Handler(cfg.WebDir); err != nil {
			return err
		}
	} else {
		slog.Info("web_dir not set; not serving the web client")
	}

	apiServer := api.New(api.Deps{Config: cfg, Clock: clock.System{}, Store: st, Verifier: verifier, Web: webHandler,
		Updater: &update.Updater{WebDir: cfg.WebDir, Restart: restart},
	})
	effective, err := apiServer.SyncLevels(ctx)
	if err != nil {
		return err
	}
	slog.Info("levels", "configured", cfg.Levels, "effectiveFrom", effective)

	srv := &http.Server{
		Addr:              cfg.Bind,
		Handler:           apiServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	ln, err := net.Listen("tcp", cfg.Bind)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	slog.Info("listening", "addr", ln.Addr().String(), "authMode", cfg.Auth.Mode, "version", version.Version)

	if onListen != nil {
		onListen(ln.Addr().String(), restart)
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	if errors.Is(context.Cause(ctx), errRestartRequested) {
		slog.Warn("shut down for a requested restart (self-update)")
		return errRestartRequested
	}
	return nil
}
