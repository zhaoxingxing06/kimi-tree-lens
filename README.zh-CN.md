<div align="center">

<img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>

# kimi-tree-lens

**给 Kimi Code 装上看穿代码的"X 光"**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2020.6-339933)](https://nodejs.org)
[![Languages](https://img.shields.io/badge/Java%20%C2%B7%20Python%20%C2%B7%20TS%20%C2%B7%20TSX%20%C2%B7%20Go-5-blue)](#支持语言)
[![Built for](https://img.shields.io/badge/Built%20for-Kimi%20Code-black)](https://www.kimi.com)

[English](README.md) | **简体中文**

*让 AI 一眼看穿代码的骨架，而不是一行行啃源码。*

</div>

---

## 为什么做这个

编程 agent 在真实代码库里工作时，成本和准确率主要消耗在两件事上：**读文件**和**搜文件**。为了看一个方法而把整个文件读进上下文是巨大的 token 浪费；Grep 能搜字符串，但表达不了结构——"找出所有 `executeQuery` 调用"很容易，而"找出构造函数里对某字段的所有赋值"做不到。

**kimi-tree-lens** 就是为了补上这块能力：把 [tree-sitter](https://tree-sitter.github.io/) 编译成 WASM，通过 [Model Context Protocol](https://modelcontextprotocol.io) 提供，让 agent 以语法树的粒度访问源码——全部在严格的路径围栏与资源上限之内运行：

- **大纲代替通读** —— 先列出文件的符号定义与行号范围，再精确读取需要的那个方法。
- **结构化搜索** —— S-expression 查询能表达字符串工具无法描述的 AST 形态，返回节点文本与行号。
- **跨文件导航** —— 持久化、增量刷新的符号索引，在数万文件的规模上回答"这个符号在哪定义/被谁调用"。
- **安全审计内置** —— 常见危险模式查询（eval/exec、`shell=True` 子进程、`innerHTML` 赋值、JDBC `execute`、`System.exit`、`os/exec`……）开箱即用，往用户目录放 `.scm` 文件即可扩展。

一个 [Kimi Code](https://www.kimi.com) 托管插件。最初自用，现开源发布。

## 设计理念

| | |
|---|---|
| **结构优先** | Grep 活在字符串的世界里，而代码的意义活在语法树里。本插件把语法树当作数据库交给 agent 查询。 |
| **按需读取** | agent 最贵的资源是上下文。先大纲、后定义的两级读取路径，让"看一个方法"从通读整个文件变成一次精准命中。 |
| **默认安全** | 工具会被 agent 指向任意代码——路径围栏、读取时二次校验、哈希锁定、资源上限不是附加功能，而是存在的前提。 |
| **不做编辑器，永不 LSP** | LSP 服务的是"编辑器里的人"（补全、诊断、会话）；本插件服务的是"代码库旁的 agent"。tree-sitter 的粒度恰好是这个问题的最优解，再叠上 LSP 只会增加重量，不会增加能力。 |

> 感谢 pi——是它曾拥抱过我，才让我懂了 AI。
> （在中文里，"AI"恰好就是"爱"的发音。）

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

用户自定义查询：定义查询放 `~/.kimi-code/tree-sitter-queries/<lang>/*.scm`，审计 preset 放 `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm`（首行 `;;` 为描述），改动按 mtime 热加载。

### 解析置信度

`callers` / `callees` / `find_references` 的每个调用点命中都带置信度档位与 `via` 依据，agent 由此判断该多信它几分：

- **`exact`** —— 目标锁定到唯一文件（及符号）。`via: type`：按接收者声明类型解析，含经 `extends`/`implements` 继承链命中的成员、`this`/`super` 和隐式 this 调用、类名接收者（`Utils.fmt()` 静态调用按唯一类名解析）、java 的 `new Foo()` 构造调用、接口类型接收者向唯一实现类的虚调用分派、Lombok 风格访问器（`user.getName()` 锁定到它读写的 `User.name` 字段）、经仓内方法返回类型逐跳解析的链式接收者（`user.getProfile().displayName()`，每一跳都是 exact），以及由字段 / 形参 / 局部变量 / for-each / catch 声明确定类型的接收者；`via: import` / `import-static` / `import-wildcard`：符号经 import 唯一指向某文件；`via: local`：定义在同文件。
- **`likely`** —— 无硬依据的最佳猜测：`via: type`：接收者类型在索引内唯一、但成员本体不在仓内（如 MyBatis-Plus 的 `mapper.selectList()` 锚定到仓内定义的 mapper 接口）；`via: same-dir`；`via: unique`（全索引内该名字只有一个定义）。
- **`name`** —— 未解析，仅名字匹配（DI 注入的 bean、反射、中间返回类型跳出索引的链式调用如 `stream().map()`——基于声明的静态分析看不见这些）。

`resolution_stats` 输出整个索引的覆盖率数字，先量化精度再信任调用图。

### 新鲜度

索引绝不静默地返回过期答案。读取前先冲刷 watcher 挂起的改动（受 `TREE_SITTER_MCP_FRESHEN_BUDGET_MS` 限制，默认 2000ms）；会话外做的修改由同一条 catch-up 路径在下一次自动索引时吸收。当积压未清完就答复查询时，响应会带明确的 staleness 提示并列出待处理文件，而不是假装自己是最新状态。watcher 会把重解析排在遍历之前，大改动在一个防抖窗口内落库（`TREE_SITTER_MCP_WATCH_DEBOUNCE_MS`，默认 300ms，持续写入达 5 倍时长强制刷新）。

## 安装

> **前提：** [Node.js](https://nodejs.org) ≥ 20.6（自带 `npm`）。

在 Kimi Code 里执行：

```text
/plugins install https://github.com/zhaoxingxing06/kimi-tree-lens
/reload
```

装完了。首次启动时 MCP 服务会自动安装运行时依赖（仅一次，需要联网）。五种语言的 grammar WASM 已预编译打包，加载时做 SHA-256 完整性校验——全程无需任何构建步骤。

<details>
<summary><b>手动 / 离线安装</b></summary>

```bash
git clone https://github.com/zhaoxingxing06/kimi-tree-lens.git
cd kimi-tree-lens && npm install --omit=dev
```

然后在 Kimi Code 里执行 `/plugins install /path/to/kimi-tree-lens`（也支持本地目录路径），最后 `/reload`。

如需从源码重建 grammar（替代随库分发的 WASM）：

```bash
npm run build:grammars          # 克隆锁定的 tree-sitter tag、构建 WASM、刷新哈希
```

</details>

## 使用指引

`/reload` 之后（或任何新会话里），`tree-lens` 的 MCP 工具对 agent 自动可用，零配置。自带的 `code-search` skill 会在会话启动时加载，agent 已经知道何时、如何使用这些工具——你只需用自然语言说：

| 你说 | agent 执行 |
|------|-----------|
| "给 `server.js` 列个大纲，再看下 `runTool` 的实现" | `list_definitions` → `read_definition` |
| "先索引这个仓库，然后找出谁调用了 `savePersistedIndex`" | `index_workspace` → `callers` |
| "对这个文件做安全扫描" | `list_presets` → `preset_search` |
| "找出所有给 `.innerHTML` 赋值的地方" | `ast_search` |
| "这个文件里哪个函数复杂度最高？" | `analyze_complexity` |

内置审计 preset 覆盖：`eval`/`exec`、`shell=True` 子进程、`pickle`/`marshal`、`innerHTML` 赋值、动态 `import()`、`dangerouslySetInnerHTML`、JDBC `execute`、`System.exit`、反射类加载、`os/exec`、`panic`、`unsafe.Pointer`。

### 扩展

放入自定义查询文件即可（按改动自动热加载）：

| 目录 | 用途 |
|------|------|
| `~/.kimi-code/tree-sitter-queries/<lang>/*.scm` | 定义查询 |
| `~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm` | 审计 preset（首行 `;;` 为描述） |

### 管理

```text
/plugins list
/plugins info tree-lens
/plugins mcp disable tree-lens tree-lens      # 停用其 MCP 服务
```

## 与子代理（sub-agent）协作使用

tree-lens 最大的收益在于上下文节省：把检索工作委派给只读子代理，主对话里拿回的是结论，而不是一堆原始 JSON dump。

**规则一 —— `index_workspace` 只归主 agent。** 子代理启动时没有任何上下文，只能看到自己的工具列表，所以硬保证是工具白名单而不是提示词：插件自带一个现成的只读代理 `agents/tree-lens-reader.md`——把它复制到你项目的 `.kimi-code/agents/`（或自己定义一个工具里不含 `index_workspace` 的只读代理）。其定义：

````markdown
---
name: tree-lens-reader
description: 只读代码检索子代理，通过 tree-lens 做结构化符号/引用/调用点查询，禁止重建索引
whenToUse: 主 agent 已建好索引、需要精确符号定位或调用点检索时委派
tools:
  - Read
  - Grep
  - Glob
  - mcp__plugin-tree-lens_tree-lens__find_references
  - mcp__plugin-tree-lens_tree-lens__go_to_definition
  - mcp__plugin-tree-lens_tree-lens__index_status
  - mcp__plugin-tree-lens_tree-lens__callers
  - mcp__plugin-tree-lens_tree-lens__callees
  - mcp__plugin-tree-lens_tree-lens__list_definitions
  - mcp__plugin-tree-lens_tree-lens__read_definition
  - mcp__plugin-tree-lens_tree-lens__ast_search
  - mcp__plugin-tree-lens_tree-lens__analyze_complexity
  - mcp__plugin-tree-lens_tree-lens__list_presets
  - mcp__plugin-tree-lens_tree-lens__preset_search
  - mcp__plugin-tree-lens_tree-lens__get_node_types
---

你是只读检索代理。索引由主 agent 负责，你没有 index_workspace 工具，不得尝试重建索引。

使用规则：
- 存在多个索引时，调用 find_references / callers / callees 必须显式传 root 参数。
- 交付前必须调用一次 index_status 确认索引状态（root / index_version），
  并在结果中报告所用索引的 root 与 index_version。
- 优先采信带 `confidence: exact` 且含 `resolved_to` 的命中；find_references / callers /
  callees 是按名字召回，同名定义会混在一份结果里，按 `resolved_to` 过滤，
  关键命中用 Read 复核后再下结论。
- ast_search 模式报错时修正后最多重试一次，仍失败则回退 Grep/Read，不反复改写模式。
- 使用 preset_search 前先调 list_presets，禁止凭空猜 preset 名。

结果标准 —— 最终回复必须逐条满足，缺一即视为未完成：
- 结论先行：直接回答所问问题，一条结论一句话；不叙述你走过的步骤。
- 每条结论都带证据：`file:line`（必要时附符号名），行号取自工具输出，禁止凭记忆估计。
- 调用点与引用结论必须注明所依据的置信档（exact / likely / name）。
  likely / name 档命中只能支撑线索，不能支撑最终结论——且必须显式说明。
- 结果中报告所用 root 与 index_version，并说明工作期间 index_version 是否变化。
- 结果被截断（total > returned）时必须说明，并给出所用 limit/offset。
- 零命中就如实写"索引 vN 中 <name> 无命中"——禁止用 Grep/Read 输出冒充索引结果充数。
- 禁止粘贴原始 JSON dump；引用源码每处不超过 3 行。

你的最终回复就是交给主 agent 的完整交付物。
````

**规则二 —— 把子代理当成刚进门的同事来交代任务。** 它看不到你们的对话，每个任务提示都应写明：

- 涉及文件 / 索引 root 的绝对路径
- 要调用的确切工具名，以及该传哪个 `root`
- "下结论前先调 `index_status` 核对 `index_version`"
- 交付物格式：结论 + `file:line` 引用 + 所用的 `index_version`

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

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TREE_SITTER_MCP_ROOTS` | 宿主 roots | 分隔的允许 workspace root 列表 |
| `TREE_SITTER_MCP_ALLOW_UNCONFINED` | 未设置 | 设为 `1` 允许无项目标记的路径 |
| `TREE_SITTER_MCP_TIMEOUT_MS` | 各工具默认值 | 覆盖所有工具的硬超时（毫秒） |
| `TREE_SITTER_MCP_POOL` | 自适应（1–8） | Worker 池大小 |
| `TREE_SITTER_MCP_CACHE_DIR` | `~/.kimi-code/tree-sitter-plugin-cache` | 索引持久化目录 |
| `TREE_SITTER_MCP_MAX_FILES` | `20000` | SQLite 存储默认文件上限（硬上限 100000） |
| `TREE_SITTER_MCP_FRESHEN_BUDGET_MS` | `2000` | 读取前冲刷待处理改动的时间预算 |
| `TREE_SITTER_MCP_STORE` | sqlite | 设为 `json` 强制回退 JSON 存储 |
| `TREE_SITTER_MCP_USER_QUERIES` | `~/.kimi-code/tree-sitter-queries` | 用户 `.scm` 查询目录 |
| `TREE_SITTER_MCP_WATCH_DEBOUNCE_MS` | `300` | 文件 watcher 防抖；持续写入达到该值 5 倍时长后强制刷新一次 |
| `TREE_SITTER_MCP_CACHE_SPIN_MS` | `2000` | 树缓存新鲜度轮询间隔 |

## 测试

```bash
npm test               # 113 项测试：冒烟（路径围栏、超时、缓存、watcher……）、调用图、解析置信度、多索引、双存储、新鲜度
npm run test:corpus    # 解析官方 tree-sitter 语料并与期望语法树逐一比对
```

## 实测解析覆盖率

`node scripts/bench-precision.mjs <repo>` 在一个真实 Spring/MyBatis 生产仓（634 个 Java 文件，`ztls-saas-disposal`）上的数据：

| 指标 | 数值 |
|---|---|
| 冷索引（634 文件、7374 符号） | ~1.3s |
| 调用点 | 28762（23561 带接收者） |
| exact | 11187（38.9%）—— 接收者类型 8861、同文件 1302、import 1024 |
| likely | 3987（13.9%）—— 主要是外部基类锚定 |
| 仅名字匹配 | 13588（47.2%） |
| import 名字解析率 | 1912/5108（37.4%） |

剩余 47% 的 name-only 档主要来自 DI 注入、反射，以及成员或返回类型不在仓内的调用（MyBatis-Plus `BaseMapper`、Lombok 生成成员）——这是基于声明的静态分析的理论天花板，不是实现缺口。解析能力分三步演进，每一步都由 `tests/resolve.mjs` 用例固定：继承感知接收者加上 java `new Foo()` 构造捕获，把 exact 从 2317（8.8%）提到 4411（15.3%）；访问器合成（Lombok 风格 getter/setter 锁定到所访问的字段）加上外部基类锚定，提到 10725（37.3%）；形参 / for-each / catch 声明类型加上经仓内方法返回类型的链式接收者解析，最终到 11187（38.9%）。

规模指标，来自 `node scripts/bench-scale.mjs --files 20000`（生成 2 万文件的 Python 语料，SQLite 存储）：

| 指标 | 数值 |
|---|---|
| 索引文件数 | 20000（60000 符号、100000 引用） |
| 冷索引 | 3.2s（约 6290 文件/秒） |
| 单文件增量重索引 | 216ms（parsed=1, reused=19999） |
| 查询延迟（200 次随机查找） | p50 0ms / p95 1ms / max 136ms |
| 索引后进程 RSS | 约 295 MB |

## 路线图

- 计划将 npm 包上架 **Pi coding 开源扩展社区**——欢迎点个 ✨ Star 保持关注。

## 许可证

[MIT](LICENSE)。随库分发的 grammar WASM 从官方 `tree-sitter-java/-python/-typescript/-go` 仓库（MIT 许可）在锁定 tag 上构建，具体版本见 `build-wasm.sh`。

---

<div align="center">

如果这个插件为你的 agent 省下了上下文，欢迎点个 ⭐

</div>
