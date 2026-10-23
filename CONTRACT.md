# Yeet build contract

Read SCOPE.md first. This file fixes the interfaces so server, CLI, skill, and
deployment can be built independently and fit together. Do not change these
interfaces without updating this file.

## Repo layout

```
YEET/
  package.json          name "yeet", type module, node >=22, bin yeet -> cli/yeet.mjs
                        scripts: start (node server/server.mjs), test (node --test test/)
  server/
    server.mjs          entrypoint; reads env, starts http server
    *.mjs               any modules the server needs
    public/
      yeet-v1.css       optional stylesheet agents may link (owned by skill author)
  cli/
    yeet.mjs            entrypoint with #!/usr/bin/env node
    *.mjs               any modules the CLI needs
  skills/yeet/SKILL.md  agent skill
  deploy/
    Dockerfile
    compose.yaml
    README.md           deployment, tunnel, backup, upgrade
  test/
    *.test.mjs          node:test files; must pass with `npm test`
  README.md
```

Zero runtime npm dependencies. Node built-ins only (node:http, node:fs, node:crypto,
node:path, node:stream, etc.). Dev dependencies are also disallowed; tests use node:test.

## Environment (server)

- `YEET_DATA` data directory, default `./data`
- `YEET_PORT` default 3000
- `YEET_HOST` bind address, default `127.0.0.1`. The container image sets `0.0.0.0`.
- `YEET_ORIGIN` public origin, e.g. `https://yeet.example`, used to print links
- `YEET_ADMIN_TOKEN` bootstrap admin token; on first start, if `data/members.json`
  does not exist and this is set, create the legacy admin member "admin" with this token.
  Optional and ignored afterwards. Without it, create pending setup state and print
  a private `/setup?code=` link. First successful setup creates the admin account.
- `YEET_INSECURE_COOKIE=1` drop the Secure cookie flag for local http dev.
- `YEET_TRUST_PROXY=1` trust CF-Connecting-IP / X-Forwarded-For for login limits.
  Default off. Enable only behind a trusted proxy with no direct ingress.

## Storage layout (server owns this)

```
data/
  members.json          { "members": [ { "name", "tokenHash", "role": "admin"|"member",
                                          "createdAt", "revokedAt": null|iso } ] }
  sessions.json         { "sessions": [ { "id", "cookieHash", "member", "createdAt",
                                           "expiresAt" } ] }
  artifacts/<id>/
    meta.json           { "id", "owner", "visibility", "createdAt", "updatedAt",
                          "latest": n, "name": string|null, "project": string|null,
                          "sourceKey": string|null }
    v1/                 files exactly as uploaded, relative paths preserved
    v1/.yeet.json       { "entry": "index.html", "createdAt": iso }  never served
    v2/
```

- `sourceKey` is a hash the CLI computes from machine + absolute local path so that
  rethrowing the same path finds the same artifact.
- Token and cookie secrets are stored as SHA-256 hex digests only.
- Writes to json files are atomic (write temp, rename).
- Artifact ids are 12 chars from a URL-safe alphabet generated with crypto.randomBytes.
  Never sequential.

## Identity

- A member is a person. A member has any number of device tokens, one per machine or
  agent, each named after the device. Tokens are what the CLI and agents send as
  `Authorization: Bearer <token>`. Browsers use a session cookie `yeet_session`.
  Both resolve to a member on every request; a revoked member or token fails immediately.
- Cookie: HttpOnly, Secure (unless YEET_INSECURE_COOKIE=1), SameSite=Lax, Path=/,
  90 days. Value is a random 32-byte secret; its hash is stored in sessions.json.
- People use username/password sign-in on any browser. An invite (`/join?code=...`,
  7-day expiry) lets its recipient choose a password. GET never consumes it; POST
  consumes it once and creates a browser session. The admin can create links in
  People or with `yeet add <name>` / `yeet invite <name>`.
- Passwords use scrypt N=32768, r=8, p=1 with a random 16-byte salt and 32-byte key.
  Accept 12-256 characters when setting a password. Bound hashing concurrency to 4.
  Password operations are limited to 20 attempts per client per 15 minutes.
- Members may have `passwordHash` and `authVersion`. Sessions store the member's
  authVersion at creation; mismatches are rejected. Password changes and invite
  resets increment it and revoke all device tokens. Legacy accounts setting their
  first password keep existing connections. Stored raw passwords are forbidden.
