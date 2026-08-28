# kimi-tree-lens

**[English](README.md) | 简体中文**

<p align="center">
  <img src="assets/banner.svg" alt="kimi-tree-lens — syntax-tree X-ray for Kimi Code" width="720"/>
</p>

> 让 AI 一眼看穿代码的骨架，而不是一行行啃源码。

把 tree-sitter 编译成 WASM 塞进 MCP，给 Kimi Code 装上语法树级的"X 光"：
千行文件秒出大纲、Grep 表达不了的代码形态一句话命中、数千文件的符号定义与调用关系即问即答、
常见危险代码模式审计开箱即用——全部在严格的路径围栏与资源上限之内运行。

一个 [Kimi Code](https://www.kimi.com) 托管插件，基于 [tree-sitter](https://tree-sitter.github.io/)（WASM 编译），
通过 Model Context Protocol（MCP）工作，支持 Java、Python、TypeScript、TSX、Go。

## 背景

编程 agent 在真实代码库里工作时，成本和准确率主要消耗在两件事上：读文件和搜文件。为了看一个方法
而把整个文件读进上下文是巨大的 token 浪费；Grep 能搜字符串，但表达不了结构——"找出所有
`executeQuery` 调用"很容易，而"找出构造函数里对某字段的所有赋值"做不到。

本插件就是为了给 Kimi Code 补上这块能力：用编译成 WASM 的 tree-sitter，让 agent 直接以语法树的
粒度访问源码：

- **大纲代替通读** —— 先列出文件的符号定义与行号范围，再精确读取需要的那个方法。
- **结构化搜索** —— S-expression 查询能表达字符串工具无法描述的 AST 形态，返回节点文本与行号。
- **跨文件导航** —— 持久化、增量刷新的符号索引，在数千个文件规模上回答"这个符号在哪定义/被谁调用"。
- **安全审计内置** —— 常见危险模式查询（eval/exec、`shell=True` 子进程、`innerHTML` 赋值、JDBC
  `execute`、`System.exit`、`os/exec`……）开箱即用，往用户目录放 `.scm` 文件即可扩展。

由于这些工具会被 LLM agent 指向任意代码，插件本身也做了对应的加固：严格的路径围栏（读取时二次
校验）、grammar WASM 的 SHA-256 锁定、以及硬性资源上限。本项目最初是我们自用 Kimi Code 的托管
插件，现开源发布。

## 设计边界：不做编辑器，不做 LSP

本插件不是类似 VSCode 的代码编辑器，未来也不会考虑集成 LSP 语言服务器。

LSP 服务的是"编辑器里的人"：补全、诊断、会话，为人类在 IDE 里高效打字而生。本插件服务的是
"代码库旁的 agent"：它不需要这些，它需要把语法树当作数据库来查询——大纲、定义、引用、调用图、
危险模式审计。tree-sitter 的粒度恰好是这个问题的最优解，再叠上 LSP 只会增加重量，不会增加能力。

> 感谢 pi——是它曾拥抱过我，才让我懂了 AI。
> （在中文里，"AI"恰好就是"爱"的发音。）

## 支持语言

Java、Python、TypeScript、TSX、Go。

## 工具列表

| 工具 | 用途 |
|------|------|
| `list_definitions` | 输出文件大纲（类、函数、方法、字段……）及行号范围 |
| `read_definition` | 按名称精确读取某个定义的源码 |
| `ast_search` | 对文件执行 tree-sitter 查询（S-expression 模式） |
| `index_workspace` | 解析目录下所有受支持的源码，构建符号索引 |
| `find_references` / `go_to_definition` | 基于索引的符号跳转与引用查找 |
| `callers` / `callees` | 基于索引的启发式调用图 |
| `index_status` | 查看索引状态、总量与 watcher |
| `list_presets` / `preset_search` | 内置审计查询（eval/exec、subprocess、innerHTML、JDBC……） |
| `get_node_types` | 列出语法的节点类型与字段，用于编写正确的查询模式 |
| `analyze_complexity` | 按函数估算圈复杂度，按最差排序 |

用户自定义查询：定义查询放 `~/.kimi-code/tree-sitter-queries/<lang>/*.scm`，审计 preset 放
`~/.kimi-code/tree-sitter-queries/presets/<lang>/*.scm`（首行 `;;` 为描述），改动按 mtime 热加载。

## 安装

```bash
git clone https://github.com/zhaoxingxing06/kimi-tree-lens.git \
  ~/.kimi-code/plugins/managed/tree-lens
cd ~/.kimi-code/plugins/managed/tree-sitter
npm install --omit=dev
```

然后在 Kimi Code 的插件配置中把插件目录指向这里（清单文件为 `kimi.plugin.json`）。五种语言的
grammar WASM 已预编译打包在 `grammars/` 内，加载时会做完整性校验，无需任何构建步骤。

如需从源码重建 grammar：

```bash
npm run build:grammars          # 克隆锁定的 tree-sitter tag、构建 WASM、刷新哈希
```

需要 `git`、`python3` 和网络；tree-sitter CLI 通过 `npx` 拉取（版本已锁定）。

## 安全模型

本插件的设计前提是：调用它的 LLM agent 会把它指向任意代码。

- **路径围栏** —— 所有 `file`/`root` 参数经 `realpath` 解析后必须落在宿主声明的 workspace roots、
  `$TREE_SITTER_MCP_ROOTS` 或最近的项目标记（`.git`、`package.json`、`pom.xml`……）之内；
  无任何标记的路径一律拒绝，除非显式设置 `TREE_SITTER_MCP_ALLOW_UNCONFINED=1`。
- **读取时二次校验** —— 文件路径在 worker 内读取时会重新解析并复核围栏，验证与 I/O 之间的符号
  链接置换无法逃出工作区。
- **grammar 完整性** —— 每个 grammar WASM 在 `lib/grammar-hashes.json` 中以 SHA-256 锁定，
  不匹配即拒绝加载。
- **资源上限** —— 单文件 1 MB、NUL 字节二进制拒绝、每个工具软/硬双超时（超时的 worker 会被替换）、
  索引规模受限（5000 文件、深度 12）、输出条数与长度截断。
- **无网络、无子进程** —— 服务端只读取允许范围内的文件，索引缓存只写入
  `~/.kimi-code/tree-sitter-plugin-cache/`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TREE_SITTER_MCP_ROOTS` | 宿主 roots | 分隔的允许 workspace root 列表 |
| `TREE_SITTER_MCP_ALLOW_UNCONFINED` | 未设置 | 设为 `1` 允许无项目标记的路径 |
| `TREE_SITTER_MCP_TIMEOUT_MS` | 各工具默认值 | 覆盖所有工具的硬超时（毫秒） |
| `TREE_SITTER_MCP_POOL` | `2` | Worker 池大小（1–4） |
| `TREE_SITTER_MCP_CACHE_DIR` | `~/.kimi-code/tree-sitter-plugin-cache` | 索引持久化目录 |
| `TREE_SITTER_MCP_USER_QUERIES` | `~/.kimi-code/tree-sitter-queries` | 用户 `.scm` 查询目录 |
| `TREE_SITTER_MCP_WATCH_DEBOUNCE_MS` | `800` | 文件 watcher 防抖 |
| `TREE_SITTER_MCP_CACHE_SPIN_MS` | `2000` | 树缓存新鲜度轮询间隔 |

## 测试

```bash
npm test               # 41 项冒烟测试（路径围栏、超时、缓存、watcher……）
npm run test:corpus    # 解析官方 tree-sitter 语料并与期望语法树逐一比对
```

## 许可证

MIT。随库分发的 grammar WASM 从官方 `tree-sitter-java/-python/-typescript/-go` 仓库（MIT 许可）
在锁定 tag 上构建，具体版本见 `build-wasm.sh`。
