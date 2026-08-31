<div align="center">

<img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>

# kimi-tree-lens

**Syntax-tree X-ray for Kimi Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.6-339933)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/Java%20%C2%B7%20Python%20%C2%B7%20TS%20%C2%B7%20TSX%20%C2%B7%20Go-5-blue)](#supported-languages)
[![Built for](https://img.shields.io/badge/Built%20for-Kimi%20Code-black)](https://www.kimi.com)

**English** | [简体中文](README.zh-CN.md)

</div>

---

## Why

Reading whole files wastes context, and Grep finds strings but cannot express structure — "every assignment to a field inside a constructor" is out of its reach. **kimi-tree-lens** compiles [tree-sitter](https://tree-sitter.github.io/) to WASM and serves it over the [Model Context Protocol](https://modelcontextprotocol.io), so the agent queries the syntax tree instead — inside strict path confinement and hard resource caps:

- **Outline instead of read** — list a file's definitions with line ranges, then fetch only the one method that matters.
- **Structural search** — S-expression queries capture AST shapes string tools cannot express.
- **Workspace-scale navigation** — a persisted, incrementally-refreshed symbol index answers "where is this defined / called" across tens of thousands of files.
- **Security audits as presets** — dangerous-pattern queries (eval/exec, subprocess with `shell=`, `innerHTML` assignment, JDBC `execute`, `System.exit`, `os/exec`…) shipped built-in.

A managed plugin for [Kimi Code](https://www.kimi.com).

## Design philosophy

- **Keep context clean, no noise** — the agent's most expensive resource is context; the outline-first, definition-second read path turns "look at one method" from ingesting a whole file into one precise hit.
- **No built-in LSP server** — LSP serves humans inside editors (completion, diagnostics, sessions); this plugin serves an agent beside a codebase, and tree-sitter's granularity is exactly right for that without the extra weight.
- **Security fence** — the agent points this tool at arbitrary code: path confinement, read-time re-validation, hash pinning and resource caps are not bolted-on features; they are the price of admission.

## Supported languages

`Java` · `Python` · `TypeScript` · `TSX` · `Go`

## Tools

| Tool | Purpose |
|------|---------|
| `list_definitions` | Outline a file (classes, functions, methods, fields...) with line ranges |
| `cached_outline` | Parse a file's outline and cache it (later calls on the same file are cache hits); cheap triage of search results before reading files |
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

## Install

> **Prerequisite:** [Node.js](https://nodejs.org) ≥ 20.6.

In Kimi Code, run:

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
```

Then `/reload` or start a new session — that's it. Installing automatically registers:

- the `tree-lens` MCP server — all tools become available as `mcp__tree-lens__*`
- 1 read-only sub-agent, `tree-lens-tracer` (call-chain tracing; see [Sub-agents](#sub-agents))
- 3 hooks enforcing a read-before-edit gate (see [Read-before-edit gate](#read-before-edit-gate))

Plus the always-on usage prompt (`SYSTEM.md`) and the on-demand `code-search` skill. On first launch the MCP server installs its runtime dependencies automatically (one-time, needs network). Grammar WASMs for all five languages ship prebuilt and are SHA-256-verified at load time — no build step is ever required.

## Sub-agents

Installing also registers 1 read-only sub-agent, **`tree-lens-tracer`** — it has no write tools and no `index_workspace` (indexing stays with the main agent), traces "who calls X / what does X call" through `callers` / `callees` / `ast_search`, and returns the chain as a box-drawn tree of nodes, each node backed by `file:line` evidence and a confidence tier.

## Outline cache

The `cached_outline(file)` MCP tool parses a supported source file into a definition outline (name, kind, line ranges — no code) and caches it at `~/.kimi-code/tree-lens-hook/outlines/` keyed by `size` + `mtimeMs`; later calls on an unchanged file are cache hits. Use it to triage search results before deciding which files to read.

## Read-before-edit gate

While the plugin is enabled, three hooks maintain per-session read state and surface call-site context around edits (fail-open: if a hook crashes or times out, the operation proceeds):

| Hook | Event | Behavior |
|------|-------|----------|
| `read-ledger.mjs` | PostToolUse on `Read`/`Edit`/`Write`/`Bash` | Records every file the session touches into a per-session ledger |
| `edit-gate.mjs` | PreToolUse on `Edit`/`Write` | Blocks an edit once per symbol, only when it touches definitions whose exact or type-anchored call sites the session has not read yet, or whose same-named copies in other modules have drifted (body differs; universal method names like `toString`/`equals` are skipped) — re-issuing the same edit then passes. Stays silent when call sites are already read and copies are identical. Traces also append to the session `traces.log` (the callers query builds an index in the background if the project has none) |
| `session-index-builder.mjs` | SessionStart | Builds the workspace symbol index in the background so later queries are fast |

Writing a brand-new file is always exempt (the target does not exist yet). Ledger state and the edit-trace `traces.log` live under `~/.kimi-code/tree-lens-gate/`, keyed by session id + cwd.

Envelope the model receives on a block (placeholder data):

```text
[tree-lens gate] edit paused once to surface impact info — re-issue the SAME edit to proceed (already recorded; the retry passes silently).
src/order/service.ts
call sites not read this session:
- calcTotal (function:120), called at:
    src/order/checkout.ts:88 (exact)
    src/order/invoice.ts:45 (exact)
cross-module drift:
- calcTotal: body differs in module-a, module-b (identical in module-c) — check whether this change should be ported
("not read" is ledger-based: full-file reads count as fully read; if you already know these, just re-issue.)
```

- First line is the action: re-issue the same edit to proceed (at most one block per symbol per session)
- `call sites not read this session`: exact or type-anchored call sites the session has not read yet
- `cross-module drift`: same-named definitions in other modules whose bodies differ (universal method names like `toString`/`equals` are skipped); omitted when all copies are identical
- When both sections are empty the edit passes silently

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

## Reference project benchmark report

| metric | value |
|---|---|
| cold index (449 Java files, 4088 symbols) | ~1.1s |
| scale · cold index | 3.4s (~5846 files/s) |
| scale · single-file incremental re-index | 213ms (parsed=1, reused=19999) |
| scale · query latency (200 randomized lookups) | p50 0ms / p95 1ms / max 150ms |
| scale · process RSS after index | ~295 MB |

## License

[MIT](LICENSE). Bundled grammar WASMs are built from the official `tree-sitter-java/-python/-typescript/-go` repositories (MIT licensed) at pinned tags; see `build-wasm.sh` for the exact versions.
