# Platform Expansion — Equip Beyond Developer Tools

**Goal:** Understand how LLMs are used across industries, where Equip can reach, and what changes are needed to serve non-developer audiences.

---

## The Scale Problem

Equip currently supports 13 platforms — all developer-oriented coding agents. Here's where those sit in the overall LLM usage landscape:

| Category | Monthly Active Users | Equip Coverage |
|----------|---------------------|----------------|
| **ChatGPT** (web + mobile) | 810M | None |
| **Google Gemini** (web + mobile) | 400M | None |
| **Microsoft 365 Copilot** (Word, Excel, Teams) | 7M+ seats | None |
| **Claude.ai** (web) | ~20M | None (no MCP in browser) |
| **Claude Desktop** (app) | Unknown (subset of 20M) | **Partial** (MCP via Desktop Extensions) |
| **Perplexity** | 22M | None |
| **Coding agents** (Cursor, Claude Code, Copilot, etc.) | ~5-10M | **Full coverage** |

**Equip's total addressable reach today: ~5-10M users out of ~1.3B+ total LLM interactions.** That's less than 1%.

The other 99% use LLMs through interfaces Equip can't touch.

---

## How LLMs Are Used by Industry

### Customer Service & Support (27.1% of LLM market)

**How they use it:** Chatbots, ticket routing, knowledge base search, response drafting
**Platforms:** Custom-built (API), Zendesk AI, Intercom, Salesforce Einstein
**Equip viability:** None — these are API integrations, not user-facing agent tools

### Healthcare ($1.5B+ spend, 36.8% CAGR)

