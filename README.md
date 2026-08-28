# kimi-tree-lens

**English | [简体中文](README.zh-CN.md)**

<p align="center">
  <img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>
</p>

> Give your coding agent X-ray vision for source code — see the skeleton, not the noise.

tree-sitter compiled to WASM, served over MCP. Kimi Code agents get syntax-tree-level access to
code: outline a thousand-line file in milliseconds, hit AST shapes Grep can never express, ask
"where is this defined / who calls it" across thousands of files, and run dangerous-pattern audits
out of the box — all inside strict path confinement and hard resource caps.

A managed plugin for [Kimi Code](https://www.kimi.com), built on
[tree-sitter](https://tree-sitter.github.io/) (WASM) over the Model Context Protocol (MCP).
Java, Python, TypeScript, TSX and Go.

## Background

When a coding agent works in a real codebase, two things dominate its cost and accuracy budget:
reading files and searching them. Reading a whole file to find one method wastes context tokens;
Grep finds strings but cannot express structure — "every `executeQuery` call" is easy, but
"every assignment to a field inside a constructor" is not.

This plugin was built to close that gap for Kimi Code. It uses tree-sitter compiled to WASM to give
the agent tree-level access to source code:

- **Outline instead of read** — list the definitions of a file with line ranges, then fetch only
  the one method that matters.
- **Structural search** — S-expression queries capture AST shapes that string tools cannot express,
  with node text and line numbers returned.
- **Workspace-scale navigation** — a persisted, incrementally-refreshed symbol index answers
  "where is this defined / called" across thousands of files.
- **Security audits as presets** — common dangerous-pattern queries (eval/exec, subprocess with
  `shell=`, `innerHTML` assignment, JDBC `execute`, `System.exit`, `os/exec`...) shipped built-in,
  extensible by dropping `.scm` files in a user directory.

Because the tool is pointed at arbitrary code by an LLM agent, it is hardened accordingly: strict
path confinement with read-time re-validation, SHA-256-pinned grammar WASMs, and hard resource caps.
It was originally developed as a managed plugin for our own Kimi Code setup and is now open-sourced.

## Scope: no editor, no LSP

This plugin is not a VSCode-like code editor, and integrating an LSP language server is out of
scope — now and in the future.

LSP serves *humans inside editors*: completion, diagnostics, sessions — machinery for typing
efficiently in an IDE. This plugin serves *an agent beside a codebase*: it treats the syntax tree
as a database to query — outlines, definitions, references, call graphs, dangerous-pattern audits.
tree-sitter's granularity is exactly right for that; layering LSP on top would add weight without
adding power.

> Thanks to pi — it embraced me once, and that's how I came to understand AI.
> (In Chinese, "AI" sounds exactly like the word for *love*.)

## Supported languages

Java, Python, TypeScript, TSX, Go.

## Tools

| Tool | Purpose |
|------|---------|
| `list_definitions` | Outline a file (classes, functions, methods, fields...) with line ranges |
| `read_definition` | Read one definition's source by exact name |
| `ast_search` | Run a tree-sitter query (S-expression pattern) against a file |
| `index_workspace` | Parse all supported sources under a directory into a symbol index |
| `find_references` / `go_to_definition` | Name-based navigation over the index |
| `callers` / `callees` | Heuristic call-graph over the index |
| `index_status` | Index state, totals, watcher status |
| `list_presets` / `preset_search` | Built-in audit queries (eval/exec, subprocess, innerHTML, JDBC...) |
| `get_node_types` | Grammar node types and fields, for writing correct query patterns |
| `analyze_complexity` | Approximate cyclomatic complexity per function, worst first |

User-defined queries are picked up from `~/.kimi-code/tree-sitter-queries/<lang>/*.scm`
(definition queries) and `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm`
(audit presets; first `;;` line is the description). They hot-reload on mtime change.

## Install

```bash
git clone https://github.com/zhaoxingxing06/kimi-tree-lens.git \
  ~/.kimi-code/plugins/managed/tree-lens
cd ~/.kimi-code/plugins/managed/tree-sitter
npm install --omit=dev
```

Then register the plugin in Kimi Code by pointing its plugin configuration at this directory
(the manifest is `kimi.plugin.json`). Prebuilt grammar WASMs for all five languages are included
in `grammars/` and verified at load time, so no build step is required.

To rebuild grammars from source instead:

```bash
npm run build:grammars          # clones pinned tree-sitter tags, builds WASM, refreshes hashes
```

Requires `git`, `python3` and network access; the tree-sitter CLI is fetched via `npx` (pinned version).

## Security model

This plugin is designed to be pointed at arbitrary code by an LLM agent:

- **Path confinement** — every `file`/`root` argument must resolve (after `realpath`) inside the
  workspace roots advertised by the host, `$TREE_SITTER_MCP_ROOTS`, or the nearest project marker
  (`.git`, `package.json`, `pom.xml`, ...). Paths with no marker are rejected unless
  `TREE_SITTER_MCP_ALLOW_UNCONFINED=1` is set explicitly.
- **Read-time re-validation** — file paths are re-resolved and fence-checked inside the worker at
  read time, so symlink swaps between validation and I/O cannot escape the workspace.
- **Grammar integrity** — every grammar WASM is SHA-256 pinned in `lib/grammar-hashes.json`;
  a mismatch refuses to load.
- **Resource caps** — 1 MB per file, NUL-byte binary rejection, soft/hard deadlines per tool
  (timed-out workers are replaced), bounded index (5000 files, depth 12) and bounded output sizes.
- **No network, no subprocess** — the server only reads files under allowed roots and writes its
  index cache under `~/.kimi-code/tree-sitter-plugin-cache/`.

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

## License

MIT. Bundled grammar WASMs are built from the official `tree-sitter-java/-python/-typescript/-go`
repositories (MIT licensed) at pinned tags; see `build-wasm.sh` for the exact versions.
