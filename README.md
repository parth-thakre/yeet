# Yeet

Yeet is a self-hosted place for agent output. Publish an HTML page with its images,
GIFs, and video, then share one link. Yeet serves your files without transforming them.

One server is one workspace. People sign in with a username and password.
Terminals connect once and remember the server. There is no public signup.

Yeet is an early release for small, trusted workspaces. Members can publish scripts
on the same origin as account pages. Don't host untrusted publishers or invite
people you wouldn't trust to publish pages other members open. There are no
per-member storage quotas. See [the security policy](SECURITY.md) before deployment.

Get the source and install the CLI with Node 22 or newer:

```sh
git clone https://github.com/parth-thakre/yeet.git
cd yeet
npm test
npm link
```

No dependency install is needed. The server and CLI use Node built-ins.

## Set up your server once

Run Yeet on an always-on machine or VPS. See the [deployment guide](deploy/README.md)
for Docker, HTTPS, and backups. A fresh server prints a private setup link in its
console. Open it and create your admin account. No bootstrap token is needed.

For a quick local trial with Node 22+, set `YEET_ORIGIN=http://localhost:3000` and
`YEET_INSECURE_COOKIE=1` in your shell, then run `npm start`. Open the setup link
printed in the terminal. The server listens on `127.0.0.1` only, so other machines
can't reach this trial. Set `YEET_HOST` to listen elsewhere, and use HTTPS before sharing.

## Sign in and connect a terminal

Open your server's website and sign in. New members open an invite link from the
admin and choose a password. Any browser can sign in independently.

Install Node 22+, then run `npm link` in this checkout to install the CLI:

```sh
yeet login https://your-yeet-server
```

Your browser opens. Sign in if needed, check the terminal name and code, and click
**Connect this terminal**. Yeet saves that server and a device credential in
`~/.yeet/config.json`. Treat that file as a secret. You don't need to specify the
server again.

On a remote machine, use `yeet login https://your-yeet-server --no-browser` and open
the printed link in any browser. If you have already saved the server, `yeet login`
reconnects to it. `--origin <url>` remains supported.

### Sign in a browser from the terminal

A connected machine doesn't need a password in its browser. The terminal signs it in:

```sh
yeet open                  # the default browser
yeet open <link-or-id>     # open a page, signed in
yeet open --qr             # scan with your phone to sign it in
yeet open --no-browser     # print the link to open in any browser
```

Each sign-in uses a one-time link that expires after two minutes. The browser
session belongs to this terminal's connection, so revoking the terminal under
**Terminals** also signs that browser out.

So a new machine needs one setup: `yeet login`, approved from any browser where you're
already signed in (your phone works), then `yeet open`.

The website's **Connect terminal** page shows the exact command for your server.
An agent under the same OS account can use the saved CLI connection. A different
machine or OS account needs its own connection. Browser sessions and CLI
credentials are separate; you never need to copy them between devices.

```sh
yeet whoami
yeet throw ./result
```

## Invite people and manage access

Admins use **People** on the website to create an invite or password-reset link.
Send it privately. The recipient chooses a password; the link expires in 7 days
and is consumed only when they submit it, not when a link preview opens it.

Use **Terminals** to revoke a CLI connection and **Account** to change your password.
Changing or resetting a password signs out other browsers and all terminals.
Admins can still use `yeet add <name>`, `yeet invite <name>`, and
`yeet remove <name>` from an authenticated CLI.

Existing token-only users can sign in through **Have an existing device token?**
and set a password in **Account**. Adding their first password preserves existing
connections and artifacts. See [recovery and upgrades](deploy/README.md).

## Throw, revise, and read

```sh
yeet throw ./result --name "Checkout fix"
yeet call <url> --output ./received
```

Put `index.html` and its assets in the directory, and reference assets with relative paths.
Throwing the same local path from the same machine updates the stable link and keeps previous versions.
Add `?v=1` to the link to open the first version. `yeet call` on a pinned link downloads that version.
Yeet supports byte ranges so videos can seek.
Use native video controls, `playsinline`, and no autoplay.
Each version allows up to 500 files, with a 200 MiB limit per file.

A throw that was killed mid-upload leaves a pending version, and the next throw of that page reports it.
Run `yeet abandon <url>` to drop it, or wait: after 30 minutes with no upload, the next throw replaces it.

## Visibility

| Level | Who can read it | Throw flag |
| --- | --- | --- |
| Workspace, the default for new artifacts | Every active member of this instance | `--workspace` |
| Private | Only the member who published it | `--private` |
| Public | Anyone with the link, without login | `--public` |

