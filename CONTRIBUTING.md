# Contributing to Equip

Thanks for your interest in contributing to Equip! This guide covers the development setup, testing, and conventions.

## Development Setup

```bash
git clone https://github.com/CharlesMulic/equip.git
cd equip
npm install
npm run build    # TypeScript → dist/
```

**Requirements:** Node.js 18+, TypeScript 6+

## Project Structure

```
bin/             CLI entry points (JS — delegates to dist/)
src/index.ts     Public API surface + Augment class
src/cli/         CLI entry points (TypeScript)
  equip.ts       Main CLI dispatcher
  unequip.ts     Uninstall CLI
src/lib/         Library source (TypeScript)
  commands/      CLI command implementations
  platforms.ts   Platform registry (13 platforms)
  reconcile.ts   Post-install state reconciliation
  cli.ts         CLI helpers (parseArgs, isLocalPath, prompts)
  auth-engine.ts Authentication flows (API key, OAuth, PKCE)
  mcp.ts         MCP config read/write across formats (JSON, JSON5, TOML)
  fs.ts          Atomic writes, lockfile, safe JSON reads
test/            Node.js test runner tests
docs/            User-facing documentation
```

## Building

```bash
npm run build    # tsc — compiles src/ → dist/
```

The CLI (`bin/equip.js`) requires compiled output from `dist/`. Always rebuild after changing TypeScript sources.

## Testing

```bash
npm test         # Build + run all tests
```

Tests use Node.js built-in test runner (`node --test`). Key test files:

| File | What it tests |
|---|---|
| `test/equip.test.js` | Core Augment class, MCP install/uninstall, rules, skills |
| `test/observability.test.js` | InstallReportBuilder, structured results |
| `test/registry.test.js` | Registry fetch, augment definition parsing |
| `test/auth.test.js` | Credential storage, OAuth flows, validation |
| `test/docs.test.js` | Documentation examples actually work |
| `test/augment-defs.test.js` | Augment definition CRUD, sync, modding |
| `test/platform-state.test.js` | Platform metadata, scan results |
| `test/snapshots.test.js` | Config snapshots, initial capture, restore |
| `test/security.test.js` | Input validation, path traversal, URL scheme checks |
| `test/content-hash.test.js` | Cross-language content hash parity |
| `test/cli.test.js` | CLI arg parsing, local path detection, integration |

Tests that write to `~/.equip/` use temp directory isolation (`setupTempHome`/`teardownTempHome`) to avoid polluting real state.

## Code Conventions

- **Zero runtime dependencies.** No npm packages beyond Node.js built-ins. This is a hard constraint — fast installs and no supply chain risk.
- **Atomic file writes.** Always use `atomicWriteFileSync` for config modifications. Never write directly to config files.
- **Platform-aware.** Code must work on Windows, macOS, and Linux. Use `path.join` for paths, test with forward and back slashes.
- **Graceful degradation.** Filesystem operations that might fail (reading optional files, scanning platform configs) should catch errors silently. Use `try { ... } catch { /* best effort */ }` for non-critical operations.
- **Terminology.** Use "augment" for the user-facing concept (not "tool" or "server"). Use "MCP server" only when referring specifically to the MCP layer.

## Adding a New Platform

1. Add platform definition to `src/lib/platforms.ts` — detection dirs/files, config path, root key, format, `httpShape`, capabilities
2. Add MCP format handling to `src/lib/mcp.ts` if the platform uses a non-standard config format
3. Update platform tests in `test/equip.test.js`
4. Update `docs/platforms.md` and the platform table in `README.md`

## Pull Request Guidelines

- Keep PRs focused — one logical change per PR
- Include test coverage for new functionality
- Run `npm test` before submitting — all tests must pass
- Update docs if your change affects user-facing behavior

## Reporting Issues

Open an issue at [github.com/CharlesMulic/equip/issues](https://github.com/CharlesMulic/equip/issues) with:
- Equip version (`equip --version`)
- Node.js version (`node --version`)
- OS and platform(s) affected
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
