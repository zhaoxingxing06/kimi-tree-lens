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

### Confidence

Every call-site hit from `callers` / `callees` / `find_references` carries a confidence tier and a `via` reason, so the agent knows how much to trust it:

- **`exact`** — pinned to one file (and symbol): declared receiver types (including inheritance, `this`/`super`, field / parameter / local / for-each / catch types, chained in-repo return types), unique imports, java `new Foo()` constructor calls, Lombok-style accessors.
- **`likely`** — best guess without a hard pin: receiver type unique in the index but member outside it (e.g. MyBatis-Plus `mapper.selectList()`), same-dir, globally unique name.
- **`name`** — unresolved; DI-injected beans, reflection, and calls whose member or return types leave the index (e.g. `stream().map()`).

`resolution_stats` reports coverage for the whole index, so precision can be quantified before trusting a call graph.

### Freshness

The index never serves stale answers silently: reads flush pending watcher changes first, and when a query answers before the backlog drains, the response carries an explicit staleness banner listing the pending files instead of pretending it is current.

## Install

> **Prerequisite:** [Node.js](https://nodejs.org) ≥ 20.6.

In Kimi Code, run:

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
```

Then `/reload` or start a new session — that's it. Installing automatically registers:

- the `tree-lens` MCP server — all tools become available as `mcp__tree-lens__*`
- 1 read-only sub-agent, `tree-lens-tracer` (call-chain tracing; see [Sub-agents](#sub-agents))

Plus the always-on usage prompt (`SYSTEM.md`) and the on-demand `code-search` skill. On first launch the MCP server installs its runtime dependencies automatically (one-time, needs network). Grammar WASMs for all five languages ship prebuilt and are SHA-256-verified at load time — no build step is ever required.

## Usage

Just ask in natural language:

| You say | What the agent runs |
|---------|---------------------|
| "Outline `server.js`, then show me the `runTool` definition" | `list_definitions` → `read_definition` |
| "Index this repo, then find who calls `savePersistedIndex`" | `index_workspace` → `callers` |
| "Security-scan this file for dangerous patterns" | `list_presets` → `preset_search` |
| "Find every assignment to `.innerHTML`" | `ast_search` |
| "Which function in this file is the complexity hotspot?" | `analyze_complexity` |

Built-in audit presets cover `eval`/`exec`, subprocess with `shell`, `pickle`/`marshal`, `innerHTML` assignment, dynamic `import()`, `dangerouslySetInnerHTML`, JDBC `execute`, `System.exit`, reflection class loading, `os/exec`, `panic` and `unsafe.Pointer`.

### Manage it

```text
/plugins list
/plugins info tree-lens
```

The MCP server is plugin-managed: toggle it with `/plugins mcp enable|disable tree-lens`.

## Sub-agents

Installing also registers 1 read-only sub-agent, **`tree-lens-tracer`** — it has no write tools and no `index_workspace` (indexing stays with the main agent), traces "who calls X / what does X call" through `callers` / `callees` / `ast_search`, and returns the chain as a box-drawn tree of nodes, each node backed by `file:line` evidence and a confidence tier.

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

## Tests

```bash
npm test               # 113-case suite: smoke (confinement, timeouts, cache, watcher...), call graph, resolution, multi-index, stores, freshness
npm run test:corpus    # parses official tree-sitter corpora and diffs against expected trees
```

## Reference project benchmark report

Measured 2026-08-29 on a local project repo (Spring/MyBatis, Java, `node scripts/bench-precision.mjs`) and a generated 20k-file Python corpus (`node scripts/bench-scale.mjs --files 20000`), both with the SQLite store:

| metric | value |
|---|---|
| cold index (449 Java files, 4088 symbols) | ~1.1s |
| call sites | 9963 (8404 with receiver) |
| exact | 4354 (43.7%) — receiver type 3519, local 419, import 416 |
| likely | 1651 (16.6%) — mostly external-base anchoring |
| name-only | 3958 (39.7%) |
| import names resolved | 1166/3299 (35.3%) |
| scale · files indexed (20k-file Python corpus) | 20000 (60000 symbols, 100000 refs) |
| scale · cold index | 3.4s (~5846 files/s) |
| scale · single-file incremental re-index | 213ms (parsed=1, reused=19999) |
| scale · query latency (200 randomized lookups) | p50 0ms / p95 1ms / max 150ms |
| scale · process RSS after index | ~295 MB |

## License

[MIT](LICENSE). Bundled grammar WASMs are built from the official `tree-sitter-java/-python/-typescript/-go` repositories (MIT licensed) at pinned tags; see `build-wasm.sh` for the exact versions.