Public IDs are unguessable and there is no public listing, but anyone can forward a public link.
Change access with `yeet visibility <url> private`, `workspace`, or `public`.
An existing artifact keeps its visibility on rethrow unless you pass a visibility flag.
A flag that opens a page up takes effect only once the new version is published, so a failed throw never exposes the old one.
Visibility applies to the artifact and all its retained versions.
The admin adds and removes people with `yeet add` and `yeet remove`; there are no teams or per-artifact share lists.

## Projects

The workspace page groups pages by project. A project is a label for browsing, not an access boundary.
`yeet throw` files a new page under the git repository it was thrown from, named after the `origin` remote, so every
machine and worktree of one repository agree. Pass `--project <name>` to choose one, or refile a page later:

```sh
yeet throw ./yeet-out/demo --project checkout
yeet project <link> checkout
```

A detected repository only fills in a page that has no project. It never moves a page you filed yourself.

Each project can have a one-line description, shown under its heading. When a page lands in a project with no
description, `yeet throw` says so, and the agent skill writes one or asks you for it:

```sh
yeet describe checkout "Phone checkout rebuild for the storefront"
yeet describe checkout                       # print it
yeet throw ./result --project checkout --project-description "Phone checkout rebuild"
```

`yeet sort` also reads the descriptions, which helps it match pages to the right project.
Other members see a description only once its author has a non-private page in that project, so describing a
private project doesn't reveal it.

### Sort older pages with a cheap model

`yeet sort` reads each of your unfiled pages and asks a small model which project it belongs to:

```sh
yeet sort --dry-run      # show what would change
yeet sort                # apply it
yeet sort --all          # re-sort pages that already have a project
yeet sort --undo         # put back the pages the last sort moved
```

To compare models before changing anything, save each one's plan and apply the one you like. A plan is applied
exactly as saved, without asking the model again:

```sh
yeet sort --with claude --save haiku.json
yeet sort --with codex --save luna.json
yeet sort --apply haiku.json
```

Every applied sort is logged in `~/.yeet/sorts/` on the machine that ran it. `--undo` walks back one sort at a time,
newest first. Applying and undoing both skip any page refiled in between, so neither overwrites your own changes.

Choose the model with `--with`:

| Runner | Model | Needs |
| --- | --- | --- |
| `claude` (default) | Claude Haiku 5.5 | a signed-in `claude` CLI |
| `codex` | GPT-6 Luna | a signed-in `codex` CLI |
| `anthropic` | Claude Haiku 5.5 | `ANTHROPIC_API_KEY` |
| `openai` | GPT-6 Luna, Responses API | `OPENAI_API_KEY` |
| `openrouter` | Haiku 5.5 (`--model openai/gpt-6-luna` etc.) | `OPENROUTER_API_KEY` |
| `openai-decisions` | GPT-6 Luna, Decisions API | `OPENAI_API_KEY` |
| `jev` | TypeSafe Jev | `TYPESAFE_API_KEY` |

The first five can create project names. `openrouter` always asks OpenRouter for zero-data-retention endpoints
(`provider.zdr`) that support the response schema, and fails rather than fall back to one that retains data. `openai-decisions` and `jev` are decision models: they pick among your
existing projects (or none), and a page is filed only when the model's confidence is at least `--min-confidence`
(default 0.6). Use them once a few projects exist. `--model <id>` overrides the runner's model.
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, and `TYPESAFE_BASE_URL` point a runner at a proxy.

Sorting sends each page's name, title, and first 800 characters of text to that model's provider.
It only changes your own pages, and filing a page does not change its place in the list.

## Agent skill

Copy [`skills/yeet/`](skills/yeet/SKILL.md) into your agent's skills directory as `yeet/`.
For an agent that reads `~/.claude/skills`, use `cp -R skills/yeet ~/.claude/skills/` after creating that directory if needed.
Give the agent a configured CLI or set `YEET_ORIGIN` and `YEET_TOKEN` through its secret-handling mechanism.
Ask it to "yeet me a link" or "show me it working".
The skill tells it to capture real evidence, write a phone-friendly page, publish it, and return the URL.

## Project docs

- [Scope](SCOPE.md) is the product boundary.
- [Build contract](CONTRACT.md) defines the API, CLI, file limits, and storage.
- [Deployment](deploy/README.md) covers member onboarding, tunnels, backup, upgrades, and logs.

The server is one Node process with zero runtime dependencies and disk storage, not a database.
Run tests with `npm test`. Run without Docker with `npm start` after setting the server environment described in the contract.
