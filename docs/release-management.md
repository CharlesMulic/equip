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
   and now carries the GitHub workflow context for that run (repository/workflow/run/ref/sha/event plus derived run/commit URLs)
   plus machine-readable evidence file names derived from those raw JSON/Markdown/log paths
   plus the uploaded GitHub artifact bundle name for that early evidence set
   and uploads them as the `release-bootstrap` evidence bundle even when dependency install fails
2. runs `node scripts/ci/run-release-preflight.mjs`
   which captures the release workflow's `build` and `npm test` phases into:
   - `.generated/release/release-preflight-result.json`
   - `.generated/release/release-preflight-summary.md`
   - `.generated/release/release-preflight-build.log`
   - `.generated/release/release-preflight-test.log`
   and now carries the GitHub workflow context for that run (repository/workflow/run/ref/sha/event plus derived run/commit URLs)
   plus machine-readable evidence file names derived from those raw JSON/Markdown/log paths
   plus the uploaded GitHub artifact bundle name for that early evidence set
   and uploads them as the `release-preflight` evidence bundle even when one of those early phases fails
   but only if the bootstrap lane passed
3. runs `npm run test:docker:acceptance`
   and uploads the machine-readable Docker acceptance report plus raw build/run logs
   but only if the preflight lane passed
4. runs `npm run test:pack`
   and uploads a machine-readable pack verification artifact, a raw `pack-verification.log`, and the actual packed `.tgz` for debugging / inspection
   even when `npm pack` itself fails before normal verification can complete
   while now also carrying the GitHub workflow context for that raw pack artifact (repository/workflow/run/ref/sha/event plus derived run/commit URLs)
   plus the raw verification JSON's own file path
   plus the uploaded artifact bundle names for the raw verification JSON/log bundle and the packed tarball bundle
   and only after the preflight lane passed
5. runs `npm run test:pack:smoke`
   to install the produced tarball into a clean temp project and prove the packaged CLI + exports still work from the npm package boundary
   while still preserving a machine-readable failure artifact plus raw `pack-install-smoke.log` output if the smoke dies before it can pass
   while now also carrying the GitHub workflow context for that raw tarball-smoke artifact
   plus the raw tarball-smoke JSON's own file path
   plus the uploaded artifact bundle names for both the raw tarball-smoke JSON/log bundle and the input tarball bundle
   and only after the preflight lane passed
6. runs `npm run test:docker:acceptance`
   and uploads the machine-readable Docker acceptance report plus raw build/run logs
   while now also carrying the GitHub workflow context for that raw Docker artifact
   plus the uploaded artifact bundle name for that raw Docker report/log bundle
   but only if the preflight lane passed
7. writes `.generated/release/release-verification-report.json`
   as a single machine-readable rollup of pack verification, tarball-install smoke, and Docker acceptance
   even if one of those upstream artifacts is missing because a verification lane failed early,
   while also carrying the bootstrap/preflight prerequisite state so intentionally blocked downstream lanes are marked `skipped` instead of being mislabeled `missing`,
   while rebasing the per-lane log/report/tarball artifact pointers to the current verification workspace for easier debugging
   and recording the corresponding uploaded GitHub artifact names for each verification lane,
   and now also carrying the GitHub workflow context for that run (repository/workflow/run/ref/sha/event plus derived run/commit URLs)
8. uploads that report and then asserts it explicitly before continuing, so failures still preserve the rollup artifact for debugging
9. writes `.generated/release/release-verification-assertion.json`
   as a final machine-readable gate verdict with component statuses and failure details,
   and that assertion artifact now also carries the machine-readable upstream input-presence state, the bootstrap/preflight summaries, the GitHub workflow context, plus the verification-lane evidence paths and artifact names
10. writes and uploads `.generated/release/release-verification-summary.md`
    after the assertion step so the Markdown artifact reflects the final gate outcome,
    includes the uploaded evidence artifact names, and stays aligned behind one canonical human-readable rendering
11. rewrites `.generated/release/release-verification-report.json`
    after the assertion/summary steps so the uploaded rollup also points at the final assertion and Markdown summary artifacts
12. uses `changesets/action` to either:
    - open/update a `Version packages` PR when pending changesets exist, or
    - publish the already-versioned package after that PR is merged
