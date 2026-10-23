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

### Fresh-deployment checks

Use throwaway data and localhost HTTP with insecure cookies enabled as described
in the README and deployment guide. Also try plain `npm start`. Do not reuse a
live CLI connection. Before running any CLI commands, isolate its saved state and
remove environment credentials:

```sh
export YEET_HOME=$(mktemp -d)
unset YEET_TOKEN YEET_ORIGIN
```

`YEET_HOME` overrides the CLI's entire `~/.yeet` directory, including credentials
and artifact mappings. Keep the same temporary directory for the trial.

- Open the first-run link from the console and create an admin. Invite a second
  member through People; redeem the invite in a separate browser profile.
- Run `yeet login http://localhost:3000 --no-browser --device release-trial`,
  approve its code in the admin browser, then check `yeet whoami`.
- Throw an HTML directory with a real image and a video. Check media decoding and
  seeking in the browser, plus a byte-range request returning 206 and the requested
  bytes. Rethrow to create another version and check `?v=1` still opens the first.
- Check private, workspace and public pages and their assets as the owner, the
  other member, and a logged-out client. The other member must get 404 for private
  pages. Public pages must open logged out; other pages must require login.
- Test `yeet open --no-browser` both without a target and with a private-page URL
  in a fresh browser. Each link must work once, then reject reuse.
- Stop the server, copy its whole data directory, wipe only the throwaway data,
  and restore the copy. Check both password logins, the saved terminal connection,
  pages, access rules and retained versions after restart.
