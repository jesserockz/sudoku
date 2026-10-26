// Package web serves the compiled web client from a directory, falling back
// to index.html for unknown paths so client-side routing works.
package web

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

// Handler serves files under dir. Paths are resolved inside an os.Root, so
// nothing outside dir is reachable.
func Handler(dir string) (http.Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("web dir: %w", err)
	}
	fsys := root.FS()
	if _, err := fs.Stat(fsys, "index.html"); err != nil {
		return nil, fmt.Errorf("web dir %s: index.html: %w", dir, err)
	}
	files := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || name == "index.html" || !servable(fsys, name) {
			serveIndex(w, r, fsys)
			return
		}
		files.ServeHTTP(w, r)
	}), nil
}

// servable reports whether name is a file, or a directory with an
// index.html (so the file server never renders a directory listing).
func servable(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	if err != nil {
		return false
	}
	if info.IsDir() {
		_, err := fs.Stat(fsys, path.Join(name, "index.html"))
		return err == nil
	}
	return true
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	f, err := fsys.Open("index.html")
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, fs.ErrNotExist) {
			status = http.StatusNotFound
		}
		http.Error(w, http.StatusText(status), status)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	rs, ok := f.(io.ReadSeeker)
	if err != nil || !ok {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	// The shell must be revalidated so a deploy picks up new asset names.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "index.html", info.ModTime(), rs)
}
