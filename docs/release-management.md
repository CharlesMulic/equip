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

1. runs `node scripts/ci/run-release-bootstrap.mjs`
   which captures the release workflow's `npm ci` dependency-install phase into:
   - `.generated/release/release-bootstrap-result.json`
   - `.generated/release/release-bootstrap-summary.md`
   - `.generated/release/release-bootstrap.log`
   and uploads them as the `release-bootstrap` evidence bundle even when dependency install fails
2. runs `node scripts/ci/run-release-preflight.mjs`
   which captures the release workflow's `build` and `npm test` phases into:
   - `.generated/release/release-preflight-result.json`
   - `.generated/release/release-preflight-summary.md`
   - `.generated/release/release-preflight-build.log`
   - `.generated/release/release-preflight-test.log`
   and uploads them as the `release-preflight` evidence bundle even when one of those early phases fails
   but only if the bootstrap lane passed
3. runs `npm run test:docker:acceptance`
   and uploads the machine-readable Docker acceptance report plus raw build/run logs
   but only if the preflight lane passed
4. runs `npm run test:pack`
   and uploads a machine-readable pack verification artifact, a raw `pack-verification.log`, and the actual packed `.tgz` for debugging / inspection
   even when `npm pack` itself fails before normal verification can complete
   and only after the preflight lane passed
5. runs `npm run test:pack:smoke`
   to install the produced tarball into a clean temp project and prove the packaged CLI + exports still work from the npm package boundary
   while still preserving a machine-readable failure artifact plus raw `pack-install-smoke.log` output if the smoke dies before it can pass
   and only after the preflight lane passed
6. writes `.generated/release/release-verification-report.json`
   as a single machine-readable rollup of pack verification, tarball-install smoke, and Docker acceptance
   even if one of those upstream artifacts is missing because a verification lane failed early,
   while also carrying the bootstrap/preflight prerequisite state so intentionally blocked downstream lanes are marked `skipped` instead of being mislabeled `missing`,
   while rebasing the per-lane log/report/tarball artifact pointers to the current verification workspace for easier debugging
   and recording the corresponding uploaded GitHub artifact names for each verification lane
7. uploads that report and then asserts it explicitly before continuing, so failures still preserve the rollup artifact for debugging
8. writes `.generated/release/release-verification-assertion.json`
   as a final machine-readable gate verdict with component statuses and failure details
9. writes and uploads `.generated/release/release-verification-summary.md`
    after the assertion step so the Markdown artifact reflects the final gate outcome,
    includes the uploaded evidence artifact names, and stays aligned behind one canonical human-readable rendering
10. rewrites `.generated/release/release-verification-report.json`
    after the assertion/summary steps so the uploaded rollup also points at the final assertion and Markdown summary artifacts
11. uses `changesets/action` to either:
    - open/update a `Version packages` PR when pending changesets exist, or
    - publish the already-versioned package after that PR is merged
12. writes `.generated/release/changesets-release-result.json`
    after the Changesets step so the workflow preserves a machine-readable release outcome even when the action fails,
    and blocked publish attempts are marked `skipped` with the upstream verification status instead of being flattened into a generic failure
13. asserts the Changesets result explicitly and writes `.generated/release/changesets-release-assertion.json`
    so the final pass/fail verdict is preserved as a machine-readable gate artifact instead of living only in workflow logs
14. writes and uploads `.generated/release/changesets-release-summary.md`, including the final assertion state and the uploaded artifact names for the result/assertion/summary/report evidence set
    after that assertion step so the human-readable Markdown artifact reflects the true final gate state
15. writes and uploads `.generated/release/changesets-release-report.json`
    as a single machine-readable rollup of the result, final assertion, summary/report artifact paths,
    and the corresponding uploaded GitHub artifact names,
    while preserving both the actual lane `status` and the assertion-adjusted `effectiveStatus`
16. uploads the result, summary, assertion, and report artifacts before the workflow turns red
    so release-PR/publish failures still leave behind both structured and quick-scan evidence plus one canonical JSON entrypoint
17. writes and uploads `.generated/release/release-workflow-report.json`
    as the final workflow-level rollup combining the release-bootstrap result, the release-preflight result, the release-verification report, and the Changesets release report,
    so operators have one canonical machine-readable entrypoint for the whole release run,
    while preserving both the actual workflow status and the assertion-adjusted effective status,
    while also flattening the key nested log/report artifact paths into one `evidenceFiles` view for easier debugging,
    while marking verification and Changesets as `skipped` instead of `missing` when an earlier release stage prevented them from running
18. writes and uploads `.generated/release/release-workflow-summary.md`
    as the matching human-readable summary of the full workflow rollup, including the uploaded artifact names to open next
    plus the flattened evidence-file paths for the nested bootstrap/preflight/verification/changesets bundles,
    and appends that final top-level rendering to the GitHub job summary
19. rewrites `.generated/release/release-workflow-report.json`
    after the summary step so the final machine-readable report also points at the uploaded summary artifact path
20. asserts that workflow-level report explicitly and writes `.generated/release/release-workflow-assertion.json`
    so the final release verdict is preserved as a machine-readable gate artifact instead of being inferred only from the report contents
21. rewrites the workflow summary/report after that assertion step and uploads the summary, assertion, and report artifacts
    before the job turns red, so failed final-release gates still leave behind one complete evidence bundle

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
