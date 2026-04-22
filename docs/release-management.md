# Release Management

Equip now uses Changesets for stable npm releases.

## Source Of Truth

The version is not decided by git tags.

The source of truth is:

1. pending `.changeset/*.md` files
2. the version bump committed by the `Version packages` release PR
3. the published `package.json` version on `main`

Tags and GitHub releases are outputs of the release workflow after the version is already decided.

## Contributor Flow

When a change should affect the published package:

```bash
npm run changeset
```

That writes a markdown file under `.changeset/` describing the release impact:

- `patch` for fixes and low-risk behavior tweaks
- `minor` for backward-compatible features
- `major` for breaking changes

Commit that file with the code change.

You usually do **not** need a changeset for:

- CI-only changes
- repo-only docs that do not affect the published package contract
- workflow or contributor-tooling changes

## Release Flow

The release workflow lives in `.github/workflows/release.yml`.

On pushes to `main` it:

1. installs dependencies
2. builds
3. runs `npm test`
4. runs `npm run test:docker:acceptance`
   and uploads the machine-readable Docker acceptance report plus raw build/run logs
5. runs `npm run test:pack`
   and uploads a machine-readable pack verification artifact, a raw `pack-verification.log`, and the actual packed `.tgz` for debugging / inspection
   even when `npm pack` itself fails before normal verification can complete
6. runs `npm run test:pack:smoke`
   to install the produced tarball into a clean temp project and prove the packaged CLI + exports still work from the npm package boundary
   while still preserving a machine-readable failure artifact plus raw `pack-install-smoke.log` output if the smoke dies before it can pass
7. writes `.generated/release/release-verification-report.json`
   as a single machine-readable rollup of pack verification, tarball-install smoke, and Docker acceptance
   even if one of those upstream artifacts is missing because a verification lane failed early,
   while rebasing the per-lane log/report/tarball artifact pointers to the current verification workspace for easier debugging
   and recording the corresponding uploaded GitHub artifact names for each verification lane
8. uploads that report and then asserts it explicitly before continuing, so failures still preserve the rollup artifact for debugging
9. writes `.generated/release/release-verification-assertion.json`
   as a final machine-readable gate verdict with component statuses and failure details
10. appends a final `Release verification assertion` section to the GitHub job summary so the human-readable workflow output reflects the post-assert gate outcome too
11. writes and uploads `.generated/release/release-verification-summary.md`
    so the final rollup plus assertion state also survive as one human-readable Markdown artifact
12. rewrites `.generated/release/release-verification-report.json`
    after the assertion/summary steps so the uploaded rollup also points at the final assertion and Markdown summary artifacts
13. uses `changesets/action` to either:
    - open/update a `Version packages` PR when pending changesets exist, or
    - publish the already-versioned package after that PR is merged
14. writes `.generated/release/changesets-release-result.json`
    after the Changesets step so the workflow preserves a machine-readable release outcome even when the action fails
15. asserts the Changesets result explicitly and writes `.generated/release/changesets-release-assertion.json`
    so the final pass/fail verdict is preserved as a machine-readable gate artifact instead of living only in workflow logs
16. writes and uploads `.generated/release/changesets-release-summary.md`
    after that assertion step so the human-readable Markdown artifact and job-summary section reflect the true final gate state
17. writes and uploads `.generated/release/changesets-release-report.json`
    as a single machine-readable rollup of the result, final assertion, and summary/report artifact paths
18. uploads the result, summary, assertion, and report artifacts before the workflow turns red
    so release-PR/publish failures still leave behind both structured and quick-scan evidence plus one canonical JSON entrypoint

## Publishing Auth

Preferred path:

- npm trusted publishing from GitHub Actions

That means configuring the package on npmjs.com to trust:

- repository: `CharlesMulic/equip`
- workflow file: `release.yml`

The workflow already requests `id-token: write`, which is required for npm trusted publishing.

Fallback path:

- set a repository secret named `NPM_TOKEN`

If present, the workflow writes a temporary `.npmrc` and publishes with that token instead.

## Local Commands

Useful local release commands:

```bash
npm run changeset
npm run version-packages
npm run test:pack
npm run test:pack:smoke
npm run release
```

Typical maintainers should not run `npm run release` locally for normal stable releases. The intended stable publish path is the GitHub Actions workflow on `main`.
