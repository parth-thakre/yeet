# Run Yeet

Run one Yeet server on an always-on machine or VPS. It stores the workspace's
files and identities. Phones, laptops, and agents connect to its HTTPS URL.
Only the server needs Docker or Podman with a Compose provider. CLI machines need
Node 22+ and the Yeet checkout.

Examples below run from `deploy/` and use Bash unless stated otherwise.
For Podman, replace `docker compose` with `podman compose` throughout this guide.
Install a Compose provider first. If Podman uses the Docker-compatible Compose
provider, start its API socket with `systemctl --user start podman.socket` on a
systemd host. A missing `podman.sock` means that socket is not running.

## First run

Create `deploy/.env` using [.env.example](.env.example) as a guide. Do not overwrite
an existing configuration. Use your final HTTPS origin:

```dotenv
YEET_ORIGIN=https://yeet.example.com
YEET_INSECURE_COOKIE=0
YEET_TRUST_PROXY=0
```

For a trial on this machine only, use `http://localhost:3000` and
`YEET_INSECURE_COOKIE=1`. Never use insecure cookies over a public network.

Prepare the persistent data directory. On Linux:

```sh
mkdir -p data
sudo chown 1000:1000 data
chmod 700 data
```

On Docker Desktop, create `deploy/data` and allow Docker access to it.
For rootless Podman on Linux, use this instead of the Linux commands above:

```sh
mkdir -p data
podman unshare chown 1000:1000 data
podman unshare chmod 700 data
```

Do not use host `sudo chown 1000:1000` for rootless Podman. The container's UID
1000 maps to a different host UID. Compose mounts `./data` with `:Z` for a private
SELinux label; without it, enforcing hosts report `EACCES` even with correct
ownership. Keep this data directory exclusive to this Yeet service.

Then start the server:

```sh
docker compose up -d --build --wait
docker compose logs yeet
```

If your Compose provider does not support `--wait`, omit it and wait for
`curl --fail http://localhost:3000/healthz` to succeed before opening the setup link.

The log contains **Set up your admin account** followed by a private link. Open
that link, choose an admin username and password of at least 12 characters, and
you're signed in. No email service, phone approval, or admin token is required.

The setup link survives restarts until it is used. It cannot create a second admin.
It is a credential: don't share startup logs while setup is pending. The setup
secret is stored with restricted permissions in `data/setup.json`, then removed
after setup. All data and backups must remain private.

`http://localhost:3000/healthz` returns `{"ok":true}`.
The host port is loopback-only. Configure a tunnel or reverse proxy below before
opening links on another device. Use the same origin consistently in the server
configuration, browser, and CLI; account forms refuse mismatched origins.

## Invite people and connect terminals

In the website, open **People**, enter a username, and send the invite privately.
They open it, choose a password, and can sign in on any browser from then on.
Opening the invite alone does not consume it; submitting a password does.
For a second-account trial, use a signed-out browser or a separate browser
profile. An invite cannot silently replace an account already signed in there.

On each machine that publishes, run `npm link` from the checkout once, then:

```sh
yeet login https://yeet.example.com
```

The browser opens. Sign in if asked, verify the device name and code, and click
**Connect this terminal**. Both the server URL and a per-terminal token are saved
in `~/.yeet/config.json`. Protect this file. It is not encrypted at rest.
For a remote/headless machine add `--no-browser` and open the printed URL elsewhere.
An agent under the same OS account can use that CLI connection without another login.

`yeet throw ./result` now publishes to the saved server.
The website's **Connect terminal** page has the exact command for your instance.

**Terminals** lists CLI connections, not browser sessions. Revoke a terminal there
or with `yeet devices revoke <id>`. **Account** changes your password and signs out
other browsers and all terminals. `yeet remove <name>` revokes a member everywhere.

## Existing installations and automation

Existing `members.json`, sessions, device tokens, and artifact ownership stay intact.
An old `YEET_ADMIN_TOKEN` remains supported on first start; it is optional for new
installs and ignored once members.json exists. Changing it is not a password reset.

Token-only users open `/login/token`, sign in using their existing token, then set
a password in **Account**. This first password setup keeps existing connections.
Normal password changes and invite-based resets revoke existing connections.

For CI, keep using `YEET_ORIGIN` and `YEET_TOKEN` through your secret store, or pipe
a device token into `yeet login --origin <url> --token-stdin`. Environment values
override saved CLI configuration. Use member tokens for publishing, not admin tokens.
The admin API `POST /api/members/<name>/tokens` still mints named CI credentials.

## Password recovery

Members ask the admin for a reset link from **People**. A reset link grants account
access, so send it privately. It expires in 7 days. Redeeming it invalidates that
account's previous sessions, tokens, and outstanding invites.

If the only admin is locked out, the server owner can generate a reset link offline.
Stop the service first so two processes never write its identity files at once:

```sh
docker compose stop yeet
docker compose run --rm --no-deps yeet node server/recover.mjs --server-stopped
docker compose start yeet
```

Open the printed link in a signed-out browser after restarting. For a non-Docker
installation, stop the Node process and run the same recovery command with the
original `YEET_DATA` and `YEET_ORIGIN`. The flag acknowledges that you stopped it;
the command cannot detect another running process. Do not delete members.json.

## Expose the service

Set `YEET_ORIGIN` to the origin people will open, then run `docker compose up -d` after changing `.env`.
Outside Docker the server listens on `127.0.0.1` only. Put the proxy on the same machine, or set `YEET_HOST`
(for example `0.0.0.0`) when it runs elsewhere. The container image already sets `YEET_HOST=0.0.0.0`, and
Compose publishes it on the host's loopback.
Terminate TLS at the tunnel or proxy. Do not disable Yeet authentication or log login URL query strings.
All visibility checks still apply over the public network.

