<div align="center">

<img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>

# kimi-tree-lens

**给 Kimi Code 装上看穿代码的"X 光"**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.6-339933)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/Java%20%C2%B7%20Python%20%C2%B7%20TS%20%C2%B7%20TSX%20%C2%B7%20Go-5-blue)](#支持语言)
[![Built for](https://img.shields.io/badge/Built%20for-Kimi%20Code-black)](https://www.kimi.com)

[English](README.md) | **简体中文**

</div>

---

## 为什么做这个

为了看一个方法而把整个文件读进上下文是巨大的 token 浪费；Grep 能搜字符串，但表达不了结构——"找出构造函数里对某字段的所有赋值"做不到。**kimi-tree-lens** 把 [tree-sitter](https://tree-sitter.github.io/) 编译成 WASM，通过 [Model Context Protocol](https://modelcontextprotocol.io) 提供，让 agent 直接查询语法树——全部在严格的路径围栏与资源上限之内运行：

- **大纲代替通读** —— 先列出文件的符号定义与行号范围，再精确读取需要的那个方法。
- **结构化搜索** —— S-expression 查询能表达字符串工具无法描述的 AST 形态。
- **跨文件导航** —— 持久化、增量刷新的符号索引，在数万文件的规模上回答"这个符号在哪定义/被谁调用"。
- **安全审计内置** —— 常见危险模式查询（eval/exec、`shell=True` 子进程、`innerHTML` 赋值、JDBC `execute`、`System.exit`、`os/exec`……）开箱即用。

一个 [Kimi Code](https://www.kimi.com) 托管插件。

## 设计理念

- **保持上下文干净无噪音** —— agent 最贵的资源是上下文；先大纲、后定义的两级读取路径，让"看一个方法"从通读整个文件变成一次精准命中。
- **不内置 LSP Server** —— LSP 服务的是"编辑器里的人"（补全、诊断、会话）；本插件服务的是"代码库旁的 agent"，tree-sitter 的粒度恰好够用，不额外增加重量。
- **安全围栏** —— 工具会被 agent 指向任意代码：路径围栏、读取时二次校验、哈希锁定、资源上限不是附加功能，而是存在的前提。

## 支持语言

`Java` · `Python` · `TypeScript` · `TSX` · `Go`

## 工具列表

| 工具 | 用途 |
|------|------|
| `list_definitions` | 输出文件大纲（类、函数、方法、字段……）及行号范围 |
| `cached_outline` | 解析文件大纲并缓存（同一文件后续调用直接命中缓存）；用于精读前对搜索结果做廉价筛选 |
| `read_definition` | 按名称精确读取某个定义的源码 |
| `ast_search` | 对文件执行 tree-sitter 查询（S-expression 模式） |
| `index_workspace` | 解析目录下所有受支持的源码，构建符号索引 |
| `find_references` / `go_to_definition` | 基于索引的符号跳转与引用查找；`find_references` 支持可选 `file` 参数把结果限定到单个文件（低成本消歧同名定义） |
| `callers` / `callees` | 基于索引的启发式调用图；结果带语言、调用接收者与解析置信度（exact/likely/name，无置信度字段即外部/库方法调用），支持 file/language 过滤 |
| `resolution_stats` | 度量整个索引的解析覆盖率：exact/likely/name-only 三档、按 via 细分、import 解析率、同名定义冲突组 |
| `index_status` | 查看索引状态、总量与 watcher |
| `list_presets` / `preset_search` | 内置审计查询（eval/exec、subprocess、innerHTML、JDBC……） |
| `get_node_types` | 列出语法的节点类型与字段，用于编写正确的查询模式 |
| `analyze_complexity` | 按函数估算圈复杂度，按最差排序 |

## 安装

> **前提：** [Node.js](https://nodejs.org) ≥ 20.6。

在 Kimi Code 里执行：

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
```

然后 `/reload` 或开新会话——装完了。安装会自动注册：

- `tree-lens` MCP server——所有工具以 `mcp__tree-lens__*` 提供
- 1 个只读子代理 `tree-lens-tracer`（调用链路追踪，见[子代理](#子代理)）
- 3 个 hook，构成"先读后写"门禁（见[先读后写门禁](#先读后写门禁)）

另有常驻使用提示词（`SYSTEM.md`）与按需加载的 `code-search` skill。首次启动时 MCP 服务会自动安装运行时依赖（仅一次，需要联网）。五种语言的 grammar WASM 已预编译打包，加载时做 SHA-256 完整性校验——全程无需任何构建步骤。

## 子代理

安装后自动注册 1 个只读子代理 **`tree-lens-tracer`**——无任何写工具、也没有 `index_workspace`（索引只归主 agent），通过 `callers` / `callees` / `ast_search` 追踪"谁调用了 X / X 调用了什么"，并以带框线的节点树返回链路，每个节点都带 `file:line` 佐证与置信档。

## 大纲缓存

`cached_outline(file)` MCP 工具把受支持的源码文件解析为定义大纲（`name/kind/行号`，不含代码），缓存于 `~/.kimi-code/tree-lens-hook/outlines/`，按 `size` + `mtimeMs` 记忆命中；同一文件未变更时后续调用直接命中缓存。用于精读前对搜索结果做廉价筛选。

## 先读后写门禁

插件启用期间，三个 hook 维护会话级已读状态并在编辑前后提供调用点上下文（fail-open：hook 崩溃或超时时不拦截，照常放行）：

| Hook | 事件 | 行为 |
|------|------|------|
| `read-ledger.mjs` | PostToolUse（`Read`/`Edit`/`Write`/`Bash`） | 把会话触及的每个文件记入按会话隔离的 ledger |
| `edit-gate.mjs` | PreToolUse（`Edit`/`Write`） | 条件阻断：仅当编辑触及的定义存在本会话未读的 exact 或类型锚定调用点、或其他模块同名定义的方法体已漂移（不一致；`toString`/`equals` 等通用方法名跳过比对）时，按符号拦截一次，原样重发即放行；调用点已读且副本一致时静默放行。trace 同时追加到会话 `traces.log`（callers 查询会在项目尚无索引时后台触发构建） |
| `session-index-builder.mjs` | SessionStart | 后台构建工作区符号索引，加速后续查询 |

新建文件始终豁免（目标尚不存在）。ledger 状态与编辑 trace 的 `traces.log` 都存于 `~/.kimi-code/tree-lens-gate/`，按 session id + cwd 隔离。

拦截时模型收到的信封格式参考（示例数据均为占位）：

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

- 首行即动作：原样重发同一编辑即放行（每符号每次会话最多拦一次）
- `call sites not read this session`：本会话尚未读到的 exact/类型锚定调用点
- `cross-module drift`：其他模块同名定义的方法体已不一致；副本全一致时该段不出现
- 两段均为空时不拦截，编辑直接通过

## 常见问题

| 现象 | 处理 |
|------|------|
| 工具没出现 | 先执行 `/reload`；用 `/plugins info tree-lens` 查看诊断信息 |
| 首次启动慢或失败 | 一次性依赖安装需要联网；离线环境请在 `~/.kimi-code/plugins/managed/tree-lens` 目录里手动执行 `npm install --omit=dev` |
| 报 `grammar hash mismatch` | grammar WASM 被重建或篡改过；执行 `npm run build:grammars` 重新生成 WASM 与 `lib/grammar-hashes.json` |
| 不支持的文件类型 / Node 报错 | 本插件需要 Node.js ≥ 20.6，用 `node --version` 确认 |

## 安全模型

本插件的设计前提是：调用它的 LLM agent 会把它指向任意代码。

- **路径围栏** —— 所有 `file`/`root` 参数经 `realpath` 解析后必须落在宿主声明的 workspace roots、`$TREE_SITTER_MCP_ROOTS` 或最近的项目标记（`.git`、`package.json`、`pom.xml`……）之内；无任何标记的路径一律拒绝，除非显式设置 `TREE_SITTER_MCP_ALLOW_UNCONFINED=1`。
- **读取时二次校验** —— 文件路径在 worker 内读取时会重新解析并复核围栏，验证与 I/O 之间的符号链接置换无法逃出工作区。
- **grammar 完整性** —— 每个 grammar WASM 在 `lib/grammar-hashes.json` 中以 SHA-256 锁定，不匹配即拒绝加载。
- **资源上限** —— 单文件 1 MB、NUL 字节二进制拒绝、每个工具软/硬双超时（超时的 worker 会被替换）、索引规模受限（SQLite 默认 20000 文件 / 硬上限 100000；JSON 回退 1500 / 5000；深度 40）、输出条数与长度截断。
- **无网络、无子进程** —— 服务端只读取允许范围内的文件，索引缓存只写入 `~/.kimi-code/tree-sitter-plugin-cache/`。

## 可参考的项目基准测试报告

| 指标 | 数值 |
|---|---|
| 冷索引（449 个 Java 文件、4088 符号） | ~1.1s |
| 规模 · 冷索引 | 3.4s（约 5846 文件/秒） |
| 规模 · 单文件增量重索引 | 213ms（parsed=1, reused=19999） |
| 规模 · 查询延迟（200 次随机查找） | p50 0ms / p95 1ms / max 150ms |
| 规模 · 索引后进程 RSS | 约 295 MB |

## 许可证

[MIT](LICENSE)。随库分发的 grammar WASM 从官方 `tree-sitter-java/-python/-typescript/-go` 仓库（MIT 许可）在锁定 tag 上构建，具体版本见 `build-wasm.sh`。
