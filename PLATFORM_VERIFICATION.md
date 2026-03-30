# Platform Verification Log

Track the accuracy of equip's platform support claims. Run verification periodically (monthly or before major releases) and after any platform announces config changes.

## Verification Process

1. For each platform, search for the **official documentation** (not blog posts, not tutorials)
2. Find the **canonical page** for MCP server configuration
3. Record the URL and date accessed
4. Compare against equip's `src/lib/platforms.ts` registry values
5. Flag any discrepancies as MISMATCH
6. Update this document with findings
7. If a MISMATCH is confirmed, create a code fix with tests

### Where to look

| Platform | Official Docs URL |
|---|---|
| Claude Code | https://code.claude.com/docs/en/mcp |
| Cursor | https://cursor.com/docs/context/mcp |
| VS Code / Copilot | https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
| Windsurf | https://docs.windsurf.com/windsurf/cascade/mcp |
| Cline | https://docs.cline.bot/mcp/configuring-mcp-servers |
| Roo Code | https://docs.roocode.com/features/mcp/using-mcp-in-roo |
| Codex | https://developers.openai.com/codex/mcp |
| Gemini CLI | https://geminicli.com/docs/tools/mcp-server/ |
| Junie | https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html |
| Copilot (JetBrains) | https://www.jetbrains.com/help/idea/mcp-server.html |
| Copilot CLI | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers |

### What to verify per platform

- [ ] Config file path (global/user level)
- [ ] Root key (mcpServers, servers, mcp_servers)
- [ ] URL field name for HTTP servers
- [ ] Type field value (if any)
- [ ] Auth headers field name
- [ ] Config format (JSON, TOML)
- [ ] Rules path (global/user level)
- [ ] Skills path (global/user level)
- [ ] Hook support and events (if any)

---

## Latest Verification: 2026-03-29

### MCP Config

| Platform | Equip Claim | Status | Source | Notes |
|---|---|---|---|---|
| **Claude Code** | `~/.claude.json`, `mcpServers`, `url`, `type: "http"`, `headers`, JSON | CONFIRMED | code.claude.com/docs/en/mcp | |
| **Cursor** | `~/.cursor/mcp.json`, `mcpServers`, `url`, `type: "streamable-http"`, `headers`, JSON | NEEDS REVIEW | cursor.com/docs/context/mcp | One researcher claims no type field for remote HTTP servers. Earlier research (2026-03-29) confirmed `streamable-http`. Cursor docs may have changed or researchers may disagree. **Action: manually verify by checking Cursor docs directly.** |
| **VS Code / Copilot** | `Code/User/mcp.json`, `servers`, `url`, `type: "http"`, `headers`, JSON | NEEDS REVIEW | code.visualstudio.com/docs | Path is the user-level config (not project-level `.vscode/mcp.json`). One researcher flagged the path as wrong — they may have been looking at project-level only. Our `getVsCodeMcpPath()` resolves the OS-specific user-level path. `servers` root key confirmed by all researchers. **Action: verify user-level path still exists.** |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json`, `mcpServers`, `serverUrl`, `headers`, JSON | CONFIRMED | docs.windsurf.com | Note: Windsurf also accepts `url` alongside `serverUrl`. Our code uses `serverUrl` which is correct. |
| **Cline** | `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, `mcpServers`, `url`, `headers`, JSON | CONFIRMED | docs.cline.bot | |
| **Roo Code** | `globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`, `mcpServers`, `url`, `headers`, JSON | CONFIRMED | docs.roocode.com | Extension ID `rooveterinaryinc.roo-cline` confirmed current. One researcher noted remote servers may use a `type` field — our code omits it, which may still work. |
| **Codex** | `~/.codex/config.toml`, `mcp_servers`, `url`, `http_headers`, TOML | CONFIRMED | developers.openai.com/codex | Also supports `env_http_headers` and `bearer_token_env_var`. |
| **Gemini CLI** | `~/.gemini/settings.json`, `mcpServers`, `httpUrl`, `headers`, JSON | CONFIRMED | geminicli.com/docs | `httpUrl` for HTTP streaming, `url` for SSE. Our code correctly uses `httpUrl`. |
| **Junie** | `~/.junie/mcp/mcp.json`, `mcpServers`, `url`, `headers`, JSON | CONFIRMED | junie.jetbrains.com/docs | |
| **Copilot (JetBrains)** | `~/.config/github-copilot/intellij/mcp.json`, `mcpServers`, `url`, `headers`, JSON | UNVERIFIABLE | jetbrains.com/help/idea/mcp-server.html | Official docs use GUI-based configuration. File path inferred from filesystem observation, not documented. **Action: test on a machine with the plugin installed.** |
| **Copilot CLI** | `~/.copilot/mcp-config.json`, `mcpServers`, `url`, `headers`, JSON | CONFIRMED | docs.github.com | |

### Rules Paths

