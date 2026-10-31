# Deploying sudoku-server in an LXC

One unprivileged LXC (Debian/Ubuntu), native systemd services, no Docker.
The Go server is a single static binary that serves the API and the web
client over plain HTTP; the existing Caddy terminates TLS in front of it.

| File                     | Installed as                                   |
| ------------------------ | ---------------------------------------------- |
| `sudoku-server.service`  | `/etc/systemd/system/sudoku-server.service`    |
| `sudoku-backup.service`  | `/etc/systemd/system/sudoku-backup.service`    |
| `sudoku-backup.timer`    | `/etc/systemd/system/sudoku-backup.timer`      |
| `sudoku-backup.sh`       | `/opt/sudoku/bin/sudoku-backup`                |
| `config.example.toml`    | `/etc/sudoku/config.toml`                      |
| `Caddyfile.snippet`      | merged into your Caddy config                  |

## 1. Build

On any machine with Go (or download the `sudoku-server` artifact from the
`server` GitHub Actions workflow):

```sh
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o sudoku-server ./cmd/sudoku-server
```

Use `GOARCH=arm64` for an ARM host. Build the web client (`cd web && npm ci &&
npm run build`) and copy `web/dist` (the directory containing `index.html`).

## 2. Install in the LXC

```sh
apt install sqlite3            # for backups and ad-hoc inspection
useradd --system --home /var/lib/sudoku --shell /usr/sbin/nologin sudoku

# /opt/sudoku is owned by the service user so the server can replace its own
# binary and web client (see "Updating from the web").
install -d -m 0755 -o sudoku -g sudoku /opt/sudoku
install -d -m 0755 -o sudoku -g sudoku /opt/sudoku/bin
install -m 0755 -o sudoku -g sudoku sudoku-server /opt/sudoku/bin/sudoku-server
install -m 0755 -o sudoku -g sudoku deploy/sudoku-backup.sh /opt/sudoku/bin/sudoku-backup

install -d -m 0755 -o sudoku -g sudoku /opt/sudoku/web
cp -r path/to/web-build/. /opt/sudoku/web/
chown -R sudoku:sudoku /opt/sudoku/web

install -d -m 0750 -o root -g sudoku /etc/sudoku
install -m 0640 -o root -g sudoku deploy/config.example.toml /etc/sudoku/config.toml
printf 'SUDOKU_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" > /etc/sudoku/env
chown root:sudoku /etc/sudoku/env && chmod 0640 /etc/sudoku/env

install -d -m 0750 -o sudoku -g sudoku /var/backups/sudoku
cp deploy/sudoku-server.service deploy/sudoku-backup.service deploy/sudoku-backup.timer /etc/systemd/system/
systemctl daemon-reload
```

Edit `/etc/sudoku/config.toml`: set the Authentik `issuer`, `client_id` and
`audience` (see below), and optionally the admin group.

**Back up `/etc/sudoku/env` somewhere safe.** The server secret determines
every week's puzzles; losing or changing it changes all of them.

```sh
systemctl enable --now sudoku-server sudoku-backup.timer
systemctl status sudoku-server
curl -s localhost:8080/healthz      # {"status":"ok"}
journalctl -u sudoku-server -f
```

## 3. Authentik

Create an OAuth2/OpenID provider and application (slug e.g. `sudoku`):

- Web client: public client, Authorization Code + PKCE, redirect URI on the
  sudoku host. Its client id goes in `client_id`.
- Scopes: `openid`, `profile`, `offline_access`. The server reads `name` /
  `preferred_username` from the **access token** for display names.
- Signing key: pick one so access tokens are signed JWTs (RS256 or ES256).
- `issuer` is `https://<authentik>/application/o/<slug>/`, trailing slash
  included; it must match the token's `iss` exactly.
- Token lifetimes (advanced protocol settings): Authentik rotates the
  refresh token on every refresh by default, so a refresh whose response is
  lost (app suspended mid-request) signs the user out. Set **Refresh Token
  threshold** (authentik 2025.10+) to e.g. `days=7` with **Refresh Token
  validity** `days=30`, so most refreshes keep the same refresh token, and
  keep **Access Token validity** around `hours=1` (not minutes) so refreshes
  are rare.

The server fetches `<issuer>.well-known/openid-configuration` and the JWKS
on the first authenticated request, so the LXC needs outbound HTTPS to
Authentik.

## 4. Admins (optional)

Self-update is available to admins only. Nobody is admin until you set
`[admin]` in `/etc/sudoku/config.toml` (or `SUDOKU_ADMIN_CLAIM` /
`SUDOKU_ADMIN_VALUES`): a caller is admin if the access-token claim named by
`claim` equals one of `values`. The claim can be a string or a list of
strings, and a dot-separated path reaches nested claims.

