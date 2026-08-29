<div align="center">

<img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>

# kimi-tree-lens

**Syntax-tree X-ray for Kimi Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.6-339933)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/Java%20%C2%B7%20Python%20%C2%B7%20TS%20%C2%B7%20TSX%20%C2%B7%20Go-5-blue)](#supported-languages)
[![Built for](https://img.shields.io/badge/Built%20for-Kimi%20Code-black)](https://www.kimi.com)

**English** | [简体中文](README.zh-CN.md)

*Give your coding agent X-ray vision for source code — see the skeleton, not the noise.*

</div>

---

## Why

When a coding agent works in a real codebase, two things dominate its cost and accuracy budget: **reading files** and **searching them**. Reading a whole file to find one method wastes context tokens; Grep finds strings but cannot express structure — "every `executeQuery` call" is easy, but "every assignment to a field inside a constructor" is not.

**kimi-tree-lens** closes that gap. It compiles [tree-sitter](https://tree-sitter.github.io/) to WASM and serves it over the [Model Context Protocol](https://modelcontextprotocol.io), giving a Kimi Code agent tree-level access to source code — inside strict path confinement and hard resource caps:

- **Outline instead of read** — list the definitions of a file with line ranges, then fetch only the one method that matters.
- **Structural search** — S-expression queries capture AST shapes that string tools cannot express, with node text and line numbers returned.
- **Workspace-scale navigation** — a persisted, incrementally-refreshed symbol index answers "where is this defined / called" across tens of thousands of files.
- **Security audits as presets** — dangerous-pattern queries (eval/exec, subprocess with `shell=`, `innerHTML` assignment, JDBC `execute`, `System.exit`, `os/exec`…) shipped built-in, extensible by dropping `.scm` files in a user directory.

A managed plugin for [Kimi Code](https://www.kimi.com). Originally developed as an internal plugin, now open-sourced.

## Design philosophy

| | |
|---|---|
| **Structure first** | Grep lives in the world of strings; the meaning of code lives in the syntax tree. This plugin hands the agent the syntax tree as a queryable database. |
| **Read on demand** | An agent's most expensive resource is context. The outline-first, definition-second read path turns "look at one method" from ingesting a whole file into one precise hit. |
| **Safe by default** | Agents point this tool at arbitrary code — path confinement, read-time re-validation, hash pinning and resource caps are not features bolted on; they are the price of admission. |
| **Not an editor, never LSP** | LSP serves *humans inside editors* (completion, diagnostics, sessions). This plugin serves *an agent beside a codebase*; tree-sitter's granularity is exactly right for that, and layering LSP on top would add weight without adding power. |

> Thanks to pi — it embraced me once, and that's how I came to understand AI.
> (In Chinese, "AI" sounds exactly like the word for *love*.)

## Supported languages

`Java` · `Python` · `TypeScript` · `TSX` · `Go`

## Tools

| Tool | Purpose |
|------|---------|
| `list_definitions` | Outline a file (classes, functions, methods, fields...) with line ranges |
| `read_definition` | Read one definition's source by exact name |
| `ast_search` | Run a tree-sitter query (S-expression pattern) against a file |
| `index_workspace` | Parse all supported sources under a directory into a symbol index |
| `find_references` / `go_to_definition` | Name-based navigation over the index; `find_references` accepts an optional `file` arg to scope results to one file (cheap disambiguation of same-named definitions) |
| `callers` / `callees` | Heuristic call-graph over the index; hits carry language + receiver + resolution confidence, optional file/language filters |
| `resolution_stats` | Measure resolution coverage of the whole index: exact/likely/name-only tiers, per-`via` breakdown, import resolution rate, same-name collision groups |
| `index_status` | Index state, totals, watcher status |
| `delete_index` | Drop an index: clears it from the session and deletes its persisted cache files; omit `root` when exactly one index exists |
| `list_presets` / `preset_search` | Built-in audit queries (eval/exec, subprocess, innerHTML, JDBC...) |
| `get_node_types` | Grammar node types and fields, for writing correct query patterns |
| `analyze_complexity` | Approximate cyclomatic complexity per function, worst first |

User-defined queries are picked up from `~/.kimi-code/tree-sitter-queries/<lang>/*.scm` (definition queries) and `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` (audit presets; first `;;` line is the description). They hot-reload on mtime change.

### Resolution confidence

Every call-site hit from `callers` / `callees` / `find_references` carries a confidence tier and a `via` reason, so the agent knows how much to trust it:

- **`exact`** — the target is pinned to one file (and symbol). `via: type` — the receiver's declared type, including members inherited through the `extends`/`implements` chain, `this`/`super` and implicit-this calls, class-name receivers (`Utils.fmt()` static calls resolved through the unique class), java `new Foo()` constructor calls, interface-typed receivers dispatched to the unique implementing class, Lombok-style accessors (`user.getName()` pins to the `User.name` field it reads), chained receivers resolved through in-repo method return types (`user.getProfile().displayName()`, every hop exact), and receivers typed by field / parameter / local / for-each / catch declarations; `via: import` / `import-static` / `import-wildcard` — the symbol was imported from exactly one file; `via: local` — defined in the same file.
- **`likely`** — a best guess without a hard pin: `via: type` when the receiver's type is unique in the index but the member itself lives outside it (e.g. MyBatis-Plus `mapper.selectList()` anchors to the mapper interface defined in the repo); `via: same-dir`; `via: unique` (exactly one definition of that name exists in the whole index).
- **`name`** — unresolved; the hit is name-based only (DI-injected beans, reflection, chained calls whose intermediate return types leave the index such as `stream().map()` — static analysis cannot see through those).

`resolution_stats` reports the coverage numbers for the whole index, so you can quantify precision before trusting a call graph.

### Freshness

The index never serves stale answers silently. Reads flush pending watcher changes first (bounded by `TREE_SITTER_MCP_FRESHEN_BUDGET_MS`, default 2000ms); edits made outside a session are absorbed by the same catch-up path on the next auto-index. When a query answers before the backlog is drained, the response carries an explicit staleness banner listing the pending files instead of pretending it is current. The watcher schedules re-parse ahead of traversal, so large edits land within one debounce window (`TREE_SITTER_MCP_WATCH_DEBOUNCE_MS`, default 300ms, forced flush at 5x).

## Install

> **Prerequisite:** [Node.js](https://nodejs.org) ≥ 20.6 (`npm` included).

> **Upgrading from 1.x (breaking):** the MCP server is no longer declared by the plugin. After updating, add the `mcp.json` entry shown below — tool names change from `mcp__plugin-tree-lens_tree-lens__*` to `mcp__tree-lens__*`, so any tool whitelists (e.g. custom agents) referencing the old names must be updated too.

In Kimi Code, run:

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
```

Then register the MCP server yourself in `~/.kimi-code/mcp.json` (the plugin does not declare it, keeping tool names short — `mcp__tree-lens__*` instead of `mcp__plugin-tree-lens_tree-lens__*`):

```json
{
  "mcpServers": {
    "tree-lens": {
      "command": "node",
      "args": ["/absolute/path/to/kimi-tree-lens/launcher.mjs"]
    }
  }
}
```

Point `args` at the launcher inside the plugin's managed copy (`~/.kimi-code/plugins/managed/tree-lens/launcher.mjs`, expand the `~` yourself) or at a local clone, then `/reload` or start a new session.

That's it. On first launch the MCP server installs its runtime dependencies automatically (one-time, needs network). Grammar WASMs for all five languages ship prebuilt and are SHA-256-verified at load time — no build step is ever required.

<details>
<summary><b>Manual / offline installation</b></summary>

```bash
git clone https://github.com/zhaoxingxing06/kimi-tree-lens.git
cd kimi-tree-lens && npm install --omit=dev
```

Then in Kimi Code: `/plugins install /path/to/kimi-tree-lens` (a local directory works too), followed by `/reload`.

To rebuild grammars from source instead of using the bundled WASMs:

```bash
npm run build:grammars          # clones pinned tree-sitter tags, builds WASM, refreshes hashes
```

</details>

## Usage

After `/reload` — or in any new session — the `tree-lens` MCP tools (`mcp__tree-lens__*`) are available to the agent. The bundled `code-search` skill is loaded at session start, so the agent already knows when and how to reach for them. Just ask in natural language:

| You say | What the agent runs |
|---------|---------------------|
| "Outline `server.js`, then show me the `runTool` definition" | `list_definitions` → `read_definition` |
| "Index this repo, then find who calls `savePersistedIndex`" | `index_workspace` → `callers` |
| "Security-scan this file for dangerous patterns" | `list_presets` → `preset_search` |
| "Find every assignment to `.innerHTML`" | `ast_search` |
| "Which function in this file is the complexity hotspot?" | `analyze_complexity` |

Built-in audit presets cover `eval`/`exec`, subprocess with `shell`, `pickle`/`marshal`, `innerHTML` assignment, dynamic `import()`, `dangerouslySetInnerHTML`, JDBC `execute`, `System.exit`, reflection class loading, `os/exec`, `panic` and `unsafe.Pointer`.

### Extend it

Drop your own query files (hot-reloaded on change):

| Directory | Purpose |
|-----------|---------|
| `~/.kimi-code/tree-sitter-queries/<lang>/*.scm` | Definition queries |
| `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` | Audit presets (first `;;` line is the description) |

### Manage it

```text
/plugins list
/plugins info tree-lens
```

The MCP server is not plugin-managed, so `/plugins mcp enable|disable` does not apply to it — to disable it, set `"enabled": false` on the `tree-lens` entry in `mcp.json` (or remove the entry).

## Using it with sub-agents

The biggest payoff of tree-lens is context savings: delegate the lookups to a read-only sub-agent and get conclusions back instead of raw JSON dumps in the main conversation.

**Rule 1 — only the main agent runs `index_workspace`.** Sub-agents start with zero context and only see their tool list, so the hard guarantee is the tool whitelist, not prompts: the plugin bundles a ready-made read-only agent at `agents/tree-lens-reader.md` — copy it into your project's `.kimi-code/agents/` (or define your own whose tools omit `index_workspace`). Its definition:

````markdown
---
name: tree-lens-reader
description: Read-only code retrieval subagent; structured symbol/reference/call-site
  queries via tree-lens; rebuilding the index is forbidden
whenToUse: Delegate when the main agent has already built the index and precise symbol
  location or call-site retrieval is needed
tools:
  - Read
  - Grep
  - Glob
  - mcp__tree-lens__find_references
  - mcp__tree-lens__go_to_definition
  - mcp__tree-lens__index_status
  - mcp__tree-lens__callers
  - mcp__tree-lens__callees
  - mcp__tree-lens__list_definitions
  - mcp__tree-lens__read_definition
  - mcp__tree-lens__ast_search
  - mcp__tree-lens__analyze_complexity
  - mcp__tree-lens__list_presets
  - mcp__tree-lens__preset_search
  - mcp__tree-lens__get_node_types
---

You are a read-only retrieval agent. Indexing is owned by the main agent; you have no
index_workspace tool and must not attempt to rebuild the index.

Usage rules:
- When multiple indexes exist, calls to find_references / callers / callees must pass
  the root argument explicitly.
- Before delivering, call index_status once to confirm index state (root /
  index_version), and report the root and index_version of the index used in your result.
- Prefer hits with `confidence: exact` and a `resolved_to`; find_references / callers /
  callees are name-based recall, so same-named definitions of different classes mix in
  one result. Filter by `resolved_to` and spot-check key hits with Read before drawing
  conclusions.
- If an ast_search pattern errors, correct and retry at most once; if it still fails,
  fall back to Grep/Read instead of repeatedly rewriting the pattern.
- Call list_presets before using preset_search; never guess preset names.

Result standard — your final message must satisfy every item below to count as complete:
- Conclusions first: direct answers to the question asked, one statement per conclusion;
  no narration of the steps you took.
- Every conclusion carries evidence: `file:line` (plus symbol name where relevant), line
  numbers copied from tool output — never guessed, never approximated.
- Call-site and reference conclusions state the confidence tier they rest on (exact /
  likely / name). `likely` or `name`-tier hits may support a lead only, never a final
  conclusion — and you must say so explicitly.
- The result reports the `root` and `index_version` used, and states whether
  `index_version` changed while you worked.
- If results were truncated (`total` > `returned`), state it, with the `limit`/`offset`.
- Zero hits is reported plainly as "no hits in index vN for <name>" — never pad with
  Grep/Read output presented as if it came from the index.
- No raw JSON dumps; quoted source is at most 3 lines per hit.

Your final message is the complete deliverable to the main agent.
````

**Rule 2 — brief the sub-agent like a colleague.** It has not seen your conversation. Every task prompt should spell out:

- absolute paths of the files/roots involved
- the exact tool names to call and which `root` to pass
- "re-check `index_status` and compare `index_version` before concluding"
- the deliverable format: conclusions + `file:line` + the `index_version` used

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Tools don't show up | Run `/reload`; check `/plugins info tree-lens` for diagnostics |
| First launch is slow or fails | The one-time dependency install needs network; if it fails (offline), run `npm install --omit=dev` inside `~/.kimi-code/plugins/managed/tree-lens` |
| `grammar hash mismatch` | A grammar WASM was rebuilt or tampered; run `npm run build:grammars` to regenerate both the WASMs and `lib/grammar-hashes.json` |
| Unsupported file type / Node errors | The plugin needs Node.js ≥ 20.6; check `node --version` |

## Security model

This plugin is designed to be pointed at arbitrary code by an LLM agent:

- **Path confinement** — every `file`/`root` argument must resolve (after `realpath`) inside the workspace roots advertised by the host, `$TREE_SITTER_MCP_ROOTS`, or the nearest project marker (`.git`, `package.json`, `pom.xml`, ...). Paths with no marker are rejected unless `TREE_SITTER_MCP_ALLOW_UNCONFINED=1` is set explicitly.
- **Read-time re-validation** — file paths are re-resolved and fence-checked inside the worker at read time, so symlink swaps between validation and I/O cannot escape the workspace.
- **Grammar integrity** — every grammar WASM is SHA-256 pinned in `lib/grammar-hashes.json`; a mismatch refuses to load.
- **Resource caps** — 1 MB per file, NUL-byte binary rejection, soft/hard deadlines per tool (timed-out workers are replaced), bounded index (SQLite default 20000 files / hard 100000; JSON fallback 1500 / 5000; depth 40) and bounded output sizes.
- **No network, no subprocess** — the server only reads files under allowed roots and writes its index cache under `~/.kimi-code/tree-sitter-plugin-cache/`.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `TREE_SITTER_MCP_ROOTS` | host roots | Path-separated list of allowed workspace roots |
| `TREE_SITTER_MCP_ALLOW_UNCONFINED` | unset | `1` allows paths without any project marker |
| `TREE_SITTER_MCP_TIMEOUT_MS` | per-tool defaults | Override hard deadline for all tools (ms) |
| `TREE_SITTER_MCP_POOL` | auto (1–8) | Worker pool size |
| `TREE_SITTER_MCP_CACHE_DIR` | `~/.kimi-code/tree-sitter-plugin-cache` | Persisted index location |
| `TREE_SITTER_MCP_MAX_FILES` | `20000` | SQLite-store default file cap (hard cap 100000) |
| `TREE_SITTER_MCP_FRESHEN_BUDGET_MS` | `2000` | Time budget for flushing pending edits before a read |
| `TREE_SITTER_MCP_STORE` | sqlite | Set to `json` to force the JSON store fallback |
| `TREE_SITTER_MCP_USER_QUERIES` | `~/.kimi-code/tree-sitter-queries` | User `.scm` queries directory |
| `TREE_SITTER_MCP_WATCH_DEBOUNCE_MS` | `300` | File-watcher debounce; a forced flush runs after 5x this wait even under sustained writes |
| `TREE_SITTER_MCP_CACHE_SPIN_MS` | `2000` | Tree-cache freshness poll interval |

## Tests

```bash
npm test               # 113-case suite: smoke (confinement, timeouts, cache, watcher...), call graph, resolution, multi-index, stores, freshness
npm run test:corpus    # parses official tree-sitter corpora and diffs against expected trees
```

## Measured resolution coverage

Real-world numbers from `node scripts/bench-precision.mjs <repo>` on a production Spring/MyBatis repo (634 Java files, `ztls-saas-disposal`):

| metric | value |
|---|---|
| cold index (634 files, 7374 symbols) | ~1.3s |
| call sites | 28762 (23561 with receiver) |
| exact | 11187 (38.9%) — receiver type 8861, local 1302, import 1024 |
| likely | 3987 (13.9%) — mostly external-base anchoring |
| name-only | 13588 (47.2%) |
| import names resolved | 1912/5108 (37.4%) |

The remaining 47% name-only tier is dominated by DI-injected beans, reflection, and calls whose member or return types live outside the repo (MyBatis-Plus `BaseMapper`, Lombok-generated members) — a fundamental ceiling for declaration-based static analysis, not an implementation gap. Resolution evolved in three steps, each pinned by `tests/resolve.mjs`: inheritance-aware receivers plus java `new Foo()` constructor capture lifted exact from 2317 (8.8%) → 4411 (15.3%); accessor synthesis (Lombok-style getters/setters pin to the field they access) plus external-base anchoring lifted it to 10725 (37.3%); parameter / for-each / catch declared types plus chained-receiver resolution through in-repo method return types brought it to 11187 (38.9%).

Scale, measured by `node scripts/bench-scale.mjs --files 20000` (generated 20k-file Python corpus, SQLite store):

| metric | value |
|---|---|
| files indexed | 20000 (60000 symbols, 100000 refs) |
| cold index | 3.2s (~6290 files/s) |
| single-file incremental re-index | 216ms (parsed=1, reused=19999) |
| query latency (200 randomized lookups) | p50 0ms / p95 1ms / max 136ms |
| process RSS after index | ~295 MB |

## Roadmap

- An npm package for the **Pi coding open-source extension community** is planned — hit the ✨ Star button to stay tuned.

## License

[MIT](LICENSE). Bundled grammar WASMs are built from the official `tree-sitter-java/-python/-typescript/-go` repositories (MIT licensed) at pinned tags; see `build-wasm.sh` for the exact versions.

---

<div align="center">

If this plugin saves your agent some context, consider giving it a ⭐

</div>
