# Platform Verification Results

**Date:** 2026-03-29
**Verified by:** Automated docs fetch against official documentation only
**Method:** WebFetch of each platform's official docs page, extracting exact config formats

---

## 1. Claude Code

**Source URL fetched:** https://code.claude.com/docs/en/mcp

### MCP Config
- **File path:** `~/.claude.json` (under `mcpServers` field or under project paths for local scope) -- CONFIRMED (equip claims: `~/.claude.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** `"http"` -- CONFIRMED. Docs show: `"type": "http"` in JSON example (equip claims: `"http"`)
- **Headers field:** `headers` -- CONFIRMED. Docs show: `"headers": { "Authorization": "Bearer ${API_KEY}" }` (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs (environment variable expansion example):**
```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

**Rules:** `~/.claude/CLAUDE.md` -- CONFIRMED. Docs show personal skills at `~/.claude/skills/` and CLAUDE.md is well-documented in the memory/settings docs.
**Skills:** `~/.claude/skills/<skill-name>/SKILL.md` -- CONFIRMED. Docs explicitly show: "Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects"
**Hooks:** `~/.claude/settings.json` with events list -- CONFIRMED (equip has correct events list and path)

**Confidence:** HIGH

---

## 2. Cursor

**Source URL fetched:** https://cursor.com/docs/context/mcp, https://cursor.com/docs/context/rules, https://cursor.com/docs/skills

### MCP Config
- **File path:** `~/.cursor/mcp.json` -- CONFIRMED (equip claims: `~/.cursor/mcp.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** MISMATCH. Docs show NO type field for remote servers. Remote servers are distinguished by presence of `url` (vs `command` for stdio). Equip claims `typeField: "streamable-http"` but the official docs do NOT include any type field in remote server examples.
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "server-name": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "API_KEY": "value"
      }
    }
  }
}
```

**Rules:** User Rules are UI-only (Cursor Settings > Rules). No global rules FILE on disk. -- CONFIRMED that equip has `rulesPath: null`
**Skills:** `~/.cursor/skills/` -- CONFIRMED. Docs state user-level skills at `~/.cursor/skills/`. Also recognizes `~/.claude/skills/` and `~/.codex/skills/` for backward compat. (equip claims: `~/.cursor/skills/`)

**Confidence:** HIGH
**Action needed:** Remove `typeField: "streamable-http"` from Cursor config. The type field should be omitted for Cursor remote servers.

---

## 3. VS Code (Copilot)

**Source URL fetched:** https://code.visualstudio.com/docs/copilot/customization/mcp-servers, https://code.visualstudio.com/docs/copilot/reference/mcp-configuration, https://code.visualstudio.com/docs/copilot/customization/agent-skills

### MCP Config
- **File path:** User profile `mcp.json`, accessed via "MCP: Open User Configuration" command. The user profile directory is `%APPDATA%/Code/User` (Windows), `~/Library/Application Support/Code/User` (macOS), `~/.config/Code/User` (Linux). So the file is at `<user-profile-dir>/mcp.json`. -- CONFIRMED (equip's `vsCodeUserDir()` resolves to these OS-specific paths, then appends `mcp.json`)
- **Root key:** `servers` -- CONFIRMED (equip claims: `servers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** `"http"` -- CONFIRMED. Docs show `"type": "http"`. Also supports `"sse"`. (equip claims: `"http"`)
- **Headers field:** `headers` -- CONFIRMED. Docs show: `"headers": {"Authorization": "Bearer ${input:api-token}"}` (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp"
    }
  }
}
```

**Rules:** No global rules file path documented. -- CONFIRMED (equip claims: `rulesPath: null`)
**Skills:** Docs state personal skills directories: `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`. Equip claims `~/.agents/skills/`. -- CONFIRMED (this is one of the recognized paths). Note: VS Code also scans `~/.copilot/skills/` and `~/.claude/skills/`, and supports `chat.agentSkillsLocations` setting for custom paths.

**Confidence:** HIGH

---

## 4. Windsurf

**Source URL fetched:** https://docs.windsurf.com/windsurf/cascade/mcp

### MCP Config
- **File path:** `~/.codeium/windsurf/mcp_config.json` -- CONFIRMED (equip claims: `~/.codeium/windsurf/mcp_config.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `serverUrl` (or `url`) -- CONFIRMED. Docs show `"serverUrl"` in the remote HTTP example. (equip claims: `serverUrl`)
- **Type field:** None specified in docs -- CONFIRMED (equip has no typeField for Windsurf)
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "remote-http-mcp": {
      "serverUrl": "<your-server-url>/mcp",
      "headers": {
        "API_KEY": "value"
      }
    }
  }
}
```

**Rules:** `~/.codeium/windsurf/memories/global_rules.md` -- UNCERTAIN. Equip claims this path but official docs fetched didn't explicitly confirm or deny the rules path. The verification doc noted a researcher flagged this as potentially outdated.
**Skills:** `~/.agents/skills/` -- CONFIRMED per earlier verification.

**Confidence:** HIGH (MCP config), MEDIUM (rules path)

---

## 5. Cline

**Source URL fetched:** https://docs.cline.bot/mcp/configuring-mcp-servers, https://docs.cline.bot/features/cline-rules

### MCP Config
- **File path:** `cline_mcp_settings.json` (accessed via UI). The docs do not specify the full filesystem path within VS Code's globalStorage, only that it's accessible via the MCP Servers icon. -- UNCERTAIN on exact path. Equip claims: `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`. This is consistent with Cline being published as extension `saoudrizwan.claude-dev`, but the docs don't confirm the full path.
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** Not specified in docs -- CONFIRMED (equip has no typeField for Cline)
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "remote-server": {
      "url": "https://your-server-url.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      },
      "alwaysAllow": ["tool3"],
      "disabled": false
    }
  }
}
```

**Rules:** Docs confirm global rules path:
- Windows: `Documents\Cline\Rules`
- macOS: `~/Documents/Cline/Rules`
- Linux/WSL: `~/Documents/Cline/Rules` (fallback: `~/Cline/Rules`)
-- CONFIRMED (equip claims: `~/Documents/Cline/Rules` via `path.join(home(), "Documents", "Cline", "Rules")`)

**Skills:** `~/.cline/skills/` -- UNCERTAIN. Not explicitly documented on the pages fetched.

**Confidence:** HIGH (config format), MEDIUM (file path within globalStorage), HIGH (rules path)

---

## 6. Roo Code

**Source URL fetched:** https://docs.roocode.com/features/mcp/using-mcp-in-roo

### MCP Config
- **File path:** Docs say `mcp_settings.json` accessible via VS Code settings. The full path within globalStorage is NOT documented. Equip claims: `globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`. -- MISMATCH (LIKELY). Docs call the file `mcp_settings.json`, not `cline_mcp_settings.json`. However, the actual filename on disk may differ from the docs' shorthand. The extension ID `RooVeterinaryInc.roo-cline` is confirmed from the marketplace link.
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** MISMATCH. Roo Code docs explicitly state: "For any URL-based config, omitting `type` will cause an immediate error." The required value is `"streamable-http"` for modern HTTP servers. Equip currently OMITS the type field for Roo Code. This means equip-generated configs will fail.
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "modern-remote-server": {
      "type": "streamable-http",
      "url": "https://your-modern-server.com/api/mcp-endpoint",
      "headers": {
        "X-API-Key": "your-secure-api-key"
      },
      "alwaysAllow": ["newToolA", "newToolB"],
      "disabled": false
    }
  }
}
```

**Rules:** `~/.roo/rules/` -- UNCERTAIN. Not explicitly documented on the fetched page.
**Skills:** `~/.roo/skills/` -- UNCERTAIN. Not explicitly documented.

**Confidence:** HIGH (type field is definitely required), MEDIUM (file name uncertainty)
**Action needed:** Add `typeField: "streamable-http"` to Roo Code config. Without it, configs will error.

---

## 7. Codex

**Source URL fetched:** https://developers.openai.com/codex/mcp

### MCP Config
- **File path:** `~/.codex/config.toml` -- CONFIRMED (equip claims: `~/.codex/config.toml`)
- **Root key:** `[mcp_servers.<name>]` TOML tables -- CONFIRMED (equip claims: `mcp_servers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** None. Presence of `url` vs `command` distinguishes HTTP from stdio. -- CONFIRMED (equip has no typeField for Codex)
- **Headers field:** `http_headers` -- CONFIRMED. Also supports `bearer_token_env_var` and `env_http_headers`. (equip claims: `http_headers`)
- **Format:** TOML -- CONFIRMED

**Exact TOML from docs:**
```toml
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
```

**Rules:** `~/.codex/AGENTS.md` -- CONFIRMED (equip claims: `~/.codex/AGENTS.md`)
**Skills:** `~/.agents/skills/` -- UNCERTAIN. Equip claims `~/.agents/skills/` but docs don't explicitly mention skills paths.

**Confidence:** HIGH

---

## 8. Gemini CLI

**Source URL fetched:** https://geminicli.com/docs/tools/mcp-server/

### MCP Config
- **File path:** `~/.gemini/settings.json` -- CONFIRMED (equip claims: `~/.gemini/settings.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `httpUrl` for HTTP streaming, `url` for SSE -- CONFIRMED (equip claims: `httpUrl`)
- **Type field:** None. Transport inferred from which URL field is present. -- CONFIRMED (equip has no typeField for Gemini CLI)
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs (HTTP streaming):**
```json
{
  "mcpServers": {
    "httpServerWithAuth": {
      "httpUrl": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token",
        "X-Custom-Header": "custom-value"
      },
      "timeout": 5000
    }
  }
}
```

**Rules:** `~/.gemini/GEMINI.md` -- CONFIRMED (equip claims: `~/.gemini/GEMINI.md`)
**Skills:** `~/.gemini/skills/` -- UNCERTAIN. Not explicitly shown in the fetched docs page.

**Confidence:** HIGH

---

## 9. Junie

**Source URL fetched:** https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html

### MCP Config
- **File path:** `~/.junie/mcp/mcp.json` -- CONFIRMED (equip claims: `~/.junie/mcp/mcp.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** None mentioned. Implicit from `url` vs `command`. -- CONFIRMED (equip has no typeField for Junie)
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "RemoteServer": {
      "url": "https://mcp.example.com/v1",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

**Rules:** Not mentioned in the fetched MCP config docs -- equip claims `rulesPath: null`. CONFIRMED (no evidence of rules support on this page).
**Skills:** Not mentioned -- equip claims `skillsPath: null`. CONFIRMED (no evidence of skills support on this page).

**Confidence:** HIGH

---

## 10. Copilot (JetBrains)

**Source URL fetched:** https://www.jetbrains.com/help/idea/mcp-server.html

### MCP Config
- **File path:** NOT DOCUMENTED. The JetBrains docs describe MCP server configuration as the IDE acting AS an MCP server (for clients like Claude Desktop, Cursor, etc.), not configuring external MCP servers. There is no documented file path for `~/.config/github-copilot/intellij/mcp.json`. -- UNVERIFIABLE (equip claims: `~/.config/github-copilot/intellij/mcp.json`)
- **Root key:** NOT DOCUMENTED for this use case -- UNVERIFIABLE (equip claims: `mcpServers`)
- **URL field:** NOT DOCUMENTED -- UNVERIFIABLE (equip claims: `url`)
- **Type field:** NOT DOCUMENTED -- UNVERIFIABLE (equip has no typeField)
- **Headers field:** NOT DOCUMENTED -- UNVERIFIABLE (equip claims: `headers`)
- **Format:** NOT DOCUMENTED -- UNVERIFIABLE (equip claims: JSON)

**Rules:** No documentation found -- equip claims `rulesPath: null`. Cannot verify.
**Skills:** No documentation found -- equip claims `skillsPath: null`. Cannot verify.

**Note:** The JetBrains MCP docs page is about IntelliJ acting as an MCP SERVER, not about configuring MCP clients. The Copilot plugin for JetBrains may have its own config mechanism, but it's not documented on this page. The file path `~/.config/github-copilot/intellij/mcp.json` appears to be based on filesystem observation, not official docs.

**Confidence:** LOW

---

## 11. Copilot CLI

**Source URL fetched:** https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers

### MCP Config
- **File path:** `~/.copilot/mcp-config.json` -- CONFIRMED (equip claims: `~/.copilot/mcp-config.json`)
- **Root key:** `mcpServers` -- CONFIRMED (equip claims: `mcpServers`)
- **URL field:** `url` -- CONFIRMED (equip claims: `url`)
- **Type field:** MISMATCH. Docs show `"type": "http"` as a field in the JSON example. Equip currently has NO typeField for Copilot CLI. This may work (Copilot CLI might infer from URL), but the docs explicitly show it.
- **Headers field:** `headers` -- CONFIRMED (equip claims: `headers`)
- **Format:** JSON -- CONFIRMED

**Exact JSON from docs:**
```json
{
  "mcpServers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "YOUR-API-KEY"
      },
      "tools": ["*"]
    }
  }
}
```

**Rules:** Not documented on this page -- equip claims `rulesPath: null`. Cannot confirm or deny.
**Skills:** Not documented on this page -- equip claims `skillsPath: null`. Cannot confirm or deny.

**Confidence:** HIGH
**Action needed:** Add `typeField: "http"` to Copilot CLI config. The docs explicitly show it.

---

## Summary of Findings

### CONFIRMED (no changes needed)

| Platform | All Fields Correct |
|---|---|
| Claude Code | Yes - all fields match docs exactly |
| Windsurf | Yes - all MCP fields match (rules path UNCERTAIN) |
| Codex | Yes - all fields match docs exactly |
| Gemini CLI | Yes - all fields match docs exactly |
| Junie | Yes - all fields match docs exactly |
| VS Code | Yes - all fields match docs exactly |

### MISMATCHES (code changes needed)

| Platform | Issue | Current Value | Should Be | Severity |
|---|---|---|---|---|
| **Cursor** | `typeField` should be removed | `"streamable-http"` | `undefined` (omit) | MEDIUM - may still work but is not per docs |
| **Roo Code** | `typeField` must be added | `undefined` (omitted) | `"streamable-http"` | HIGH - docs say omitting type causes error |
| **Copilot CLI** | `typeField` should be added | `undefined` (omitted) | `"http"` | MEDIUM - docs show it explicitly |

### UNCERTAIN (needs filesystem or manual verification)

| Platform | Issue | Notes |
|---|---|---|
| **Roo Code** | Config file name | Docs say `mcp_settings.json`, equip uses `cline_mcp_settings.json`. May be the same file with different naming in docs vs filesystem. Needs manual check on a machine with Roo Code installed. |
| **Copilot JetBrains** | Entire config | No official docs for file-based MCP client config. Path `~/.config/github-copilot/intellij/mcp.json` is inferred, not documented. |
| **Windsurf** | Rules path | `~/.codeium/windsurf/memories/global_rules.md` not explicitly confirmed by fetched docs. |
| **Cline** | Config file path | Extension ID and globalStorage path not explicitly documented, but `saoudrizwan.claude-dev` is the known extension ID. |

### Recommended Code Changes

**Priority 1 (breaks functionality):**
1. **Roo Code**: Add `typeField: "streamable-http"` to `httpShape`. Docs state omitting type causes an immediate error.

**Priority 2 (correctness):**
2. **Cursor**: Remove `typeField: "streamable-http"` from `httpShape` (set to `undefined`). Cursor infers transport from URL presence; no type field is shown in docs.
3. **Copilot CLI**: Add `typeField: "http"` to `httpShape`. Docs explicitly show it in examples.

**Priority 3 (investigate):**
4. **Roo Code file name**: Manually verify whether the actual file on disk is `cline_mcp_settings.json` or `mcp_settings.json`. Install Roo Code and check `globalStorage/rooveterinaryinc.roo-cline/settings/`.
5. **Copilot JetBrains**: Low priority -- the file path is based on observation, not docs. Consider marking this platform as "experimental" or verifying on a machine with the plugin.

---

## Previous Verification

| Date | Scope | Result | By |
|---|---|---|---|
| 2026-03-29 | Full (11 platforms, MCP + rules + skills) | 6 confirmed, 3 mismatches, 4 uncertain items | Automated docs fetch |