With Authentik, create a group (e.g. `sudoku-admins`), add yourself, and make
sure the `groups` claim is in the access token (the default `profile` scope
mapping adds it):

```toml
[admin]
claim = "groups"
values = ["sudoku-admins"]
```

`claim` and `values` must be set together. Restart the service after
changing them.

## 5. Caddy

Merge `Caddyfile.snippet` into the existing Caddy config and reload. If Caddy
runs in a different container, bind the server to the LXC's address
(`bind = "<lxc-ip>:8080"`) and allow only Caddy to reach that port.

## Backups

`sudoku-backup.timer` runs daily. It writes
`/var/backups/sudoku/sudoku-<UTC timestamp>.db` using SQLite's online backup
API (safe while the server runs), checks its integrity, and deletes backups
older than `KEEP_DAYS` (30). Run one now with
`systemctl start sudoku-backup && journalctl -u sudoku-backup`.

These copies live inside the LXC. Include `/var/backups/sudoku` and
`/etc/sudoku` in your host-level backups (e.g. Proxmox vzdump) or sync them
off the box.

Restore:

```sh
systemctl stop sudoku-server
install -m 0640 -o sudoku -g sudoku /var/backups/sudoku/sudoku-<stamp>.db /var/lib/sudoku/sudoku.db
rm -f /var/lib/sudoku/sudoku.db-wal /var/lib/sudoku/sudoku.db-shm
systemctl start sudoku-server
```

## Upgrading

```sh
install -m 0755 -o sudoku -g sudoku sudoku-server /opt/sudoku/bin/sudoku-server
rsync -a --delete --chown=sudoku:sudoku path/to/web-build/ /opt/sudoku/web/
systemctl restart sudoku-server
```

Database migrations run automatically at startup. Take a backup first
(`systemctl start sudoku-backup`).

## Updating from the web

An admin (see "Admins") can update the server from the **Admin** page, reached
from the About screen. It lists the GitHub releases, downloads the binary for
this host (`sudoku-server-<os>-<arch>`) and the web client (`sudoku-web.zip`),
verifies both against the release's `SHA256SUMS`, unpacks the web client next
to `/opt/sudoku/web`, replaces `/opt/sudoku/web` and
`/opt/sudoku/bin/sudoku-server`, and restarts the service. The server exits
with status 75 and systemd starts the new binary, which relies on
`Restart=on-failure` in the unit. Nothing is replaced until both downloads
are verified and unpacked, so a failed update changes nothing.

Requirements:

- `/opt/sudoku` and the directories below it owned by the `sudoku` user, and
  `/opt/sudoku` listed in `ReadWritePaths=` in the unit (both are in the
  instructions above). The web directory is swapped for a staged copy, so the
  service needs write access to its parent, not only to the directory itself.
  If either is missing the page reports that the directory is not writable
  and names it.
- Outbound HTTPS to `api.github.com` and GitHub's release storage.
- The release must have been published with `SHA256SUMS` and `sudoku-web.zip`
  assets. Older releases without the web bundle are listed as not installable.

The previous binary is kept as `/opt/sudoku/bin/sudoku-server.previous` and the
previous web client as `/opt/sudoku/web.previous`. The Admin page can roll back
to them: it restores both (or only the binary, if there is no
`web.previous`, for example after an update made by an older version). To roll
back by hand (for example if the new version does not start):

```sh
mv /opt/sudoku/bin/sudoku-server.previous /opt/sudoku/bin/sudoku-server
mv /opt/sudoku/web /opt/sudoku/web.rolledback
mv /opt/sudoku/web.previous /opt/sudoku/web
rm -rf /opt/sudoku/web.rolledback
systemctl restart sudoku-server
```

Only the web directory configured as `web_dir` is updated; with no `web_dir`
the update replaces the binary alone.

Moving from an older install (which could only update the binary): give the
service user ownership of the directories and widen `ReadWritePaths`, then
reload systemd:

```sh
chown sudoku:sudoku /opt/sudoku
chown -R sudoku:sudoku /opt/sudoku/web
cp deploy/sudoku-server.service /etc/systemd/system/    # ReadWritePaths=/opt/sudoku
systemctl daemon-reload
systemctl restart sudoku-server
```

If you edited the unit, change `ReadWritePaths=/opt/sudoku/bin` to
`ReadWritePaths=/opt/sudoku` by hand instead of copying it over.

## Troubleshooting

- `status=226/NAMESPACE` or "Failed to set up mount namespacing" at start:
  the LXC can't create the mount namespaces the hardening options use. On
  Proxmox enable `features: nesting=1` for the container, or comment out
  `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices` and
  `ProtectKernel*` in the unit.
- `401 unauthorized` for every request: compare the token's `iss` and `aud`
  with `oidc.issuer` and `oidc.audience`; the server logs the reason at info
  level (`journalctl -u sudoku-server`).
