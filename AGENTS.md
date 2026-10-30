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
| `.github/workflows/` | `web.yml`, `server.yml`, `release.yml` (draft release + builds), `pages.yml` (deploys a published release to GitHub Pages), `lockfile.yml` (verifies `actions.lock`) |

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
make test-arm64   # tests as arm64 binaries on x86; needs qemu-aarch64-static
```

CI runs these as a matrix on native amd64 and arm64 runners
(`ubuntu-24.04`, `ubuntu-24.04-arm`), each building and smoke-testing its own
binary; `make test-arm64` is the local way to test arm64 on x86.

## Conventions

### GitHub Actions pinning

- Actions are locked with [`gh actions-lock`](https://github.com/github/gh-actions-lock)
  (`gh extension install github/gh-actions-lock`). Commit SHAs live in
  `.github/workflows/actions.lock`, which satisfies the repository's
  "require actions to be pinned to a full-length commit SHA" setting.
- In workflows, reference each action by its full release tag, not a SHA
  and not a partial tag like `v7`:

  ```yaml
  - uses: actions/checkout@v7.0.1
  ```

- After adding a workflow or changing any `uses:`, run `gh actions-lock` and
  commit the workflow and `actions.lock` together. Never edit `actions.lock`
  by hand. A workflow missing from the lockfile is blocked by the SHA
  pinning setting. `lockfile.yml` runs `gh actions-lock --verify` in CI;
  `gh actions-lock --verify-local` is a quick offline check.
- Calls to reusable workflows in other repositories are not locked; pin
  those to a full commit SHA.
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