- Device-code login: `yeet login [server-url]` asks for a code, prints an approval
  URL and short user code, opens the browser unless `--no-browser`, and polls.
  The approval URL is constructed locally on the configured origin, not trusted
  from the API's verifyUrl field. A browser can sign in first, then resume approval.
  On approval the server mints a device token for the approving member and the next
  poll returns it with a 60-second retry window. Requests live 10 minutes, in memory only.
- Browser sign-in links: a connected terminal signs browsers on its machine in, so a
  machine needs one `yeet login` instead of a password in every browser.
  `POST /api/browser-links` accepts only a Bearer device token, never a cookie, and
  returns a 32-byte code valid once for 2 minutes, in memory only (at most 20 pending
  per token). `yeet open` builds `<origin>/login/link?code=<code>` locally and launches
  the browser at it. A GET with `Sec-Fetch-Site: none` and `Sec-Fetch-Mode: navigate`
  (a browser opened from the OS or address bar) consumes the code and sets the session.
  Any other GET (link previews, prefetchers, cross-site links) only shows a confirmation
  button that POSTs with the same origin guard as the account forms. A browser already
  signed in as a different member always gets that confirmation, naming both accounts.
  Redemption runs under the auth lock, and the session records the token's id; every
  request rejects a session whose token is revoked, so revoking that terminal signs
  these browsers out even if a revocation races a redemption. `next` is stored
  server-side and sanitized like `/login?next=`.
- The admin can also mint a device token directly for a member
  (`POST /api/members/<name>/tokens`) for agents and CI with no phone nearby.
- `GET /login` renders username/password sign-in. `POST /login` accepts name,
  password, and a safe local next path. `/login/token` retains advanced token sign-in.
  Legacy `/login?token=<t>&next=<path>` is supported but not advertised; tokens in
  URLs can leak via browser history. `GET /logout` deletes the current session.
- If a browser hits a private or workspace artifact without a valid cookie, respond
  302 to `/login?next=<original path>`. API clients (Accept: application/json or an
  Authorization header) get 401.
- Storage: `members.json` holds `members`, `tokens` ({id, member, device, tokenHash,
  createdAt, revokedAt}) and `invites` ({codeHash, member, createdAt,
  expiresAt, usedAt}). A v1 file with `tokenHash` on members is migrated on start.

## Visibility rules

- `private`: only the owner member.
- `workspace`: any non-revoked member.
- `public`: anyone. No listing anywhere.
- Unauthorized access to an existing artifact returns 404, never 403, so existence
  is not confirmed. Browsers with no session get the 302 to /login instead; after
  login, a disallowed artifact is 404.

## HTTP API (server)

All JSON responses have `Content-Type: application/json`. Errors are
`{ "error": "message" }` with an appropriate status.

A request authenticated by the session cookie (no Authorization header) that changes
state (any method but GET and HEAD) gets 403 when `Sec-Fetch-Site` is present and is not
`same-origin` or `none`, or when `Origin` is present and is not `YEET_ORIGIN`. Bearer
clients are unaffected.

