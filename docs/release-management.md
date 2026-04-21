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
   and uploads both a machine-readable pack verification artifact and the actual packed `.tgz` for debugging / inspection
   even when `npm pack` itself fails before normal verification can complete
6. runs `npm run test:pack:smoke`
   to install the produced tarball into a clean temp project and prove the packaged CLI + exports still work from the npm package boundary
   while still preserving a machine-readable failure artifact if the smoke dies before it can pass
7. writes `.generated/release/release-verification-report.json`
   as a single machine-readable rollup of pack verification, tarball-install smoke, and Docker acceptance
   even if one of those upstream artifacts is missing because a verification lane failed early
8. uploads that report and then asserts it explicitly before continuing, so failures still preserve the rollup artifact for debugging
9. uses `changesets/action` to either:
   - open/update a `Version packages` PR when pending changesets exist, or
   - publish the already-versioned package after that PR is merged

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
