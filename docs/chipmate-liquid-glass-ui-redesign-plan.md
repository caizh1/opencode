# ChipMate Liquid Glass UI Redesign Plan

Date: 2026-06-10

Local visual preview:

![ChipMate Liquid Glass preview](/Users/archer/.codex/generated_images/019eb015-a184-73d1-b688-309b279fa487/ig_03c4dd0ae69e7d5d016a29071f92008191b71ad0fb8557140b.png)

## Goal

Redesign the ChipMate VS Code extension sidebar into an iOS 26/27 inspired Liquid Glass control surface for a local coding assistant.

The redesign must be grounded in the current running VS Code extension UI and the current codebase. It should not invent unrelated product features, should not weaken the existing completion or retrieval pipeline, and should keep the extension positioned as an independent product named ChipMate.

## Confirmed Product Decisions

- Product name remains `ChipMate`.
- ChipMate should be treated as independent from opencode; future repository split is expected.
- The extension keeps one contributed VS Code webview: `chipmate.sidebar`.
- The default entry screen is `Chat`, not a separate overview page.
- The top of Chat includes a compact overview/status strip instead of a standalone overview module.
- The main modules are all visible by default:
  - `Chat`
  - `Models`
  - `Knowledge`
  - `Skills`
  - `MCP`
- A global gear/settings panel exists, but it only holds cross-module settings, diagnostics, and light preferences.
- Module-specific configuration belongs inside each module.
- `Skills` and `MCP` are separate concepts and separate UI modules.
- The Output channel is a diagnostics/log entry, not chat history.
- Chat history belongs inside the Chat module as a session selector or drawer.
- Composer permissions follow a Codex-like model chip near the prompt box.
- The permission chip is initially a shortcut for the global `chipmate.permissions.profile` setting, not per-session state.

## Visual Direction

- Style: iOS 26/27 Liquid Glass.
- Base material: frosted graphite glass over VS Code theme colors.
- Accent: Apple system blue style (`#007AFF` / `#0A84FF`) used sparingly.
- Status colors:
  - green for ready/success
  - amber/orange for warning/degraded
  - red for blocked/error/danger
- Avoid:
  - large fixed blue/cyan/purple gradients
  - neon effects
  - beige/brown/sand palettes
  - generic flat web cards
  - card-inside-card layouts
  - decorative blobs/orbs
- Typography:
  - use VS Code font variables
  - system-like hierarchy through size, weight, spacing
  - tabular numeric progress where possible
- Icons:
  - use a local, redistributable SF-like icon layer
  - do not bundle Apple SF Symbols resources directly
  - avoid rough hand-drawn temporary SVGs
  - icon groups must use flex/grid/inline-flex layout, not `position: absolute`
- Information should be icon-first:
  - progress rings
  - status dots
  - compact badges
  - progress bars
  - hover/title or expandable details for verbose text

## Current UI Problems To Fix

- The current `Skills` tab contains model configuration.
- The composer is global, so it appears under non-chat screens.
- The history-looking icon opens Output logs.
- The current UI has only two top-level tabs and does not represent the real product modules.
- CodeGraph, RAG, context, and hybrid retrieval status exist in service state but are not meaningfully visible.
- Skills and MCP packages are mixed visually even though the catalog distinguishes `type: "skill"` and `type: "mcp"`.

## Data And Capability Facts From Current Code

### Skills And MCP Installation

Current installation is catalog-based, not marketplace-based.

- Catalog URL comes from `chipmate.skills.catalogUrl`.
- Catalog packages have `type: "skill" | "mcp"`, `downloadUrl`, `sha256`, version, description, and dependencies.
- Install flow:
  - fetch catalog
  - download zip
  - verify size and sha256
  - extract safely
  - write manifest under extension global storage
- Installed packages live under:
  - `context.globalStorageUri/packages/skills/<id>`
  - `context.globalStorageUri/packages/mcps/<id>`
- Skill packages must contain `SKILL.md` at package root or inside a single top-level folder.
- MCP packages must provide `mcp.json` for stdio runtime probing.

### Context, CodeGraph, RAG, And Hybrid Retrieval

