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
5. uses `changesets/action` to either:
   - open/update a `Version packages` PR when pending changesets exist, or
   - publish the already-versioned package after that PR is merged

## GitHub PR Creation Auth

The Changesets workflow needs permission to open the `Version packages` PR.

You can satisfy that requirement in either of these ways:

- enable repository setting `Settings -> Actions -> General -> Workflow permissions -> Allow GitHub Actions to create and approve pull requests`
- set a repository secret named `RELEASE_GITHUB_TOKEN` and let the workflow use that token for PR creation

If you use the built-in `GITHUB_TOKEN`, the repository setting must be enabled or the workflow will fail when it tries to create the release PR.

If you use `RELEASE_GITHUB_TOKEN`, prefer a fine-grained personal access token scoped to this repository with write access to contents and pull requests.

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
npm run release
```

Typical maintainers should not run `npm run release` locally for normal stable releases. The intended stable publish path is the GitHub Actions workflow on `main`.