| Platform | Equip Claim | Status | Notes |
|---|---|---|---|
| **Claude Code** | `~/.claude/CLAUDE.md` (append) | CONFIRMED | |
| **Cursor** | No global rules (clipboard only) | NEEDS REVIEW | Cursor reportedly added global rules via Settings UI in 2026. If true, equip could write rules there instead of clipboard. **Action: verify if there's a writable rules FILE (not just UI settings).** |
| **VS Code / Copilot** | No global rules (clipboard only) | LIKELY CORRECT | No home-directory global rules file documented. Organization-level only. |
| **Windsurf** | `~/.codeium/windsurf/memories/global_rules.md` (append) | NEEDS REVIEW | One researcher suggests the `memories/` subdirectory path may be outdated. **Action: verify on a machine with Windsurf installed.** |
| **Cline** | `~/Documents/Cline/Rules/` (standalone files) | NEEDS REVIEW | One researcher claims actual path is `~/.clinerules` or `~/.clinerules/`. This may be a newer convention. **Action: check Cline docs for current global rules path.** |
| **Roo Code** | `~/.roo/rules/` (standalone files) | UNVERIFIABLE | Not explicitly documented in official docs. May work by convention. |
| **Codex** | `~/.codex/AGENTS.md` (append) | CONFIRMED | |
| **Gemini CLI** | `~/.gemini/GEMINI.md` (append) | CONFIRMED | |
| **Junie** | No rules support | NEEDS REVIEW | Junie reportedly added guidelines support (`.junie/guidelines.md`) in March 2026. **Action: verify and consider adding support.** |
| **Copilot (JetBrains)** | No rules support | NEEDS REVIEW | Now supports `.github/copilot-instructions.md`. May only be project-level. **Action: verify if there's a global/user-level rules path.** |
| **Copilot CLI** | No rules support | NEEDS REVIEW | Reportedly supports config-based rules. Format may be TOML, not markdown. **Action: verify format and path.** |

### Skills Paths

| Platform | Equip Claim | Status | Notes |
|---|---|---|---|
| **Claude Code** | `~/.claude/skills/` | CONFIRMED | |
| **Cursor** | `~/.cursor/skills/` | CONFIRMED | |
| **VS Code / Copilot** | `~/.agents/skills/` | NEEDS REVIEW | One researcher claims `~/.github/skills/` is the primary path, with `~/.agents/skills/` as cross-platform alias. **Action: verify which paths VS Code actually scans.** |
| **Windsurf** | `~/.agents/skills/` | CONFIRMED | Also scans `.windsurf/skills/` at project level. |
| **Cline** | `~/.cline/skills/` | CONFIRMED | |
| **Roo Code** | `~/.roo/skills/` | CONFIRMED | |
| **Codex** | `~/.agents/skills/` | NEEDS REVIEW | One researcher claims `~/.codex/skills/` is the actual path. **Action: verify.** |
| **Gemini CLI** | `~/.gemini/skills/` | CONFIRMED | |
| **Junie** | null (no support) | NEEDS REVIEW | Junie reportedly added skills support March 2026. **Action: verify and add skillsPath if confirmed.** |
| **Copilot (JetBrains)** | null (no support) | NEEDS REVIEW | Reportedly supports skills at `~/.copilot/skills/`. **Action: verify.** |
| **Copilot CLI** | null (no support) | NEEDS REVIEW | Reportedly supports skills at `~/.copilot/skills/`. **Action: verify.** |

---

## Action Items from This Verification

### Priority 1 (verify before next release)

- [ ] **Cursor type field**: Does `type: "streamable-http"` work? Or has Cursor dropped the type field for HTTP? Load cursor.com/docs/context/mcp and check the exact JSON example.
- [ ] **Cline rules path**: Is it still `~/Documents/Cline/Rules/` or has it moved to `~/.clinerules`? Load docs.cline.bot and check.
- [ ] **VS Code user-level MCP path**: Confirm `Code/User/mcp.json` is still the user-level config path (not just `.vscode/mcp.json`).

### Priority 2 (expand coverage)

- [ ] **Cursor global rules**: If Cursor now has a writable global rules file, add `rulesPath` to the platform registry.
- [ ] **Junie rules + skills**: If confirmed, add `rulesPath` and `skillsPath` to the Junie registry entry.
- [ ] **Copilot JetBrains rules + skills**: If confirmed, add paths.
- [ ] **Copilot CLI rules + skills**: If confirmed, add paths.
- [ ] **VS Code skills path**: Verify if `~/.github/skills/` or `~/.agents/skills/` is primary.
- [ ] **Codex skills path**: Verify if `~/.codex/skills/` or `~/.agents/skills/` is correct.

### Priority 3 (edge cases)

- [ ] **Windsurf rules path**: Verify `memories/global_rules.md` subdirectory is still current.
- [ ] **Roo Code rules**: Verify `~/.roo/rules/` actually works (not documented).
- [ ] **Copilot JetBrains MCP path**: Verify `~/.config/github-copilot/intellij/mcp.json` (not documented, inferred).

---

## Previous Verifications

*(Record previous checks here with dates for audit trail)*

| Date | Scope | Result | By |
|---|---|---|---|
| 2026-03-29 | Full verification (all 11 platforms, all artifact types) | 6 confirmed, 5 need review | Initial audit |
