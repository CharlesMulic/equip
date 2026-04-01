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

**What's available:**
- MCP support via Desktop Extensions (one-click install, .mcpb bundles)
- Extensions already exist for: Google Drive, Slack, GitHub, Notion
- Remote MCP servers for Pro/Max/Team/Enterprise users
- General-purpose, not coding-specific — used by marketers, researchers, analysts, etc.

**Equip capabilities:**

| Capability | Current | Potential |
|-----------|---------|-----------|
| MCP | ⚠️ Not covered yet | HIGH — Desktop Extensions use a different install mechanism (.mcpb bundles) but the concept is identical. Equip could manage Desktop Extensions. |
| Rules | ❌ No rules file for Claude Desktop | LOW — Claude Desktop doesn't have a CLAUDE.md equivalent. Instructions go through the Project knowledge or system prompt. |
| Hooks | ❌ Not applicable | None — Claude Desktop has no hook system |
| Skills | ❌ Not applicable | None — Claude Desktop doesn't have skills |

**The opportunity:** Claude Desktop is the bridge to non-developers. Adding support would open Equip to researchers, analysts, marketers, and knowledge workers who use Claude Desktop with MCP extensions for Google Drive, Slack, database access, etc.

**What Equip would need:**
1. Detect Claude Desktop installation
2. Understand the Desktop Extensions config format
3. Install/uninstall MCP extensions via the same mechanism Desktop Extensions use
4. The Equip app's augment cards would work for non-technical users — "click to equip" is simpler than understanding MCP config JSON

**Priority: HIGH** — this is the single biggest expansion opportunity with minimal architectural changes.

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