The UI should expose these as visible status, but the implementation must not rewrite the retrieval algorithms.

- Chat context already records context summaries through `onContextSummary`.
- CodeGraph status already exposes:
  - state
  - indexed files/functions/macros
  - queue
  - active job
  - progress
  - metrics
- RAG status already exposes:
  - availability
  - chunks
  - embedded chunks
  - pending chunk count
  - worker status
  - vector shards
  - endpoint kind
  - rerank status
  - resume schedule
- Hybrid retrieval remains part of the existing service path:
  - `LocalCodeGraphService.hybridOptions()` connects graph, vector index, embedding provider, and rerank provider.
  - QA/repository evidence first requests `retrievalMode: "hybrid"`.
  - fallback remains `graph-only` when hybrid times out or is unavailable.
  - semantic retrieval can run hybrid and graph-only branches together.

## Module Design

### Chat

Purpose: primary daily interaction surface.

Visible elements:

- top brand/status bar
- model status pill
- diagnostics icon for Output
- global gear icon
- five-icon module dock
- compact retrieval/context status strip
- session capsule/drawer
- message list
- context chips
- composer

Composer:

- visible only in `Chat`
- glass input surface
- permission chip: `Read`, `Ask`, `Trusted`, `Full`
- context attach icon
- clear context icon
- diagnostics/log icon
- send button
- stop button while sending, using existing `cancelSend`

Context status:

- show selected/current/open file state with icons
- show diagnostics/git diff state with icons
- show chip count and skipped/active state
- hover/detail should expose source paths and skipped reasons from `contextSummary`

### Models

Purpose: fast connection and model setup without overwhelming users.

Default visible fields:

- API base URL
- chat model
- API key button
- completion enabled switch
- completion profile summary

Default behavior:

- completion base URL inherits chat base URL when empty
- completion model inherits chat model when empty
- advanced sampling settings use current defaults and stay folded

Advanced rows:

- streaming
- temperature
- max tokens
- topP
- completion profile
- completion debounce
- completion log level

### Knowledge

Purpose: visible status and control center for CodeGraph, RAG, and hybrid retrieval.

Visible indicators:

- CodeGraph state ring
- indexed files/functions/macros counters
- indexing progress bar
- job queue and active job badge
- RAG chunk progress ring
- embedded/pending chunks
- vector shard count
- worker concurrency status
- rerank status
- Graph / Vector / Rerank capability icons
- degraded/fallback state badges

Actions:

- Check
- Apply
- Rebuild
- Pause
- Resume
- Cancel

Confirmation policy:

- `Check`, `Apply`, `Pause`, and `Resume` do not require confirmation.
- `Rebuild` requires a short confirmation.
- `Cancel` requires a short confirmation.

Advanced rows:

- embedding endpoint
- embedding model
- rerank endpoint
- rerank model
- allowed hosts
- batch and concurrency values
- checkpoint/resume values

### Skills

Purpose: Agent Skills catalog and installed skill capability visibility.

Visible structure:

- catalog URL / refresh
- available skills
- installed skills
- compact glass rows, not large cards

Each skill row should show:

- name
- version
- short description
- ready/error status
- allowed-tools summary
- compatibility summary
- install or rollback action

Skill states:

- `Ready`
- `Missing SKILL.md`
- `Script approval needed`
- `Invalid package`

### MCP

Purpose: MCP server package and tool visibility.

Visible structure:

- catalog URL / refresh, shared underlying catalog source
- available MCP packages
- installed MCP servers
- server -> tools hierarchy

Probe policy:

- probing should run `tools/list`
- probing must not execute tools
- tool execution remains inside existing approval/runtime logic

Each server row should show:

- package name
- version
- manifest validity
- stdio probe status
- tool count

Each tool row should show:

- tool name
- short description
- schema summary
- availability state

Tool states:

- `Ready`
- `Needs approval`
- `Blocked`
- `Probe failed`

### Global Settings

Purpose: cross-module settings only.

Includes:

- default permission profile
- diagnostics/output shortcut
- UI density preference
- module visibility preference can be deferred

The global settings panel should not become a dumping ground for all module forms.

## Implementation Plan

### Phase 1: Lock Behavioral Expectations With Tests

