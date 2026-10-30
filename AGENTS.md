# AGENTS.md

Notes for coding agents working in this repository.

## Layout

| Path                 | What it is                                                     |
| -------------------- | -------------------------------------------------------------- |
| `web/`               | TypeScript PWA (no framework), built with npm                  |
| `server/`            | Go backend: single static binary with SQLite                   |
| `deploy/`            | systemd units, backup timer, example config, Caddy snippet     |
| `docs/API.md`        | API contract                                                   |
| `docs/WEB.md`        | Web client docs                                                |
| `.github/workflows/` | `web.yml`, `server.yml`, `release.yml` (draft release + builds), `pages.yml` (deploys a published release to GitHub Pages) |

## Checks CI runs

Run these locally before pushing.

`web/` (Node 26 in CI, see `web.yml`):

```sh
npm ci
npm run check   # type-check
npm test        # unit tests
npm run build
```

`server/` (Go version from `go.mod`, see `server.yml`):

```sh
gofmt -l .        # must print nothing
go vet ./...
go test -race ./...
make dist         # static linux/amd64 and linux/arm64 builds
make test-arm64   # tests as arm64 binaries; needs qemu-aarch64-static
```

CI also smoke-tests the arm64 binary under QEMU.

## Conventions

### GitHub Actions pinning

- Pin every action to the full commit SHA of its latest release, with the
  version in a trailing comment: two spaces before `#`, lowercase `v`
  matching the tag.

  ```yaml
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
  ```

- For annotated tags, use the peeled commit (`refs/tags/<tag>^{}`), not the
  tag object SHA, e.g. `git ls-remote https://github.com/<owner>/<repo>
  'refs/tags/<tag>^{}'`.
- When updating actions, move to the latest release and check that the inputs
  in use are still valid for any new major version.

### No AI attribution

- No "Generated with/by Claude Code" (or similar) footers in PR descriptions,
  issues or comments.
- No `Co-Authored-By` or `Claude-Session` trailers in commit messages.
- Some tooling appends such a footer to PR bodies automatically: after
  creating a PR, check its description and remove any footer that was added.

### Pull requests

- Do not open a pull request unless explicitly asked to.
