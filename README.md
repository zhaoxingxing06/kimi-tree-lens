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
- **Workspace-scale navigation** — a persisted, incrementally-refreshed symbol index answers "where is this defined / called" across thousands of files.
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
| `find_references` / `go_to_definition` | Name-based navigation over the index |
| `callers` / `callees` | Heuristic call-graph over the index; hits carry language + receiver, optional file/language filters |
| `index_status` | Index state, totals, watcher status |
| `list_presets` / `preset_search` | Built-in audit queries (eval/exec, subprocess, innerHTML, JDBC...) |
| `get_node_types` | Grammar node types and fields, for writing correct query patterns |
| `analyze_complexity` | Approximate cyclomatic complexity per function, worst first |

User-defined queries are picked up from `~/.kimi-code/tree-sitter-queries/<lang>/*.scm` (definition queries) and `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` (audit presets; first `;;` line is the description). They hot-reload on mtime change.

## Install

> **Prerequisite:** [Node.js](https://nodejs.org) ≥ 20.6 (`npm` included).

In Kimi Code, run:

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
/reload
```

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

After `/reload` — or in any new session — the `tree-lens` MCP tools are available to the agent with zero configuration. The bundled `code-search` skill is loaded at session start, so the agent already knows when and how to reach for them. Just ask in natural language:

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
/plugins mcp disable tree-lens tree-lens      # disable its MCP server
```

## Using it with sub-agents

The biggest payoff of tree-lens is context savings: delegate the lookups to a read-only sub-agent and get conclusions back instead of raw JSON dumps in the main conversation.

**Rule 1 — only the main agent runs `index_workspace`.** Sub-agents start with zero context and only see their tool list, so the hard guarantee is the tool whitelist, not prompts: define a read-only agent whose tools omit `index_workspace`, e.g. `.kimi-code/agents/tree-lens-reader.md`:

````markdown
---
name: tree-lens-reader
description: Read-only code-retrieval sub-agent; structured symbol/reference/call-site
  queries via tree-lens; must not rebuild indexes
whenToUse: delegate when the main agent has already indexed the workspace and needs
  precise symbol location or call-site retrieval
tools:
  - Read
  - Grep
  - Glob
  - mcp__plugin-tree-lens_tree-lens__find_references
  - mcp__plugin-tree-lens_tree-lens__go_to_definition
  - mcp__plugin-tree-lens_tree-lens__index_status
  - mcp__plugin-tree-lens_tree-lens__callers
  - mcp__plugin-tree-lens_tree-lens__callees
---

You are a read-only retrieval agent. Indexing is the main agent's job; you have no
`index_workspace` tool and must not try to rebuild indexes.

Rules:
- With multiple indexes, find_references / callers / callees MUST pass an explicit root.
- Before concluding, call index_status once and report the root + index_version you used.
- Deliverables: conclusions + `file:line` references + the version check. No raw JSON
  dumps, no large code blocks.
- find_references/callers/callees are name-based; verify key hits with Read before
  drawing conclusions.
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
- **Resource caps** — 1 MB per file, NUL-byte binary rejection, soft/hard deadlines per tool (timed-out workers are replaced), bounded index (5000 files, depth 12) and bounded output sizes.
- **No network, no subprocess** — the server only reads files under allowed roots and writes its index cache under `~/.kimi-code/tree-sitter-plugin-cache/`.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `TREE_SITTER_MCP_ROOTS` | host roots | Path-separated list of allowed workspace roots |
| `TREE_SITTER_MCP_ALLOW_UNCONFINED` | unset | `1` allows paths without any project marker |
| `TREE_SITTER_MCP_TIMEOUT_MS` | per-tool defaults | Override hard deadline for all tools (ms) |
| `TREE_SITTER_MCP_POOL` | `2` | Worker pool size (1–4) |
| `TREE_SITTER_MCP_CACHE_DIR` | `~/.kimi-code/tree-sitter-plugin-cache` | Persisted index location |
| `TREE_SITTER_MCP_USER_QUERIES` | `~/.kimi-code/tree-sitter-queries` | User `.scm` queries directory |
| `TREE_SITTER_MCP_WATCH_DEBOUNCE_MS` | `800` | File-watcher debounce |
| `TREE_SITTER_MCP_CACHE_SPIN_MS` | `2000` | Tree-cache freshness poll interval |

## Tests

```bash
npm test               # 41-case smoke suite (confinement, timeouts, cache, watcher...)
npm run test:corpus    # parses official tree-sitter corpora and diffs against expected trees
```

## Roadmap

- An npm package for the **Pi coding open-source extension community** is planned — hit the ✨ Star button to stay tuned.

## License

[MIT](LICENSE). Bundled grammar WASMs are built from the official `tree-sitter-java/-python/-typescript/-go` repositories (MIT licensed) at pinned tags; see `build-wasm.sh` for the exact versions.

---

<div align="center">

If this plugin saves your agent some context, consider giving it a ⭐

</div>
