// Package version holds the server's version.
package version

// Version is the server's release version. The release workflow bumps it;
// a build can override it with
// -ldflags "-X github.com/jesserockz/sudoku/server/internal/version.Version=...".
var Version = "0.2.0"
