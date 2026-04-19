This directory holds Changesets files for stable `@cg3/equip` releases.

Contributor workflow:

1. make the package change
2. run `npm run changeset`
3. commit the generated markdown file with your code change

Release workflow:

1. changeset files merge to `main`
2. the release workflow opens or updates a `Version packages` PR
3. merging that PR publishes the versioned package to npm

The committed `package.json` version on `main` is the canonical released version.
Tags and GitHub releases are outputs of the release process, not the input that decides the version.
