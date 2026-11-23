# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Don't open a public issue. Include the Yeet commit, how
you deployed it, and the steps that reproduce the problem.

## What Yeet assumes

- One server is one small, trusted workspace. Yeet is an early release.
- Members can publish HTML with scripts. With `YEET_CONTENT_ORIGIN` set, those pages
  run on a separate origin. Their scripts can't reach account pages, the API, or the
  viewer's session.
- Without `YEET_CONTENT_ORIGIN`, pages run on the same origin as account pages, and
  any member can act as anyone who opens their page. Don't run that way with
  publishers you don't trust.
- Every published page shares the one content origin. A hostile page can load files
  from other pages the viewer opened in the last 12 hours, while each page's access
  cookie lasts. It can also read browser storage, such as `localStorage`, that any
  published page saved. Yeet only issues that cookie when the viewer opens a page, so pages the
  viewer hasn't opened stay out of reach. Keeping pages apart from each other would
  need an origin per page, which Yeet doesn't support.
- Browsers treat a sibling subdomain, such as `yeet-content.example.com` next to
  `yeet.example.com`, as the same site. Account cookies then go along with requests
  from published pages, and Yeet relies on its own checks to refuse them. A separate
  registrable domain, such as `yeet-content.net`, also gets the browser's site
  boundary and is stronger.
- The content policy blocks scripts in published pages from using `fetch`, submitting
  forms, or loading frames. It allows images and media from any https URL, so a
  hostile script can still send what it reads to another site in a URL.
- The server runs behind HTTPS (a tunnel or a reverse proxy). `YEET_INSECURE_COOKIE=1`
  is for local trials only.
- `YEET_TRUST_PROXY=1` is set only when every request arrives through that proxy.
- There is no per-member storage quota. Keep an eye on disk use.

Hosting for strangers or hostile publishers is not supported.