### Cloudflare Tunnel

This is the recommended way to make `public` links work from anywhere without opening a port.
The connector runs as the `cloudflared` service in `compose.yaml` (profile `cloudflare`) and reads
`deploy/cloudflared/config.yml` plus a tunnel credentials JSON from the same folder.

**With a cloudflared login** (`cloudflared tunnel login` on any machine, once):

```sh
cloudflared tunnel create yeet                    # writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns yeet yeet.example.com
```

Copy `<id>.json` into `deploy/cloudflared/` on the server and write `deploy/cloudflared/config.yml`:

```yaml
tunnel: <id>
credentials-file: /etc/cloudflared/<id>.json
ingress:
  - hostname: yeet.example.com
    service: http://yeet:3000
  - service: http_status:404
```

**With an API token** that has Account > Cloudflare Tunnel > Edit and Zone > DNS > Edit, `cloudflare-tunnel.sh`
does all of the above for you, including the DNS record.

With that token supplied through `CF_API_TOKEN` or `CF_API_TOKEN_FILE`, run from `deploy/`:

```sh
HOSTNAME=yeet.example.com bash cloudflare-tunnel.sh
```

Then set `YEET_ORIGIN=https://yeet.example.com` and `CLOUDFLARED_UID=$(id -u)` in `.env` (the connector runs as
that uid so it can read the 600-mode credentials file), and start everything with:

```sh
docker compose --profile cloudflare up -d --build
```

Use the same command for upgrades so the connector comes along. The credentials JSON is a long-lived secret;
it is gitignored and should be treated like the admin token.

Notes when fronted by Cloudflare:

- Cloudflare's proxy caps a single request body at 100 MB on the free plan. Yeet uploads one file per request, so a single media file above that size will fail to publish through the tunnel even though Yeet itself allows 200 MiB.
- Non-public artifacts are served with `Cache-Control: private`, so Cloudflare never caches them. Public files may be cached at the edge for up to 60 seconds after a new version.
- Set `YEET_TRUST_PROXY=1` to use `CF-Connecting-IP` for per-client login limits behind the tunnel. Otherwise clients share the connector's socket-IP limit. Never enable this when untrusted clients can reach Yeet directly; they could forge forwarding headers. Caddy must overwrite forwarding headers, not pass arbitrary client values through.

### Tailscale

`tailscale serve --bg http://localhost:3000` exposes Yeet only to your tailnet over HTTPS.
Use `tailscale funnel --bg http://localhost:3000` instead when public links must work outside the tailnet; Funnel must be enabled for the node.
Set `YEET_ORIGIN` to the HTTPS URL the command reports. Serve alone cannot satisfy off-tailnet public sharing.

### Caddy

Point your domain at the host and allow inbound ports 80 and 443. Run Caddy on the host with:

```caddyfile
yeet.example {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains the TLS certificate. If you run Caddy in a container, join the Compose network and proxy to `yeet:3000` instead of its own loopback address.

## Backup and restore

Stop writes before copying the entire `deploy/data` directory, including `members.json`, `sessions.json`, and all artifact versions.
From `deploy/`:

```sh
docker compose stop yeet
sudo cp -a ./data ./data-backup-$(date +%Y%m%d-%H%M%S)
docker compose start yeet
```

Use a new backup path each time and move a protected copy off the host.
With rootless Podman, run the copy inside its user namespace so it can read
private files and preserve their container ownership:

```sh
podman compose stop yeet
podman unshare cp -a ./data ./data-backup-$(date +%Y%m%d-%H%M%S)
podman compose start yeet
```

To restore, stop Yeet, preserve the existing data elsewhere, then copy the backup
to `deploy/data`. Do not copy onto an existing `data` directory: that can nest the
backup inside it or mix old and restored state. For example, after choosing an
existing backup and a new preservation path:

```sh
docker compose stop yeet
sudo mv ./data ./data-before-restore
sudo cp -a ./data-backup-YYYYMMDD-HHMMSS ./data
sudo chown -R 1000:1000 ./data
docker compose up -d --wait
```

For rootless Podman, use `podman compose` for stop/start and `podman unshare` before
`mv`, `cp -a`, and `chown -R` instead of `sudo`. `up -d` applies the SELinux mount
label to the restored directory. On Docker Desktop, preserve permissions with
`cp -a`, omit `sudo`, and omit the Linux `chown`. For a plain Node deployment, stop `npm start`
and use the actual `YEET_DATA` path instead of `deploy/data`; keep ownership with
the OS account running Node.

After restarting, sign in as both accounts, open the pages, and check an older
version with `?v=1`. A restored terminal credential should still pass `yeet whoami`.
Backups contain password hashes and session credentials. Protect them like the
live data directory.
Do not delete `members.json` to reset a token; that changes who can bootstrap as admin.

## Upgrade and logs

Back up first. Pull the latest source into your checkout, or replace your source files from the next release.
This service builds locally rather than pulling a published Yeet image.
From `deploy/`, rebuild with the current Node base image and restart:

```sh
docker compose build --pull
docker compose up -d
docker compose logs -f --tail=100 yeet
```

If you enabled the optional connector, update it with `docker compose pull cloudflared` before `docker compose up -d`.
Logs go to container stdout and stderr. Use `docker compose ps` for health and `docker compose logs yeet` for startup or request errors.
Do not put access tokens or credential-bearing login URLs in logs or bug reports.
