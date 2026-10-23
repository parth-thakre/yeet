# Yeet scope

Scope updated 2026-09-21 for simpler account setup.

## What Yeet is

Yeet is a self-hosted place for agent output to go when it does not belong in a
repository. An agent finishes work, writes one HTML page with whatever evidence it
needs (images, gifs, video), runs one command, and returns one link. The person
opens the link on any device, usually a phone, and sees the result.

It is PostPlan with attachments, privacy, and a workspace. It is used for plans,
post-coding demos ("do X on repo Y and yeet me a link of it working"), and ordinary
communication between agents and people.

The agent writes the HTML. Yeet does not render Markdown or transform content.

## Workspace

One instance is one workspace. Everyone onboarded to the instance sees every
workspace-visible artifact. Artifacts carry an optional project label that groups
the workspace page; it is not an access boundary. There are no teams, roles, or
per-artifact share lists.

People:

- Members. Invited by the admin through the website's People page or `yeet add <name>`.
  Removed with `yeet remove <name>`, which invalidates access on the next request.
- One admin. The person running the box. Only difference is the ability to add and
  remove members.

People choose a username and password through a private first-run setup link or
admin invitation. Any browser signs in independently and keeps an HttpOnly cookie.
`yeet login <server-url>` opens the browser for approval and saves a per-terminal
credential plus the server URL. Remote terminals print a link with `--no-browser`.
Tokens remain available for automation and legacy installations. No public signup
and no dependency on an email service or OAuth provider.

A second group that needs its own space runs a second instance.

## Visibility

One field per artifact, set at throw time and changeable later.

- `private`: only the person who threw it.
- `workspace`: every member. Default.
- `public`: anyone with the link, no login. IDs are unguessable and there is no
  public listing. Public pages get a content policy that blocks external scripts,
  forms, and frames.

## Artifacts and versions

- An artifact is an HTML entry file plus the files it references by relative path.
- `yeet throw <file-or-dir>` creates v1 and prints the stable link. Throwing the
  same local path again creates v2, v3, and the stable link advances. `?v=N` opens
  an exact version. Old versions are kept.
- Storage is a folder per version on disk: `data/<id>/v<n>/`. No database until
  there is a reason for one.
- Serving is static files with HTTP range support so video seeks on a phone.
  Native controls, `playsinline`, no autoplay.
- `yeet call <link>` downloads an artifact for an agent or person.

## CLI

```sh
yeet login https://yeet.example
yeet throw ./result            # prints link, default visibility workspace
yeet throw ./result --private
yeet throw ./result --public
yeet visibility <link> public
yeet call <link> --output ./received
yeet add alice                 # admin; also available in the website
yeet remove alice              # admin
```

`YEET_TOKEN` and `YEET_ORIGIN` are read from the environment for agents and CI.

## Agent skill

The skill is the highest-leverage file in the repo. Page quality depends on it.
It tells the agent to:

1. Run the thing and capture evidence itself: screenshots, a gif, or a short
   recording.
2. Write one HTML page that leads with what changed and embeds the evidence
   inline with relative paths.
3. Keep the page phone-friendly: no fixed widths, code blocks that scroll
   horizontally, images at full width, native video controls.
4. Not record credentials, notifications, or private customer data.
5. Throw it and return the link.

A stable stylesheet served by Yeet that the agent may link is optional. If used,
version its path so old artifacts do not change appearance.

## Deployment

- One Node process, one container, one compose file, one data volume.
- Reachable from the internet through a cloudflared tunnel or similar, since
  public links must work off the tailnet. Auth checks are therefore real on every
  request; the network is not trusted.
- Health endpoint. Backup is copying the data folder.

## Not in scope

- Markdown rendering or any server-side content transformation.
- Projects as access boundaries, teams, roles, per-artifact sharing, multiple workspaces per instance.
- Cloudflare Workers, D1, R2, or any second deployment architecture.
- Multipart or chunked uploads. Files large enough to need them are out of scope.
- Hosted service, billing, public signup.
- Landing pages and design variants until the phone loop has been used.
- Transcoding.

## Prior art

Yeet takes PostPlan's HTML policy and CLI structure as reference.

## Done when

1. Throwing a page with a gif and a video returns a link that opens on a phone
   over the tunnel, with the video seekable.
2. A second member onboarded with one command opens a workspace link directly
   after one login on their phone.
3. A private link returns 404 to that member. A public link opens logged out.
4. Rethrowing advances the link and `?v=1` still shows the original.
5. Removing the member breaks their access on the next request.

The product is worth continuing if, after two weeks of real use, the link is what
gets reached for instead of the terminal transcript.