- Update webview source tests for:
  - five module entries
  - default Chat module
  - composer scoped to Chat
  - Settings gear
  - Output icon named as diagnostics/logs, not history
  - Skills and MCP separated
  - no `position: absolute` in icon layout
- Add tests that ensure `codeGraph.status()` enters webview state.
- Add tests that ensure hybrid retrieval code paths are not removed or bypassed.

### Phase 2: Refactor Webview Structure

- Split the current monolithic webview content out of `src/chipmate-chat-view.ts`.
- Suggested files:
  - `src/webview/chipmate-html.ts`
  - `src/webview/chipmate-styles.ts`
  - `src/webview/chipmate-script.ts`
  - `src/webview/chipmate-icons.ts`
  - `src/webview/chipmate-view-types.ts`
- Keep the extension as a framework-free VS Code webview.
- Do not introduce React, Vue, Svelte, or a bundler.

### Phase 3: Expand View State

- Extend state for:
  - chat settings
  - completion settings
  - RAG settings
  - code graph status
  - RAG status
  - context summary
  - installed skill packages
  - installed MCP packages
  - MCP probe results
  - skill capability summaries
- Keep existing SecretStorage usage for API keys.

### Phase 4: Implement The New Shell

- Build top brand/status bar.
- Build five-icon dock.
- Build Chat default page.
- Build Settings panel.
- Keep all icon rows in normal document flow.
- Apply Liquid Glass CSS with VS Code theme variables.
- Add reduced-transparency and reduced-motion fallbacks.

### Phase 5: Implement Models

- Add fast connection form.
- Add API key button.
- Add completion switch.
- Add completion profile selector.
- Add folded advanced rows.
- Persist through existing VS Code settings keys.

### Phase 6: Implement Knowledge

- Surface CodeGraph and RAG state.
- Add progress rings/bars.
- Add Graph/Vector/Rerank capability status.
- Wire Check/Apply/Rebuild/Pause/Resume/Cancel.
- Add confirmations for Rebuild and Cancel.
- Avoid changing retrieval core behavior.

### Phase 7: Implement Skills

- Split catalog packages by `type === "skill"`.
- Show available and installed skills.
- Parse or probe installed skill summaries.
- Show capability/status rows.
- Preserve install/rollback flow.

### Phase 8: Implement MCP

- Split catalog packages by `type === "mcp"`.
- Show installed MCP servers separately.
- Add probe action for `tools/list`.
- Cache and display probe result in webview state.
- Show per-tool availability without executing tools.

### Phase 9: Verification

Run:

```bash
bun test
bun run lint
bun run compile
bun run package
```

Before local VSIX:

- check for existing `opencode-remote-*.vsix` or current extension package artifact in repo root
- if an existing same-extension VSIX artifact exists, patch bump `package.json` by +1
- run:

```bash
bun run vsix
```

Then verify in real VS Code:

- narrow sidebar layout does not overlap
- all text fits
- composer only appears in Chat
- Output icon opens diagnostics/logs
- Skills and MCP are separate
- Knowledge shows CodeGraph/RAG progress
- hybrid retrieval indicators reflect status but do not alter retrieval behavior

## Non-Goals

- Do not rewrite the completion pipeline.
- Do not rewrite retrieval ranking, fallback, or RAG logic.
- Do not depend on user-installed Bun/npm for runtime behavior.
- Do not add a new frontend framework.
- Do not copy Apple SF Symbols resources into the VSIX.
- Do not make Output logs appear as chat history.
- Do not hide modules by default.

## Acceptance Criteria

- The UI looks like a polished Liquid Glass system panel rather than a generic web settings form.
- A new user can connect a model with minimal required input.
- Advanced settings are discoverable but folded by default.
- Context, CodeGraph, RAG, Graph/Vector/Rerank, Skills, and MCP status are visible through icons/progress/badges.
- Hover/title or expandable rows expose detailed status.
- Skills and MCP are separate in the UI and in user mental model.
- Dangerous Knowledge actions are confirmed.
- Existing hybrid retrieval capability remains intact.
- `bun run package` passes.
- A fresh VSIX is produced when implementation is complete.
