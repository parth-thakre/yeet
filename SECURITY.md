# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue. Include the Yeet commit, how
you deployed it, and the steps that reproduce the problem.

## What Yeet assumes

- One server is one small, trusted workspace. Members can publish HTML with scripts,
  and those pages run on the Yeet origin. Don't invite people you wouldn't trust to
  publish pages your other members open.
- The server runs behind HTTPS (a tunnel or a reverse proxy). `YEET_INSECURE_COOKIE=1`
  is for local trials only.
- `YEET_TRUST_PROXY=1` is set only when every request arrives through that proxy.
- There is no per-member storage quota. Keep an eye on disk use.

Hosting for strangers or hostile publishers is not supported.
