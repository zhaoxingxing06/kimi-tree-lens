import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const file = process.argv[2];
const t = new StdioClientTransport({ command: "node", args: ["./server.js"] });
const c = new Client({ name: "real-check", version: "0.0.1" });
await c.connect(t);

const parse = (r) => JSON.parse(r.content[0].text);
const t0 = Date.now();
let r = parse(await c.callTool({ name: "list_definitions", arguments: { file } }));
console.log(`list: ${JSON.stringify(r).length}B in ${Date.now() - t0}ms, count=${r.count}, truncated=${r.truncated}`);
for (const d of r.defs.slice(0, 8)) console.log(`  [${d.kind}] ${d.name} @${d.start_line}-${d.end_line}`);

const target = r.defs.find((d) => d.kind === "method" || d.kind === "function");
if (target) {
  const t1 = Date.now();
  r = parse(await c.callTool({ name: "read_definition", arguments: { file, name: target.name } }));
  console.log(`read ${target.name}: ${r.count} hit(s), ${r.defs[0].code.length}B in ${Date.now() - t1}ms`);
}

const t2 = Date.now();
r = parse(await c.callTool({
  name: "ast_search",
  arguments: { file, pattern: "(method_invocation object: (this) (argument_list) @args) @call" },
}));
console.log(`ast_search this-calls: matches=${r.matches} in ${Date.now() - t2}ms, first=${r.results[0]?.text ?? "-"}`);

await c.close();