13. writes `.generated/release/changesets-release-result.json`
    after the Changesets step so the workflow preserves a machine-readable release outcome even when the action fails,
    and blocked publish attempts are marked `skipped` with the upstream verification status instead of being flattened into a generic failure,
    while also preserving whether the upstream release-verification report was actually present,
    while now also preserving its own result path plus the upstream release-verification report path and their uploaded artifact names,
    and now also carrying the GitHub workflow context for that run (repository/workflow/run/ref/sha/event plus derived run/commit URLs)
14. asserts the Changesets result explicitly and writes `.generated/release/changesets-release-assertion.json`
   so the final pass/fail verdict is preserved as a machine-readable gate artifact instead of living only in workflow logs,
   and that assertion artifact now also carries the actual/effective status split, the release-verification input-presence state, the Changesets result-artifact presence state, the GitHub workflow context, plus the summary/report evidence paths and artifact names
15. writes and uploads `.generated/release/changesets-release-summary.md`, including the final assertion state and the uploaded artifact names for the result/assertion/summary/report evidence set
    after that assertion step so the human-readable Markdown artifact reflects the true final gate state,
    and it now still renders a truthful `missing` result state when the Changesets result artifact itself never appeared
16. writes and uploads `.generated/release/changesets-release-report.json`
    as a single machine-readable rollup of the result, final assertion, summary/report artifact paths,
    and the corresponding uploaded GitHub artifact names,
    while also preserving the release-verification input-presence state that fed the Changesets lane,
    while preserving both the actual lane `status` and the assertion-adjusted `effectiveStatus`,
    while now also recording whether the result/assertion inputs themselves were actually present,
    and while now also carrying the GitHub workflow context for that Changesets lane
17. uploads the result, summary, assertion, and report artifacts before the workflow turns red
    so release-PR/publish failures still leave behind both structured and quick-scan evidence plus one canonical JSON entrypoint
18. writes and uploads `.generated/release/release-workflow-report.json`
    as the final workflow-level rollup combining the release-bootstrap result, the release-preflight result, the release-verification report, and the Changesets release report,
    so operators have one canonical machine-readable entrypoint for the whole release run,
    while preserving both the actual workflow status and the assertion-adjusted effective status,
    while also flattening the key nested log/report artifact paths into one `evidenceFiles` view for easier debugging,
    while now also flattening the nested bootstrap/preflight evidence file names plus the final workflow file names into an `evidenceFileNames` view,
    while also flattening the nested release-bootstrap, release-preflight, release-verification, and Changesets uploaded artifact names into one `evidenceArtifactNames` view,
    while marking verification and Changesets as `skipped` instead of `missing` when an earlier release stage prevented them from running
19. writes and uploads `.generated/release/release-workflow-summary.md`
    as the matching human-readable summary of the full workflow rollup, including the uploaded artifact names to open next
    plus the flattened evidence-file paths for the nested bootstrap/preflight/verification/changesets bundles,
    plus the flattened nested bootstrap/preflight/final-workflow evidence file names from those bundles,
    plus the flattened nested bootstrap/preflight/verification/Changesets artifact names from those bundles,
    plus the GitHub workflow context (repository/workflow/run/ref/sha/event plus derived run/commit URLs) for that release run,
    and appends that final top-level rendering to the GitHub job summary,
    while now also rendering a truthful `release workflow report missing` state instead of failing empty-handed if the top-level report artifact never appeared
20. rewrites `.generated/release/release-workflow-report.json`
    after the summary step so the final machine-readable report also points at the uploaded summary artifact path
21. asserts that workflow-level report explicitly and writes `.generated/release/release-workflow-assertion.json`
    so the final release verdict is preserved as a machine-readable gate artifact instead of being inferred only from the report contents,
    and that assertion artifact now also carries the report's machine-readable input-presence state, GitHub workflow context including the derived run/commit URLs, plus the top-level artifact-name and flattened evidence-file-name / evidence-file / evidence-artifact maps from the workflow report,
    and it now still writes a failure artifact with `hasReleaseWorkflowReport: false` when the top-level workflow report artifact itself is missing
22. rewrites the workflow summary/report after that assertion step and uploads the summary, assertion, and report artifacts
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
