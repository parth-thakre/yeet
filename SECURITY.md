# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue. Include the Yeet commit, how
you deployed it, and the steps that reproduce the problem.

## What Yeet assumes

- One server is one small, trusted workspace. Yeet is an early release.
- Members can publish HTML with scripts. With `YEET_CONTENT_ORIGIN` set, those pages
  run on a separate origin that has no account access. Their scripts can't use the
  viewer's session, call the API as the viewer, or read account pages.
- Without `YEET_CONTENT_ORIGIN`, pages run on the same origin as account pages, and
  any member can act as anyone who opens their page. Don't run that way with
  publishers you don't trust.
- Every published page shares the one content origin. A page's scripts can read
  browser storage, such as `localStorage`, that another page saved there. Don't
  keep secrets in browser storage from a published page.
- The content policy still blocks scripts in published pages from making network
  requests, submitting forms, or loading frames.
- The server runs behind HTTPS (a tunnel or a reverse proxy). `YEET_INSECURE_COOKIE=1`
  is for local trials only.
- `YEET_TRUST_PROXY=1` is set only when every request arrives through that proxy.
- There is no per-member storage quota. Keep an eye on disk use.

Hosting for strangers or hostile publishers is not supported.