```
GET  /healthz                              200 {"ok":true}
GET  /api/me                               200 {"name","role"}   (auth required)

POST /api/artifacts                        create artifact
     body {"visibility"?: "private"|"workspace"|"public", "name"?: string, "project"?: string|null,
           "sourceKey"?: string}
     project is trimmed; empty becomes null; at most 80 characters, no control characters.
     -> 201 {"id","url","visibility","latest":0}
     url = `${YEET_ORIGIN}/a/${id}`

GET  /api/artifacts[?sourceKey=<key>]      caller's own artifacts, optionally by sourceKey
     -> 200 {"artifacts":[{"id","url","visibility","latest","name","project","updatedAt"}]}

GET  /api/artifacts/<id>                   200 {"id","url","owner","visibility","latest","name","project",
                                               "createdAt","updatedAt",
                                               "versions":[{"n","createdAt","entry",
                                                            "files":[{"path","bytes"}]}],
                                               "pending"?: n|null}
                                           subject to visibility rules; pending (the number of the
                                           uncommitted version, if any) is included for the owner only

POST /api/artifacts/<id>/versions          begin a new version (owner only)
     body {"entry": "index.html" | "<relpath>"}   must end .html or .htm
     -> 201 {"n": <pending version number>}
     Pending version lives at v<n>.pending/ until committed. One at a time: 409 while
     another is pending, unless that one has had no upload for 30 minutes, in which case
     it is removed and the new version takes the next number after it.

PUT  /api/artifacts/<id>/versions/<n>/files/<path...>
     raw body = file bytes. Path is URL-encoded, relative, no "..", no leading
     slash, no segment starting with ".". Max 500 files per version, max 200 MiB
     per file. -> 201 {"path","bytes"}

POST /api/artifacts/<id>/versions/<n>/commit
     -> 200 {"id","url","n","latest":n}   renames v<n>.pending -> v<n>, updates meta.
     400 if the entry file was not uploaded.

DELETE /api/artifacts/<id>/versions/<n>   abandon a pending version (owner only) -> 204

PATCH /api/artifacts/<id>                 body {"visibility"?, "name"?, "project"?, "expectedProject"?}
     (owner only) -> 200 same shape as GET. A project-only change keeps updatedAt.
     With expectedProject (string or null), 409 unless the page's current project equals it,
     checked under the artifact's lock; nothing changes on 409.

GET  /api/projects/<name>                  -> 200 {"name","description","updatedBy","updatedAt"}
                                           description etc. are null when undescribed (auth required)
     <name> is one URL-encoded path segment, decoded once ("API%2FUI" is the project "API/UI").
     A description is visible to its author, and to other members only once the author has a
     workspace or public page in that project. The workspace page applies the same rule.
PUT  /api/projects/<name>                  body {"description": string|null}  any member
     Whitespace collapses; at most 280 characters; empty or null clears it.
     Stored in data/projects.json as { "<name>": {"description","updatedBy","updatedAt"} }.

GET  /api/artifacts/<id>/versions/<n>/files.tar   (auth per visibility)
     Streams a POSIX ustar tar of v<n>/ without .yeet.json, no gzip. Used by yeet call.

# device-code login (no auth; the poll code is itself a secret)
POST /api/device       body {"device"}      201 {"code","userCode","verifyUrl","expiresIn","interval"}
GET  /api/device/<code>                     200 {"status":"pending"} | {"status":"approved","token","member","device"} (once) | {"status":"denied"}
                                            404 when unknown or expired

# browser sign-in links (Bearer device token only)
POST /api/browser-links body {"next"}      201 {"code","member","device","expiresIn"}   code works once, 120 s
                                            401 without a valid device token, 429 when too many are pending

# device tokens (auth)
GET    /api/tokens                          200 {"tokens":[{"id","member","device","createdAt"}]}  own tokens; admin sees all
DELETE /api/tokens/<id>                     200 {"id","revokedAt"}   own token, or any as admin

# admin only
GET    /api/members                         200 {"members":[{"name","role","createdAt","revokedAt"}]}
POST   /api/members    body {"name"}        201 {"name","inviteUrl","expiresAt"}   one-time invite link
POST   /api/members/<name>/invite           201 same shape; new invite for an existing member
POST   /api/members/<name>/tokens body {"device"}  201 {"id","token","member","device"}  token shown once
DELETE /api/members/<name>                  200 {"name","revokedAt"}  revokes member, tokens, sessions, invites
```

## Serving artifacts (server)

```
GET /a/<id>                 302 -> /a/<id>/
GET /a/<id>/                serve latest version's entry file
GET /a/<id>/<path...>       serve latest version's file at path
GET /a/<id>/?v=N            302 -> /a/<id>/v/N/  so relative assets resolve to that version
GET /a/<id>/v/N/            serve version N entry
GET /a/<id>/v/N/<path...>   serve version N file
```

- Content-Type from extension (html, htm, css, js, mjs, json, png, jpg, jpeg, gif,
  webp, svg, ico, mp4, webm, mov, mp3, wav, pdf, txt, md, csv, zip, woff2;
  default application/octet-stream). Text types get `; charset=utf-8`.
- `Accept-Ranges: bytes` and RFC 7233 single-range support (206 with Content-Range,
  416 with Content-Range: bytes */size on bad ranges). Required for video.
- Every uploaded file response gets
  `Content-Security-Policy: sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'`
- `X-Yeet-Artifact: <id>` and `X-Yeet-Version: <n>` on every artifact response.
- `Cache-Control: private, no-cache` for non-public; `public, max-age=60` for public.
- A path ending in `/` serves `index.html` in that directory if present.
- Never list directories. Never serve `.yeet.json` or any dotfile.

## Browser pages (server, inline HTML, no build step)

- `GET /devices/add[?code=]` logged in: form to add or deny a device code, showing the
  requesting device name. `POST /devices/add` with `code` and `action` (`add`|`deny`).
