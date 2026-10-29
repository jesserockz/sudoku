# Deploying sudoku-server in an LXC

One unprivileged LXC (Debian/Ubuntu), native systemd services, no Docker.
The Go server is a single static binary that serves the API and the web
client over plain HTTP; the existing Caddy terminates TLS in front of it.

| File                     | Installed as                                   |
| ------------------------ | ---------------------------------------------- |
| `sudoku-server.service`  | `/etc/systemd/system/sudoku-server.service`    |
| `sudoku-backup.service`  | `/etc/systemd/system/sudoku-backup.service`    |
| `sudoku-backup.timer`    | `/etc/systemd/system/sudoku-backup.timer`      |
| `sudoku-backup.sh`       | `/usr/local/bin/sudoku-backup`                 |
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

install -m 0755 sudoku-server /usr/local/bin/sudoku-server
install -m 0755 deploy/sudoku-backup.sh /usr/local/bin/sudoku-backup

install -d -m 0755 /opt/sudoku/web
cp -r path/to/web-build/. /opt/sudoku/web/

install -d -m 0750 -o root -g sudoku /etc/sudoku
install -m 0640 -o root -g sudoku deploy/config.example.toml /etc/sudoku/config.toml
printf 'SUDOKU_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" > /etc/sudoku/env
chown root:sudoku /etc/sudoku/env && chmod 0640 /etc/sudoku/env

install -d -m 0750 -o sudoku -g sudoku /var/backups/sudoku
cp deploy/sudoku-server.service deploy/sudoku-backup.service deploy/sudoku-backup.timer /etc/systemd/system/
systemctl daemon-reload
```

Edit `/etc/sudoku/config.toml`: set the Authentik `issuer`, `client_id` and
`audience` (see below).

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

The server fetches `<issuer>.well-known/openid-configuration` and the JWKS
on the first authenticated request, so the LXC needs outbound HTTPS to
Authentik.

## 4. Caddy

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
install -m 0755 sudoku-server /usr/local/bin/sudoku-server
rsync -a --delete path/to/web-build/ /opt/sudoku/web/
systemctl restart sudoku-server
```

Database migrations run automatically at startup. Take a backup first
(`systemctl start sudoku-backup`).

## Troubleshooting

- `status=226/NAMESPACE` or "Failed to set up mount namespacing" at start:
  the LXC can't create the mount namespaces the hardening options use. On
  Proxmox enable `features: nesting=1` for the container, or comment out
  `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices` and
  `ProtectKernel*` in the unit.
- `401 unauthorized` for every request: compare the token's `iss` and `aud`
  with `oidc.issuer` and `oidc.audience`; the server logs the reason at info
  level (`journalctl -u sudoku-server`).
