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
	"github.com/jesserockz/sudoku/server/internal/web"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	configPath := flag.String("config", os.Getenv("SUDOKU_CONFIG"), "path to TOML config file (env SUDOKU_CONFIG)")
	flag.Parse()

	cfg, err := config.Load(*configPath, os.Getenv)
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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

	apiServer := api.New(api.Deps{Config: cfg, Clock: clock.System{}, Store: st, Verifier: verifier, Web: webHandler})
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
	slog.Info("listening", "addr", ln.Addr().String(), "authMode", cfg.Auth.Mode)

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