- `GET /devices` logged in: list own devices (admin: all) with a revoke button that
  POSTs to `/devices/<id>/revoke`.
- `GET /login/link?code=` signs in directly on an OS-initiated navigation, otherwise
  shows who and which terminal the link signs in as with a button. `POST /login/link`
  with `code` consumes it. Used, expired, or revoked links return 400.
- `GET /setup?code=` private first-run form. POST validates the one-time code and
  creates an admin with name/password. Setup is never enabled for an existing workspace.
- `GET /join?code=` validates an invite and shows password creation/reset; POST
  consumes it and signs in. Invalid, expired, or consumed links return 400.
- `/account` lets authenticated users set/change passwords; current password is
  required if one already exists. `/connect` shows the instance-specific CLI command.
- `/people` is admin-only and creates invitations and password-reset links.
- `GET /` logged in: list of artifacts the member may see (own private, all
  workspace, own public), grouped under a heading per project, with the project's description
  beneath its heading when it has one. Projects are ordered by
  their newest page and unfiled pages come last under "No project". Within a group,
  newest updated first: name or id, visibility, latest n, updated time, link. Plain and
  readable on a phone. Not logged in: 302 /login.
- `GET /login` username/password form as described above.
- `GET /css/yeet-v1.css` serves server/public/yeet-v1.css, public, cacheable.
- No artifact editing in the browser.

## CLI (cli/yeet.mjs)

Config file `~/.yeet/config.json`: `{ "origin", "token" }`. Environment `YEET_ORIGIN`
and `YEET_TOKEN` override the file. `--origin` flag overrides both.

Mapping file `~/.yeet/artifacts.json`: `{ "<sourceKey>": { "id", "url", "origin" } }`.
`sourceKey` = sha256 hex of `${os.hostname()}\0${absolute path of the thrown file or dir}`.

```
yeet login [server-url] [--device <name>] [--no-browser]  open browser, poll until approved, save origin + token
yeet login --origin <url>                   compatible alias; cannot combine with positional server-url
yeet login --origin <url> --token-stdin       paste a token instead (admin bootstrap, CI)
yeet open [link-or-id] [--qr|--no-browser]
                                              open Yeet signed in through this terminal: the default browser,
                                              a terminal QR code for a phone, or print the link
yeet whoami
yeet devices                                  list own device tokens
yeet devices revoke <id>

yeet throw <file-or-dir> [--name <n>] [--project <p>] [--project-description <text>]
                         [--private|--workspace|--public]
                         [--entry <relpath>] [--new] [--artifact <id-or-url>] [--json]
  - file: upload just that file as the entry.
  - dir: upload every file under it, skipping .git, node_modules, and any dotfile or
    dot-directory at any depth. Entry defaults to index.html at the root; else the
    single .html file at the root; else error asking for --entry.
  - Resolve the artifact: --artifact wins; else --new forces create; else look up
    sourceKey in the local mapping, then GET /api/artifacts?sourceKey; else create.
  - Sequence: POST versions -> PUT each file (progress on stderr when >10 files or
    >5 MiB total) -> commit. On any failure DELETE the pending version.
  - A visibility flag applies at create; on an existing artifact it PATCHes.
  - Project: --project wins and always PATCHes. Otherwise the CLI names the git repository
    of the thrown path (or the cwd) after its origin remote, else the main checkout's folder,
    and sets it at create or on an existing artifact that has no project.
  - After commit, --project-description PUTs the project description. Otherwise, when the
    page's project has no description, stderr says so with the yeet describe command to run.
    --json adds "project" and "projectDescription" when the page has a project.
  - Print exactly the URL on stdout as the last line. With --json print
    {"id","url","n","visibility"} instead.

yeet call <id-or-url> [--output <dir>] [--version N]
  - GET files.tar and extract into the output dir (default ./<id>). Print the dir.

yeet visibility <id-or-url> <private|workspace|public>
yeet project <id-or-url> <name>
yeet describe <project> ["description"]   prints, or sets, the project description
yeet sort [--all] [--dry-run] [--with <runner>] [--model <id>] [--min-confidence <0-1>]
  - Lists the caller's own committed artifacts, reads each entry page, and files the unfiled
    ones (all of them with --all) through a model. Prints "project  name" per change on stdout,
    or the plan as JSON with --json: {"origin","runner","model","createdAt","changes":[{"id",
    "url","name","from","project","confidence"?}]}.
  - --dry-run prints the plan; --save <file> writes it; --apply <file> applies a saved plan for
    the same origin without calling a model.
  - Applying creates the next numbered log, ~/.yeet/sorts/<8-digit sequence>.json (exclusive
    create, so concurrent runs get distinct numbers), before the first change. Entries start
    unattempted, are recorded pending just before their PATCH (expectedProject = "from"), then
    applied or skipped. A log with nothing applied or pending is removed.
  - --undo takes the highest-numbered log for this origin that is not undone and PATCHes each
    applied or pending entry back with expectedProject = the sorted project, recording each entry's undo
    outcome as it goes, so a failed undo resumes on retry. The log is marked undone at the end.
  - Runners: claude (--tools "" --strict-mcp-config) and codex (--ignore-user-config,
    shell, exec, browser, apps and plugin features disabled) spawn the local CLI with tools off; anthropic (Messages API),
    openai (Responses API), openrouter (chat completions, provider {zdr: true,
    require_parameters: true}), openai-decisions (Decisions API) and jev (TypeSafe) call the
    provider with a key from the environment. Decision runners choose among existing projects
    and file only at or above --min-confidence (default 0.6).
yeet info <id-or-url>            prints meta and versions

yeet add <name>                  admin; invite a person, prints a one-time link on stdout
yeet invite <name>               admin; new invite link for an existing member
yeet remove <name>               admin; revoke a person everywhere
yeet members                     admin; list people
```

