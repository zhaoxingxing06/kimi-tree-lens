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
| `read_definition` | 按名称精确读取某个定义的源码 |
| `ast_search` | 对文件执行 tree-sitter 查询（S-expression 模式） |
| `index_workspace` | 解析目录下所有受支持的源码，构建符号索引 |
| `find_references` / `go_to_definition` | 基于索引的符号跳转与引用查找；`find_references` 支持可选 `file` 参数把结果限定到单个文件（低成本消歧同名定义） |
| `callers` / `callees` | 基于索引的启发式调用图；结果带语言、调用接收者与解析置信度，支持 file/language 过滤 |
| `resolution_stats` | 度量整个索引的解析覆盖率：exact/likely/name-only 三档、按 via 细分、import 解析率、同名定义冲突组 |
| `index_status` | 查看索引状态、总量与 watcher |
| `list_presets` / `preset_search` | 内置审计查询（eval/exec、subprocess、innerHTML、JDBC……） |
| `get_node_types` | 列出语法的节点类型与字段，用于编写正确的查询模式 |
| `analyze_complexity` | 按函数估算圈复杂度，按最差排序 |

### 解析置信度

`callers` / `callees` / `find_references` 的每个调用点命中都带置信度档位与 `via` 依据，agent 由此判断该多信它几分：

- **`exact`** —— 锁定到唯一文件（及符号）：按声明类型解析的接收者（含继承、`this`/`super`、字段 / 形参 / 局部变量 / for-each / catch 类型、经仓内方法返回类型的链式接收者）、唯一 import、java 的 `new Foo()` 构造调用、Lombok 风格访问器。
- **`likely`** —— 无硬依据的最佳猜测：接收者类型在索引内唯一但成员本体不在仓内（如 MyBatis-Plus 的 `mapper.selectList()`）、同目录、全索引内唯一名字。
- **`name`** —— 未解析；DI 注入的 bean、反射，以及成员或返回类型跳出索引的调用（如 `stream().map()`）。

`resolution_stats` 输出整个索引的覆盖率数字，先量化精度再信任调用图。

### 新鲜度

索引绝不静默地返回过期答案：读取前先冲刷 watcher 挂起的改动；当积压未清完就答复查询时，响应会带明确的 staleness 提示并列出待处理文件，而不是假装自己是最新状态。

## 安装

> **前提：** [Node.js](https://nodejs.org) ≥ 20.6。

在 Kimi Code 里执行：

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
```

然后 `/reload` 或开新会话——装完了。安装会自动注册：

- `tree-lens` MCP server——所有工具以 `mcp__tree-lens__*` 提供
- 1 个只读子代理 `tree-lens-tracer`（调用链路追踪，见[子代理](#子代理)）

另有常驻使用提示词（`SYSTEM.md`）与按需加载的 `code-search` skill。首次启动时 MCP 服务会自动安装运行时依赖（仅一次，需要联网）。五种语言的 grammar WASM 已预编译打包，加载时做 SHA-256 完整性校验——全程无需任何构建步骤。

## 使用指引

你只需用自然语言说：

| 你说 | agent 执行 |
|------|-----------|
| "给 `server.js` 列个大纲，再看下 `runTool` 的实现" | `list_definitions` → `read_definition` |
| "先索引这个仓库，然后找出谁调用了 `savePersistedIndex`" | `index_workspace` → `callers` |
| "对这个文件做安全扫描" | `list_presets` → `preset_search` |
| "找出所有给 `.innerHTML` 赋值的地方" | `ast_search` |
| "这个文件里哪个函数复杂度最高？" | `analyze_complexity` |

内置审计 preset 覆盖：`eval`/`exec`、`shell=True` 子进程、`pickle`/`marshal`、`innerHTML` 赋值、动态 `import()`、`dangerouslySetInnerHTML`、JDBC `execute`、`System.exit`、反射类加载、`os/exec`、`panic`、`unsafe.Pointer`。

### 管理

```text
/plugins list
/plugins info tree-lens
```

MCP server 由插件管理：用 `/plugins mcp enable|disable tree-lens` 即可启停。

## 子代理

安装后自动注册 1 个只读子代理 **`tree-lens-tracer`**——无任何写工具、也没有 `index_workspace`（索引只归主 agent），通过 `callers` / `callees` / `ast_search` 追踪"谁调用了 X / X 调用了什么"，并以带框线的节点树返回链路，每个节点都带 `file:line` 佐证与置信档。

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

## 测试

```bash
npm test               # 113 项测试：冒烟（路径围栏、超时、缓存、watcher……）、调用图、解析置信度、多索引、双存储、新鲜度
npm run test:corpus    # 解析官方 tree-sitter 语料并与期望语法树逐一比对
```

## 可参考的项目基准测试报告

2026-08-29 实测：本地项目仓库（Spring/MyBatis，Java，`node scripts/bench-precision.mjs`）与生成的 2 万文件 Python 语料（`node scripts/bench-scale.mjs --files 20000`），均为 SQLite 存储：

| 指标 | 数值 |
|---|---|
| 冷索引（449 个 Java 文件、4088 符号） | ~1.1s |
| 调用点 | 9963（8404 带接收者） |
| exact | 4354（43.7%）—— 接收者类型 3519、同文件 419、import 416 |
| likely | 1651（16.6%）—— 主要是外部基类锚定 |
| 仅名字匹配 | 3958（39.7%） |
| import 名字解析率 | 1166/3299（35.3%） |
| 规模 · 索引文件数（2 万文件 Python 语料） | 20000（60000 符号、100000 引用） |
| 规模 · 冷索引 | 3.4s（约 5846 文件/秒） |
| 规模 · 单文件增量重索引 | 213ms（parsed=1, reused=19999） |
| 规模 · 查询延迟（200 次随机查找） | p50 0ms / p95 1ms / max 150ms |
| 规模 · 索引后进程 RSS | 约 295 MB |

## 许可证

[MIT](LICENSE)。随库分发的 grammar WASM 从官方 `tree-sitter-java/-python/-typescript/-go` 仓库（MIT 许可）在锁定 tag 上构建，具体版本见 `build-wasm.sh`。
