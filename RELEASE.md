# Release Process

All publishing happens from GitHub Actions — no local login needed.

## Stable (auto on merge to main)

Squash-merge any PR to `main`. The workflow publishes only when the merge
changed what actually ships. A merge whose every changed path is non-shipping
is skipped — `package-lock.json`, `.github/**`, or `package.json` with only
`version` and/or inert-devDependency changes. So a dependabot devDependency
bump does not cut a release. A devDependency that can affect the build
(`typescript`, `@vscode/vsce`, or anything not on the inert list) still
publishes, and manual `workflow_dispatch` always publishes.

When it does publish, the workflow:

1. Resolves the version to publish from the marketplace: one patch above
   whichever of `package.json` or the newest published stable version is
   higher. `package.json` is a floor, not the record — see below.
2. Publishes that VSIX to the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp).
   A failed publish is retried up to 3 times. PR pre-releases live on the
   separate `0.9.x` line, so this stable patch bump never collides with them.
3. Tags that commit `vX.Y.Z` and pushes the tag.
4. Creates a GitHub Release with auto-generated notes (VSIX attached).

The `vX.Y.Z` tag and the GitHub Release are the canonical record of the
published version. The workflow deliberately does **not** commit the bump back
to `main`: `package.json` therefore drifts behind the marketplace, exactly as it
does in the other Single Barrel Labs repositories, and is only ever read as a
floor. Keeping it honest would cost a personal access token, a PR per release
and one more thing that can fail after the release has already shipped — the
previous design — and nothing reads the field: `vsce` receives the version as an
argument, and installs and updates are driven by the marketplace.

## Pre-release (automatic per PR)

Every push to an open pull request publishes a unique pre-release to the
Marketplace pre-release channel:

- Runs after `build` and `test-e2e` pass, on same-repo, non-draft,
  non-dependabot PRs.
- Versions use the `0.9.<workflow-run>` line: the Marketplace only accepts
  plain `major.minor.patch` (no semver pre-release tags) and pre-release
  versions must differ from stable. `0.9.x` is always above the stable
  `0.3.x` line, so it never collides with stable releases and the newest
  push wins the channel.
- Re-running a workflow re-publishes the same version (deduplicated, safe).
- The published version is commented on the PR.

Pre-release publishes do NOT create tags and do NOT touch `package.json`.