**How they use it:**
- Clinical documentation (100% adoption activity) — ambient AI scribes (Abridge, deployed across Kaiser Permanente's 40 hospitals)
- Research and literature review
- Diagnosis support (19% success rate — still limited)

**Platforms:** Custom enterprise apps, Epic-integrated ambient AI, standalone clinical tools
**Equip viability:** None directly — these are closed, regulated platforms. However, if clinicians use Claude Desktop for research/admin tasks outside clinical systems, MCP augments could help.

### Legal ($195M ARR for Harvey alone, 42% Am Law 100)

**How they use it:**
- Document review and contract analysis (36.9 hrs/month saved for power users)
- Legal research and case analysis
- Due diligence
- Drafting briefs, motions, correspondence

**Platforms:** Harvey.ai (700 clients), CoCounsel (Thomson Reuters), Westlaw AI
**Equip viability:** None for the purpose-built legal platforms. But lawyers using general-purpose AI (ChatGPT, Claude) for drafting and research — potential if those platforms support MCP.

### Finance & Accounting ($4.73B in 2024, 41% CAGR)

**How they use it:**
- Tax preparation (TurboTax chatbot: 15% → 65% query share in 2 years)
- Expense reporting and accounts payable
- Risk detection (60% fewer anomalies in pilots)
- Financial modeling and forecasting
- Audit preparation (25-40% faster)

**Platforms:** SAP Joule, Oracle AI, TurboTax AI, custom enterprise agents, general-purpose LLMs
**Equip viability:** Low for enterprise platforms. Potential for accountants/advisors using Claude Desktop for analysis.

### Marketing & Sales

**How they use it:** Content creation, social media, SEO, lead generation, email outreach, audience analysis
**Platforms:** ChatGPT (most common), Claude, custom GPTs, HubSpot AI, various point tools
**Equip viability:** Moderate — marketers using Claude Desktop could benefit from MCP augments for research, SEO tools, content databases.

### Education ($7.05B in 2025 → $136.79B projected by 2035)

**How they use it:**
- 85% of K-12 teachers used AI in 2024-2025
- Tutoring, grading assistance, curriculum design
- 79% of teachers say AI saves time on grading

**Platforms:** ChatGPT (most common), Claude, various EdTech platforms
**Equip viability:** Low — teachers primarily use chat interfaces, not tools with MCP support.

### Real Estate

**How they use it:** Listing descriptions (46% of agents), market analysis (CMA in ~30 seconds), prospect research
**Platforms:** ChatGPT, various real estate AI tools
**Equip viability:** Low — mostly chat-based usage.

---

## Platform Categories & Equip Viability

### Category 1: Coding Agents (FULLY COVERED)

**Platforms:** Claude Code, Cursor, VS Code + Copilot, Windsurf, Cline, Roo Code, Codex, Gemini CLI, Junie, Copilot CLI, Amazon Q, Tabnine

**Users:** ~5-10M developers

**Equip capabilities:**

| Capability | Coverage | Notes |
|-----------|---------|-------|
| MCP | ✅ All 13 platforms | Config file per platform |
| Rules | ✅ 8 platforms | CLAUDE.md, global_rules.md, etc. |
| Hooks | ✅ 1 platform (Claude Code) | 12 lifecycle events |
| Skills | ✅ 9 platforms | SKILL.md directories |

**Status:** This is Equip's current strength. Fully covered, well-tested, production-ready.

### Category 2: Claude Desktop (PARTIALLY COVERED — HIGH POTENTIAL)

**Platform:** Claude Desktop app (macOS, Windows)

**Users:** Unknown subset of Claude's 20M users, but growing — Anthropic is pushing Desktop Extensions hard

**Three tabs with different capabilities:**

| Feature | Chat Tab | Code Tab | Cowork Tab |
|---------|----------|----------|-----------|
| **MCP tools** | Available but **manual** — user must explicitly ask | Full access (runs Claude Code) | **Proactive** — autonomously decides to use tools |
| **Behavioral rules** | None | CLAUDE.md (via Claude Code) | **Yes — Project-level CLAUDE.md** |
| **Tool invocation** | User-prompted | Agent-driven | Fully autonomous |
| **Best for** | Q&A, research | Coding | Multi-step task execution |

**Key finding: Cowork is the real opportunity, not Chat.** Chat mode requires users to manually prompt tool usage ("search Prior for X"), making MCP tools passive. Cowork runs autonomously, proactively uses connected MCP tools, and supports Projects with persistent CLAUDE.md instructions.

**MCP configuration:**
- Config file: `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- Uses `mcpServers` key (same as coding agents)
- **Only supports stdio transport** in config file — HTTP MCP servers require a bridge (`mcp-remote` or `npx @cg3/prior-mcp` as local stdio)
- Also supports Desktop Extensions (.mcpb bundles) for one-click install
- **Requires full app restart** after config changes (worse than coding agents)

**Equip capabilities:**

| Capability | Current | Potential | Notes |
|-----------|---------|-----------|-------|
| MCP (stdio) | ⚠️ Not covered yet | HIGH | Same `mcpServers` format, different config path. Direct registry addition. |
| MCP (HTTP) | ❌ | MEDIUM | Requires stdio bridge wrapper. Prior would use `npx @cg3/prior-mcp` as a local stdio server instead of direct HTTP. |
| Rules (global) | ❌ | LOW | No global CLAUDE.md for Desktop Chat. |
| Rules (project) | ❌ | **HIGH** | Cowork Projects support CLAUDE.md. Equip could create/manage project-level rules. |
| Skills | ❌ | LOW | Not supported in Desktop. |
| Hooks | ❌ | NONE | Not supported in Desktop. |

**The Cowork + Projects approach:**
1. Connect Prior MCP via stdio (`npx @cg3/prior-mcp`) in Desktop config
2. Create a Cowork Project with CLAUDE.md containing Prior's behavioral rules
3. In that Project context, Cowork proactively searches Prior on errors, contributes solutions
4. This is a different workflow than "write to a config file" — Equip would help set up the Project

**What Equip would need:**
1. Detect Claude Desktop installation (config path differs from Claude Code)
2. Write MCP entries to `claude_desktop_config.json` (stdio transport only)
3. For HTTP augments like Prior: use the npm MCP package as a stdio bridge
4. Optionally: create/manage Cowork Project directories with CLAUDE.md files
5. Handle the restart requirement (notify user that Desktop must be restarted)

**Priority: HIGH** — this is the single biggest expansion opportunity. MCP support is straightforward (same format, different path). The interesting part is Cowork Project integration.

### Broader Implication: Per-Project Instructions

Today Equip only targets **global** rules files (e.g., `~/.claude/CLAUDE.md`). But the research reveals that per-project behavioral instructions are increasingly important:

- **Claude Desktop Cowork**: Projects have their own CLAUDE.md
- **Claude Code**: Already supports project-level `.mcp.json` and directory-level CLAUDE.md
- **VS Code / Cursor**: Workspace-level settings override global

This opens a new dimension for Equip: **augments that carry project-scoped instructions**, not just global ones. An augment definition could include:

```json
{
  "rules": {
    "global": { "content": "## Prior\nSearch on every error...", "version": "0.6.0" },
    "project": { "content": "## Prior (Project)\nSearch Prior before investigating. Use tags: {project_tags}...", "version": "0.6.0" }
  }
}
```

The Equip app could then manage which rules go where:
- **Global rules**: Written to `~/.claude/CLAUDE.md` (current behavior)
- **Project rules**: Written to `{project_dir}/CLAUDE.md` or Cowork Project directories
- **Per-project augment configuration**: Different augments active for different projects (this is essentially what Sets are, but scoped to project directories)

This is a future enhancement, but the state architecture (`augments/` definitions + per-platform scan) already supports it. The augment definition just needs global vs project rule variants, and the Equip app needs a project selection UI.

**Tabled for now** — worth revisiting when we build the Equip page and Sets functionality.

### Category 3: ChatGPT (NOT COVERED — MASSIVE MARKET, NO PATH)

**Platform:** ChatGPT (web + mobile)
**Users:** 810M monthly active users
**MCP support:** None. ChatGPT uses its own plugin/GPT system, not MCP.
**Equip viability:** Zero — no extension mechanism Equip can integrate with.

**Unless:** OpenAI adopts MCP for ChatGPT (they've backed the standard for API/agent use but haven't brought it to the consumer chat interface). If they do, this becomes the single largest expansion opportunity.

### Category 4: Microsoft 365 Copilot (NOT COVERED — ENTERPRISE)

**Platform:** Word, Excel, PowerPoint, Outlook, Teams with AI
**Users:** 7M+ workplace seats, 92% Fortune 500
**Extension system:** Microsoft Graph Connectors, Copilot plugins (not MCP)
**Equip viability:** Zero currently — completely different extension model.

**Potential future:** If Microsoft adds MCP support to Copilot (they've backed the standard), Equip could manage Copilot extensions. But this is speculative.

### Category 5: Google Workspace AI (NOT COVERED — ENTERPRISE)

**Platform:** Docs, Sheets, Gmail, Meet with Gemini AI
**Users:** 400M Gemini users (not all Workspace)
**Extension system:** Google's own extension framework
**Equip viability:** Zero — no MCP support, different extension model.

### Category 6: Agent Frameworks (PARTIALLY VIABLE)

**Platforms:** LangChain, CrewAI, AutoGen, LangGraph
**Users:** Developers building custom agent systems (84% of devs working with AI agents)
**MCP support:** LangChain has MCP client support; others experimenting

**Equip viability:** Moderate — these are developer tools that consume MCP servers. If an agent framework supports MCP clients, Equip's MCP augments work. But the framework itself doesn't have a config file Equip manages — the developer writes code to connect to MCP servers.

**Potential:** An Equip SDK that agent framework users import to discover and connect to MCP servers programmatically. Different from config-file management.

### Category 7: Purpose-Built Vertical AI (NOT COVERED — CLOSED ECOSYSTEMS)

**Platforms:** Harvey.ai (legal), Abridge (healthcare), TurboTax AI, various enterprise
**Users:** Millions across industries
**Extension system:** Proprietary, closed
**Equip viability:** Zero — these platforms control their own AI capabilities. Users can't add extensions.

### Category 8: Browser-Based AI (NOT COVERED — EMERGING)

**Platforms:** Perplexity Comet (AI-native browser), AI browser extensions
**Users:** Growing (Perplexity 22M users, Comet browser is new)
**MCP support:** Unknown — Comet is Chromium-based, could potentially support extensions
**Equip viability:** Speculative — if AI browsers adopt MCP or extension protocols Equip understands.

---

## User Breakdown: Where Are the People?

```
Total LLM users: ~1.3B+ monthly interactions

├── Chat interfaces (ChatGPT, Gemini, Claude.ai, Perplexity)
│   ~1.2B users — Equip CANNOT reach these
│
├── Enterprise workspace AI (M365 Copilot, Google Workspace)
│   ~10M+ seats — Equip CANNOT reach these
│
├── Claude Desktop (with MCP support)
│   ~?M users — Equip COULD reach these (not yet supported)
│
├── Coding agents (IDE + CLI tools)
│   ~5-10M users — Equip FULLY covers these
│
├── Agent frameworks (developer-built)
│   ~2M+ developers — Equip PARTIALLY viable
│
├── Purpose-built vertical AI
│   ~?M users — Equip CANNOT reach these
│
└── Mobile AI apps
    ~500M+ downloads — Equip CANNOT reach these
```

---

## Expansion Priority Matrix

| Platform | Users Reachable | Effort | MCP Viable | Rules | Skills | Hooks | Priority |
|----------|----------------|--------|-----------|-------|--------|-------|----------|
| **Claude Desktop** | Unknown (M?) | Medium | Yes (Desktop Extensions) | No | No | No | **P0 — do this next** |
| **Agent frameworks** (LangChain etc.) | ~2M devs | Medium | Partial (SDK approach) | No | No | No | P1 — after Claude Desktop |
| **ChatGPT** (if MCP adopted) | 810M | Low (if MCP) | Speculative | No | No | No | P2 — watch and wait |
| **M365 Copilot** (if MCP adopted) | 7M+ seats | High | Speculative | No | No | No | P3 — watch and wait |
| **AI browsers** (Comet etc.) | Emerging | Unknown | Speculative | No | No | No | P4 — too early |

---

## Claude Desktop: The Bridge to Non-Developers

### Why This Matters

Claude Desktop with MCP support is Equip's best path to non-developer users:

1. **Same MCP protocol** — augments that work in Claude Code can work in Claude Desktop (if the MCP server is HTTP-based, not stdio)
2. **One-click install** — Desktop Extensions already solved the UX problem for non-technical users
3. **Growing user base** — Anthropic is actively pushing Claude Desktop as the general-purpose AI tool
4. **Real use cases beyond coding:**
   - Researcher connects Google Drive + Notion via MCP → searches across both from Claude
   - Marketer connects SEO tool + analytics via MCP → gets insights without switching apps
   - Analyst connects database + visualization tool via MCP → queries data conversationally
   - Manager connects Slack + calendar + project management via MCP → daily briefings

### What Equip Would Need

1. **Detection:** Add Claude Desktop to the platform registry
   - Config location: `~/Library/Application Support/Claude/` (macOS), `%APPDATA%/Claude/` (Windows)
   - Extension format: `.mcpb` bundles or config JSON (research needed)

2. **Install mechanism:** Understand how Desktop Extensions are registered
   - Are they in a JSON config file like coding agents?
   - Or are they installed via a different mechanism (app store-like)?

3. **UI adaptation:** The Equip app needs to work for non-developers
   - No mention of "MCP servers" — call them "augments" or "extensions"
   - No config file paths visible by default
   - One-click equip, not drag-and-drop from a technical grid
   - Categories that non-developers understand: "Productivity", "Research", "Communication" not "HTTP transport", "stdio"

4. **Augment discovery:** The Discover tab needs non-developer augments
   - Google Drive integration
   - Slack integration
   - Calendar management
   - Web search augments
   - File management tools

### What's Different About Non-Developer Users

| Concern | Developer | Non-Developer |
|---------|-----------|---------------|
| **Terminology** | MCP, transport, hooks, config | "Connect to Google Drive", "Add Slack" |
| **Carry weight** | Token budget optimization | "Your AI might be slow if you add too many" |
| **Rarity** | Gamification, community trust | Confusing — simpler "verified" badge |
| **Sets** | "Python Backend" vs "Frontend" | "Work" vs "Personal" |
| **Error handling** | Show error codes, stack traces | "Something went wrong. Try again?" |
| **Install friction** | Acceptable: CLI, config files | Unacceptable: must be one-click |

---

## Industry-Specific Augments (Future Registry Content)

If Equip expands beyond coding, what augments would non-developers want?

### Research & Analysis
- Academic paper search
- Citation management
- Data extraction from PDFs
- Statistical analysis tools
- Web scraping / research assistants

### Business & Productivity
- Google Drive / OneDrive file access
- Slack / Teams messaging
- Calendar management
- Email drafting and sending
- CRM data access (Salesforce, HubSpot)
- Project management (Jira, Asana, Linear)

### Finance & Accounting
- Financial data feeds (market data, SEC filings)
- Spreadsheet analysis tools
- Tax code reference
- Invoice processing
- Budget tracking

### Legal
- Case law search
- Contract template libraries
- Regulatory compliance checking
- Document comparison

### Content & Marketing
- SEO analysis tools
- Social media scheduling
- Image generation / editing
- Content calendar management
- Analytics dashboards

---

## Key Takeaways

1. **Equip's current market (coding agents) is less than 1% of LLM usage.** This is fine for now — it's the most technically sophisticated audience and the best place to prove the product. But it's not the whole story.

2. **Claude Desktop is the expansion bridge.** Same MCP protocol, growing user base, Anthropic is investing in it. This is the highest-leverage platform to add next.

3. **The non-developer UX is different.** Terminology, error handling, onboarding, and discovery all need to be adapted. The RPG gamification (rarity, weight, sets) may need to be toned down or reframed for general audiences.

4. **ChatGPT and M365 Copilot are inaccessible** without MCP adoption by those platforms. This is out of Equip's control but worth monitoring — if either adopts MCP, the addressable market explodes.

5. **Purpose-built vertical AI (Harvey, Abridge, etc.) is permanently out of reach.** These are closed ecosystems. Equip's value is in open, extensible platforms.

6. **The MCP standard itself is the rising tide.** 97M+ monthly SDK downloads, backed by Anthropic, OpenAI, Google, Microsoft, donated to Linux Foundation. As MCP adoption grows, Equip's reach grows automatically — without needing to add platform-specific support for each new tool.