Exit codes: 0 success, 1 usage error, 2 auth error, 3 server or network error.
Messages go to stderr; only results go to stdout.

`<id-or-url>` accepts a bare id, `${origin}/a/<id>`, or that with a trailing path.

## Tests (test/)

Server tests start the real server on an ephemeral port with `YEET_DATA` set to a
temp dir and exercise it over HTTP with fetch. CLI tests run cli/yeet.mjs as a child
process against a real server with HOME pointed at a temp dir. Together they must
cover the five "Done when" checks in SCOPE.md, adapted for local http.

Tests must run on Windows and Linux. Use os.tmpdir(), path.join, and never rely on
a shell.

## Hardening notes (2026-09-18 security review)

- Every artifact response carries the artifact CSP, not only HTML, because SVG and
  other types can carry script. The response-header sandbox allows scripts and
  same-origin so private media still sends SameSite cookies, but not forms, popups,
  or other sandbox privileges. Frame and worker directives are none. This is not
  an iframe sandbox attribute that an uploaded script could remove. Account pages
  use COOP same-origin; artifacts use unsafe-none to sever account opener references.
  Script-driven network access remains blocked. Never put account credentials in
  localStorage or non-HttpOnly cookies, since artifacts retain the same origin.
- Sessions record the device token that created them (`tokenId`). Revoking a token
  prunes those sessions; removing a member prunes all of theirs; `/logout` deletes
  the current session server-side, not just the cookie.
- Form posts to `/login`, `/devices/add`, and `/devices/<id>/revoke` are refused with
  403 when the browser reports `Sec-Fetch-Site` other than `same-origin` or `none`.
  Sibling origins on the same site count as cross-site here.
- New password, setup, invite, and account forms additionally require same-origin
  Fetch Metadata or an exact Origin header matching YEET_ORIGIN; null is refused.
  Password login and account-management responses are never cached.
- A browser that already has a session gets a 409 page from `/login?token=` and
  `/join` instead of a silent identity swap. API clients sending a Bearer header are
  not affected.
- `nextPath` rejects destinations that normalize to a protocol-relative `//` path.
- Device-code approval marks the request `approving` synchronously before the token
  mint, so concurrent approve or deny calls cannot double-mint. An approved token
  stays pollable for 60 seconds after first delivery in case the response was lost.
- Pending device logins are capped at 1000 total and 10 per client, keyed by
  the socket address by default. Forwarding headers are used only with YEET_TRUST_PROXY=1.
- Poll secrets and login/setup/invite query strings are excluded from request logs.
  The first-run setup URL is printed intentionally to the private server console.
- Offline owner recovery: stop the server, run `node server/recover.mjs --server-stopped`
  with its data directory and origin, restart, then redeem the private reset link.
- The CLI only reuses a saved token when the selected origin matches the origin it
  was saved for; `YEET_TOKEN` in the environment is always used as given.
- Known and accepted: a member can be phished into approving a code an attacker
  generated. The add-device page names the requesting device and the account it
  will act as, which is the mitigation.
