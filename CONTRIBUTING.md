# Contributing

Run the tests with `npm test`. They need Node 22 or newer and nothing else.

- Yeet has no runtime or dev dependencies. Use Node built-ins, and test with `node:test`.
- [SCOPE.md](SCOPE.md) is the product boundary. Read it before proposing a feature.
- [CONTRACT.md](CONTRACT.md) defines the API, CLI, limits, and storage. Update it in
  the same change as the behavior.
- Add a test for each bug you fix, one that fails without the fix.
- CI runs on Linux and Windows with Node 22 and 24, plus a container startup check.

Report security problems privately; see [SECURITY.md](SECURITY.md).

## Before a public release

- Get all CI jobs green for the exact commit being released, including Windows and
  the container startup check. Run `npm pack --dry-run --json` and inspect its file list.
- Scan the source and the full history of every branch and tag that will become
  public with a secret scanner such as Gitleaks. Review findings without posting
  secret values in logs or issues. Rotate any real exposed credential before release.
- Review plans, screenshots and deployment configuration for private
  information before they are pushed. Deleted files remain in Git history, and pushed
  history is public.
- Check the repository description matches the README and that private
  vulnerability reporting is still enabled for the link in SECURITY.md.
- Test a fresh deployment using the deployment guide, including setup, terminal
  login, publishing, access checks and restore from a backup. Never use live
  credentials or private pages in release screenshots.
- Keep the trusted-workspace warning visible in the README. Publishing source
  does not make Yeet suitable for hostile publishers or public signup.
