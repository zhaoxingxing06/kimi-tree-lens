import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-resolve-"));
fsSync.mkdirSync(path.join(tmp, "proj", "a"), { recursive: true });
fsSync.mkdirSync(path.join(tmp, "proj", "b"), { recursive: true });
const root = fsSync.realpathSync(path.join(tmp, "proj"));

fsSync.writeFileSync(
  path.join(root, "a", "UserService.java"),
  ["package a;", "", "public class UserService {", "    public void save() { }", "    public void delete() { }", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "OrderService.java"),
  [
    "package b;",
    "",
    "import a.UserService;",
    "",
    "public class OrderService {",
    "    private UserService userService;",
    "",
    "    public void run() {",
    "        userService.save();",
    "        this.save();",
    "    }",
    "",
    "    public void save() { }",
    "}",
    "",
  ].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "util.py"),
  ["def fmt(x):", "    return x", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "app2.py"),
  ["from a.util import fmt", "", "def run():", "    return fmt(1)", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "utils.ts"),
  ["export function fmt(s: string): string {", "  return s;", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "app.ts"),
  ['import { fmt } from "../a/utils";', "", "export function run(): void {", '  fmt("x");', "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "store.go"),
  ["package a", "", "type Store struct{}", "", "func (s *Store) Save() {}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "main.go"),
  ["package main", "", 'import "proj/a"', "", "var s a.Store", "", "func main() {", "  s.Save()", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "Base.java"),
  ["package a;", "", "public interface Base {", "    void put();", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "Ext.java"),
  ["package a;", "", "public interface Ext extends Base {}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "InheritCaller.java"),
  [
    "package b;",
    "",
    "import a.Ext;",
    "",
    "public class InheritCaller implements Ext {",
    "    private Ext ext;",
    "",
    "    public void run() {",
    "        ext.put();",
    "        this.put();",
    "        put();",
    "    }",
    "}",
    "",
  ].join("\n")
);

fsSync.writeFileSync(
  path.join(root, "a", "StringHelper.java"),
  [
    "package a;",
    "",
    "public class StringHelper {",
    "    public static String trim(String s) {",
    "        return s;",
    "    }",
    "}",
    "",
  ].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "Caller.java"),
  [
    "package b;",
    "",
    "import a.StringHelper;",
    "import a.UserService;",
    "",
    "public class Caller {",
    "    public void run() {",
    '        StringHelper.trim("x");',
    "        UserService us = new UserService();",
    "        us.save();",
    "    }",
    "}",
    "",
  ].join("\n")
);

fsSync.writeFileSync(
  path.join(root, "a", "IStore.java"),
  ["package a;", "", "public interface IStore {", "    void save();", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "StoreImpl.java"),
  ["package a;", "", "public class StoreImpl implements IStore {", "    public void save() { }", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "App.java"),
  [
    "package b;",
    "",
    "import a.IStore;",
    "",
    "public class App {",
    "    private IStore store;",
    "",
    "    public void run() {",
    "        store.save();",
    "    }",
    "}",
    "",
  ].join("\n")
);

fsSync.writeFileSync(
  path.join(root, "a", "User.java"),
  [
    "package a;",
    "",
    "public class User {",
    "    private String name;",
    "    private Profile profile;",
    "",
    "    public Profile getProfile() {",
    "        return profile;",
    "    }",
    "}",
    "",
  ].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "Profile.java"),
  ["package a;", "", "public class Profile {", "    public String displayName() {", '        return "";', "    }", "}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "a", "ExtRepo.java"),
  ["package a;", "", "public interface ExtRepo extends External {}", ""].join("\n")
);
fsSync.writeFileSync(
  path.join(root, "b", "UserCaller.java"),
  [
    "package b;",
    "",
    "import a.ExtRepo;",
    "import a.Profile;",
    "import a.User;",
    "",
    "public class UserCaller {",
    "    private User user;",
    "    private ExtRepo repo;",
    "    private java.util.List<Profile> profiles;",
    "",
    "    public void run() {",
    '        user.setName("x");',
    "        String n = user.getName();",
    "        repo.findById(1L);",
    "        user.getProfile().displayName();",
    "        for (Profile p : profiles) {",
    "            p.displayName();",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n")
);

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${extra ? " :: " + JSON.stringify(extra).slice(0, 500) : ""}`);
  }
};
const parse = (r) => JSON.parse(r.content[0].text);

const t = new StdioClientTransport({
  command: "node",
  args: ["./server.js"],
  env: {
    ...process.env,
    TREE_SITTER_MCP_ALLOW_UNCONFINED: "1",
    TREE_SITTER_MCP_CACHE_DIR: fsSync.mkdtempSync(path.join(os.tmpdir(), "ts-resolve-cache-")),
  },
});
const c = new Client({ name: "resolve-check", version: "0.0.1" });
await c.connect(t);

try {
  let r = parse(await c.callTool({ name: "index_workspace", arguments: { root } }));
  check("index ok (20 files, sqlite store)", r.ok === true && r.indexed === 20 && r.store === "sqlite", r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "save", root } }));
  const javaTypeHit = r.results?.find(
    (x) => x.lang === "java" && x.recv === "userService" && x.confidence === "exact" && x.via === "type"
  );
  check(
    "java receiver type resolves to UserService.save",
    !!javaTypeHit && javaTypeHit.resolved_to?.file === path.join(root, "a", "UserService.java") && javaTypeHit.resolved_to?.symbol === "UserService.save",
    r.results
  );
  const javaLocalHit = r.results?.find(
    (x) => x.lang === "java" && x.caller === "run" && x.recv === "this" && x.confidence === "exact" && x.via === "local"
  );
  check(
    "java this.save resolves locally to OrderService.save",
    !!javaLocalHit && javaLocalHit.resolved_to?.file === path.join(root, "b", "OrderService.java"),
    r.results
  );
  check("callers save resolution summary", r.resolution?.exact >= 2, r.resolution);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "fmt", root } }));
  const pyImportHit = r.results?.find((x) => x.lang === "python" && x.confidence === "exact" && x.via === "import");
  check(
    "python from-import resolves fmt",
    !!pyImportHit && pyImportHit.resolved_to?.file === path.join(root, "a", "util.py"),
    r.results
  );
  const tsImportHit = r.results?.find((x) => x.lang === "typescript" && x.confidence === "exact" && x.via === "import");
  check(
    "ts relative import resolves fmt",
    !!tsImportHit && tsImportHit.resolved_to?.file === path.join(root, "a", "utils.ts"),
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "Save", root } }));
  const goTypeHit = r.results?.find((x) => x.lang === "go" && x.confidence === "exact" && x.via === "type");
  check(
    "go receiver type resolves Store.Save",
    !!goTypeHit && goTypeHit.resolved_to?.symbol === "Store.Save",
    r.results
  );

  r = parse(await c.callTool({ name: "find_references", arguments: { name: "save", root } }));
  check(
    "find_references save has exact tier",
    r.ok === true && r.resolution?.exact >= 2 && r.results.some((x) => x.confidence === "exact" && x.resolved_to?.symbol === "UserService.save"),
    r
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "put", root } }));
  const inheritRecvHits = r.results?.filter((x) => x.lang === "java" && x.confidence === "exact" && x.via === "type");
  check(
    "java interface inheritance resolves put through Ext -> Base (field, this and implicit-this receivers)",
    inheritRecvHits?.length === 3 && inheritRecvHits.every((x) => x.resolved_to?.file === path.join(root, "a", "Base.java") && x.resolved_to?.symbol === "Base.put"),
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "save", root } }));
  const javaDispatchHit = r.results?.find(
    (x) => x.lang === "java" && x.recv === "store" && x.confidence === "exact" && x.via === "type"
  );
  check(
    "java interface-typed receiver dispatches to unique impl StoreImpl.save",
    !!javaDispatchHit && javaDispatchHit.resolved_to?.file === path.join(root, "a", "StoreImpl.java") && javaDispatchHit.resolved_to?.symbol === "StoreImpl.save",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "trim", root } }));
  const javaStaticHit = r.results?.find(
    (x) => x.lang === "java" && x.recv === "StringHelper" && x.confidence === "exact" && x.via === "type"
  );
  check(
    "java class-name receiver resolves static StringHelper.trim",
    !!javaStaticHit && javaStaticHit.resolved_to?.file === path.join(root, "a", "StringHelper.java") && javaStaticHit.resolved_to?.symbol === "StringHelper.trim",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "UserService", root } }));
  const javaNewHit = r.results?.find(
    (x) => x.lang === "java" && x.caller === "run" && x.confidence === "exact" && x.resolved_to?.file === path.join(root, "a", "UserService.java")
  );
  check(
    "java new UserService() captured and resolved via import",
    !!javaNewHit && javaNewHit.via === "import",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "___nope___", root } }));
  check("callers unknown name still ok", r.ok === true && r.total === 0, r);

  r = parse(await c.callTool({ name: "callers", arguments: { name: "setName", root } }));
  const accSetHit = r.results?.find((x) => x.lang === "java" && x.confidence === "exact" && x.via === "type");
  check(
    "java setter accessor synthesizes to User.name field",
    !!accSetHit && accSetHit.resolved_to?.file === path.join(root, "a", "User.java") && accSetHit.resolved_to?.symbol === "User.name",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "getName", root } }));
  const accGetHit = r.results?.find((x) => x.lang === "java" && x.confidence === "exact" && x.via === "type");
  check(
    "java getter accessor synthesizes to User.name field",
    !!accGetHit && accGetHit.resolved_to?.file === path.join(root, "a", "User.java") && accGetHit.resolved_to?.symbol === "User.name",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "findById", root } }));
  const anchorHit = r.results?.find((x) => x.lang === "java" && x.confidence === "likely" && x.via === "type");
  check(
    "java external-base member anchors likely to ExtRepo",
    !!anchorHit && anchorHit.resolved_to?.file === path.join(root, "a", "ExtRepo.java") && anchorHit.resolved_to?.symbol === "ExtRepo",
    r.results
  );

  r = parse(await c.callTool({ name: "callers", arguments: { name: "displayName", root } }));
  const displayNameHits = r.results?.filter((x) => x.lang === "java" && x.confidence === "exact" && x.via === "type");
  check(
    "java chained receiver resolves through getProfile return type",
    !!displayNameHits?.find((x) => x.recv === "user.getProfile()") && displayNameHits.find((x) => x.recv === "user.getProfile()").resolved_to?.file === path.join(root, "a", "Profile.java") && displayNameHits.find((x) => x.recv === "user.getProfile()").resolved_to?.symbol === "Profile.displayName",
    r.results
  );
  check(
    "java for-each variable vartype collected and resolved",
    displayNameHits?.length === 2 && !!displayNameHits.find((x) => x.recv === "p" && x.resolved_to?.symbol === "Profile.displayName"),
    r.results
  );
} finally {
  await c.close();
  fsSync.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
