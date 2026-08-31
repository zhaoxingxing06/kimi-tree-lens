import path from "node:path";
import { baseType } from "./extract.js";

export const CLASS_KINDS = new Set(["class", "interface", "record", "type"]);

const TS_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.mts", "/index.cts"];

function relPosix(root, file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  return rel.startsWith("..") ? null : rel;
}

export function buildResolver({ root, files, defs }) {
  const defsByName = new Map();
  const classesByName = new Map();
  const basesByFileClass = new Map();
  const classesByFile = new Map();
  for (const d of defs) {
    if (!defsByName.has(d.name)) defsByName.set(d.name, []);
    defsByName.get(d.name).push(d);
    if (CLASS_KINDS.has(d.kind)) {
      if (!classesByName.has(d.name)) classesByName.set(d.name, []);
      classesByName.get(d.name).push(d);
      if (!classesByFile.has(d.file)) classesByFile.set(d.file, []);
      classesByFile.get(d.file).push(d);
      if (Array.isArray(d.bases) && d.bases.length) {
        basesByFileClass.set(`${d.file}|${d.qualname ?? d.name}`, d.bases);
      }
    }
  }
  const importsByFile = new Map();
  const vartypesByFile = new Map();
  const langByFile = new Map();
  const dirFiles = new Map();
  const fileByRel = new Map();
  const suffixIndex = new Map();
  const dirIndex = new Map();
  const pkgIndex = new Map();
  const implsByBase = new Map();
  for (const d of defs) {
    if (d.kind === "interface" || !CLASS_KINDS.has(d.kind)) continue;
    const seen = new Set();
    const stack = [...(basesByFileClass.get(`${d.file}|${d.qualname ?? d.name}`) ?? [])];
    while (stack.length) {
      const b = stack.pop();
      if (seen.has(b)) continue;
      seen.add(b);
      const bClasses = classesByName.get(b);
      if (bClasses && bClasses.length === 1) {
        stack.push(...(basesByFileClass.get(`${bClasses[0].file}|${bClasses[0].qualname ?? bClasses[0].name}`) ?? []));
      }
    }
    for (const b of seen) {
      if (!implsByBase.has(b)) implsByBase.set(b, new Set());
      implsByBase.get(b).add(d);
    }
  }
  for (const f of files) {
    const rel = relPosix(root, f.path);
    importsByFile.set(f.path, f.imports ?? []);
    vartypesByFile.set(f.path, f.vartypes ?? {});
    langByFile.set(f.path, f.lang);
    if (f.pkg) {
      if (!pkgIndex.has(f.pkg)) pkgIndex.set(f.pkg, new Set());
      pkgIndex.get(f.pkg).add(f.path);
    }
    if (!rel) continue;
    fileByRel.set(rel, f.path);
    const segs = rel.split("/");
    for (let k = 1; k <= Math.min(4, segs.length); k++) {
      const key = segs.slice(-k).join("/");
      if (!suffixIndex.has(key)) suffixIndex.set(key, new Set());
      suffixIndex.get(key).add(f.path);
    }
    const dir = segs.length > 1 ? segs.slice(0, -1).join("/") : "";
    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir).push(f.path);
    const dsegs = dir.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(5, dsegs.length); k++) {
      const key = dsegs.slice(-k).join("/");
      if (!dirIndex.has(key)) dirIndex.set(key, new Set());
      dirIndex.get(key).add(f.path);
    }
  }
  return {
    root,
    defsByName,
    classesByName,
    basesByFileClass,
    classesByFile,
    importsByFile,
    vartypesByFile,
    langByFile,
    dirFiles,
    fileByRel,
    suffixIndex,
    dirIndex,
    pkgIndex,
    implsByBase,
  };
}

function defsInFile(state, name, file) {
  return (state.defsByName.get(name) ?? []).filter((d) => d.file === file);
}

function uniqueFileOf(cands) {
  const files = [...new Set(cands.map((d) => d.file))];
  return files.length === 1 ? files[0] : null;
}

function memberOfDeep(state, name, classDef, seen = new Set()) {
  const clsKey = `${classDef.file}|${classDef.qualname ?? classDef.name}`;
  if (!seen.has(clsKey)) {
    const clsQual = classDef.qualname ?? classDef.name;
    const direct = (state.defsByName.get(name) ?? []).find(
      (d) => d.file === classDef.file && d.kind !== "field" && d.qualname && d.qualname.startsWith(clsQual + ".")
    );
    if (direct) return direct;
    seen.add(clsKey);
  }
  const bases = state.basesByFileClass.get(clsKey) ?? [];
  for (const base of bases) {
    const classes = state.classesByName.get(base);
    if (!classes || classes.length !== 1) continue;
    const found = memberOfDeep(state, name, classes[0], seen);
    if (found) return found;
  }
  return null;
}

function fieldInClass(state, propName, classDef, seen = new Set()) {
  const clsKey = `${classDef.file}|${classDef.qualname ?? classDef.name}`;
  if (!seen.has(clsKey)) {
    const clsQual = classDef.qualname ?? classDef.name;
    const direct = (state.defsByName.get(propName) ?? []).find(
      (d) => d.kind === "field" && d.file === classDef.file && d.qualname && d.qualname.startsWith(clsQual + ".")
    );
    if (direct) return direct;
    seen.add(clsKey);
  }
  const bases = state.basesByFileClass.get(clsKey) ?? [];
  for (const base of bases) {
    const classes = state.classesByName.get(base);
    if (!classes || classes.length !== 1) continue;
    const found = fieldInClass(state, propName, classes[0], seen);
    if (found) return found;
  }
  return null;
}

const OBJECT_METHODS = new Set(["toString", "equals", "hashCode", "getClass", "clone", "notify", "notifyAll", "wait"]);

function accessorSynthesis(state, name, file, classDef) {
  if (state.langByFile.get(file) !== "java") return null;
  const m = name.match(/^(?:get|set|is)([A-Z]\w*)$/);
  if (!m) return null;
  const prop = m[1].charAt(0).toLowerCase() + m[1].slice(1);
  const field = fieldInClass(state, prop, classDef);
  if (!field) return null;
  return hit("exact", "type", field.file, field.qualname);
}

function resolveExternalAnchor(state, name, file, recv) {
  if (!recv || OBJECT_METHODS.has(name)) return null;
  const recvStr = String(recv).trim();
  if (recvStr === "this" || recvStr.startsWith("this.") || recvStr === "super" || recvStr.startsWith("super.")) return null;
  if (recvStr.includes("(")) return null;
  const base = recvStr.split(".").pop().replace(/^this\.?/, "").replace(/^\*+/, "").trim();
  if (!base) return null;
  const declared = state.vartypesByFile.get(file)?.[base];
  if (!declared) return null;
  const typeName = baseType(declared);
  if (!typeName) return null;
  const classes = state.classesByName.get(typeName);
  if (!classes || classes.length !== 1) return null;
  const cls = classes[0];
  return hit("likely", "type", cls.file, cls.qualname ?? cls.name);
}

function hit(confidence, via, file, symbol) {
  return { confidence, via, ...(file ? { resolved_to: { file, ...(symbol ? { symbol } : {}) } } : {}) };
}

function classesInFile(state, file) {
  return (state.classesByFile.get(file) ?? []);
}

function dispatchToImpl(state, member) {
  const q = member.qualname ?? "";
  const dot = q.lastIndexOf(".");
  if (dot <= 0) return null;
  const ownerQual = q.slice(0, dot);
  const ownerName = ownerQual.split(".").pop();
  const owner = (state.defsByName.get(ownerName) ?? []).find((d) => {
    if (d.file !== member.file) return false;
    if (ownerQual.includes(".")) return d.qualname === ownerQual;
    return (d.qualname ?? d.name) === ownerQual;
  });
  if (!owner || owner.kind !== "interface") return null;
  const impls = state.implsByBase.get(owner.name);
  if (!impls || impls.size !== 1) return null;
  const impl = [...impls][0];
  const m2 = memberOfDeep(state, member.name, impl);
  if (!m2 || (m2.file === member.file && m2.qualname === member.qualname)) return null;
  return hit("exact", "type", m2.file, m2.qualname);
}

function resolveOnType(state, name, file, typeName) {
  if (!typeName) return null;
  const classes = state.classesByName.get(typeName);
  if (!classes || classes.length !== 1) return null;
  const member = memberOfDeep(state, name, classes[0]);
  if (member) return dispatchToImpl(state, member) ?? hit("exact", "type", member.file, member.qualname);
  const acc = accessorSynthesis(state, name, file, classes[0]);
  if (acc) return acc;
  return null;
}

function resolveRecvType(state, recvStr, file, depth) {
  if (depth > 3) return null;
  let head = recvStr;
  let lastMethod = null;
  if (recvStr.includes("(")) {
    const m = /^(.+)\.([A-Za-z_$][\w$]*)\(\)$/.exec(recvStr);
    if (!m) return null;
    head = m[1].trim();
    lastMethod = m[2];
  }
  let typeName = null;
  if (head === "this" || head === "super") {
    const own = classesInFile(state, file);
    if (own.length !== 1) return null;
    typeName = own[0].qualname ?? own[0].name;
  } else if (head.includes("(")) {
    typeName = resolveRecvType(state, head, file, depth + 1);
  } else {
    const base = head.split(".").pop().replace(/^this\.?/, "").replace(/^\*+/, "").trim();
    const declared = base ? state.vartypesByFile.get(file)?.[base] : null;
    typeName = declared ? baseType(declared) : null;
  }
  if (!typeName) return null;
  if (!lastMethod) return typeName;
  const classes = state.classesByName.get(typeName);
  if (!classes || classes.length !== 1) return null;
  const method = memberOfDeep(state, lastMethod, classes[0]);
  if (!method || method.kind === "field") return null;
  return baseType(method.ret ?? null);
}

function resolveByReceiver(state, name, file, recv) {
  if (!recv) return null;
  const recvStr = String(recv).trim();
  if (recvStr.includes("(")) {
    return resolveOnType(state, name, file, resolveRecvType(state, recvStr, file, 0));
  }
  if (recvStr === "this" || recvStr.startsWith("this.") || recvStr === "super" || recvStr.startsWith("super.")) {
    const own = classesInFile(state, file);
    if (own.length) {
      const direct = own.some((cls) => {
        const q = cls.qualname ?? cls.name;
        return (state.defsByName.get(name) ?? []).some(
          (d) => d.file === file && d.qualname && d.qualname.startsWith(q + ".")
        );
      });
      if (direct) return null;
      for (const cls of own) {
        const seen = new Set([`${cls.file}|${cls.qualname ?? cls.name}`]);
        const m = memberOfDeep(state, name, cls, seen);
        if (m) return hit("exact", "type", m.file, m.qualname);
      }
      for (const cls of own) {
        const acc = accessorSynthesis(state, name, file, cls);
        if (acc) return acc;
      }
    }
    return null;
  }
  const base = recvStr.split(".").pop().replace(/^this\.?/, "").replace(/^\*+/, "").trim();
  if (!base) return null;
  const declared = state.vartypesByFile.get(file)?.[base];
  if (!declared) {
    const recvClasses = state.classesByName.get(base);
    if (!recvClasses || recvClasses.length !== 1) return null;
    const member = memberOfDeep(state, name, recvClasses[0]);
    if (member) return hit("exact", "type", member.file, member.qualname);
    return null;
  }
  return resolveOnType(state, name, file, baseType(declared));
}

function resolveLocal(state, name, file) {
  const local = defsInFile(state, name, file);
  if (!local.length) return null;
  const d = local[0];
  return hit("exact", "local", d.file, d.qualname);
}

function filesBySuffix(state, want) {
  if (!want) return [];
  return [...(state.suffixIndex.get(want) ?? [])];
}

function javaImportTarget(state, fqn) {
  if (!fqn) return null;
  const segs = fqn.split(".").filter(Boolean);
  if (segs.length < 2) return null;
  const cls = segs.pop();
  const inPkg = state.pkgIndex.get(segs.join("."));
  if (inPkg && inPkg.size) {
    const hits = [...inPkg].filter((f) => (state.defsByName.get(cls) ?? []).some((d) => d.file === f));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  const files = filesBySuffix(state, segs.join("/") + "/" + cls + ".java");
  return files.length === 1 ? files[0] : null;
}

function pythonImportTargets(state, imp, file) {
  const rel = relPosix(state.root, file);
  if (!rel) return [];
  const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  let stem = imp.src ?? "";
  let upLevels = 0;
  const dots = stem.match(/^\.+/);
  if (dots) {
    upLevels = dots[0].length - 1;
    stem = stem.replace(/^\.+/, "");
  }
  const dirSegs = relDir.split("/").filter(Boolean);
  const base = upLevels ? dirSegs.slice(0, Math.max(0, dirSegs.length - upLevels)) : dirSegs;
  const relStem = [...base, ...stem.split(".").filter(Boolean)].join("/");
  if (!dots) {
    const bare = stem.replace(/\./g, "/");
    for (const k of [`${bare}.py`, `${bare}/__init__.py`]) {
      const files = filesBySuffix(state, k);
      if (files.length) return files;
    }
    return [];
  }
  const out = [];
  for (const w of [`${relStem}.py`, `${relStem}/__init__.py`]) {
    const f = state.fileByRel.get(w);
    if (f) out.push(f);
  }
  return out;
}

function tsImportTargets(state, imp, file) {
  const src = imp.src ?? "";
  if (!/^\.{1,2}\//.test(src) && !src.startsWith("/")) return [];
  const abs = path.resolve(path.dirname(file), src);
  const rel = relPosix(state.root, abs);
  if (!rel) return [];
  const out = [];
  for (const ext of TS_EXTS) {
    const f = state.fileByRel.get(rel + ext);
    if (f) out.push(f);
  }
  return out;
}

function goImportTargets(state, imp) {
  const want = imp.src ?? "";
  if (!want) return [];
  const segs = want.split("/").filter(Boolean);
  for (let k = Math.min(5, segs.length); k >= 1; k--) {
    const files = state.dirIndex.get(segs.slice(-k).join("/"));
    if (files && files.size) return [...files];
  }
  return [];
}

function resolveByImport(state, name, file) {
  const imps = state.importsByFile.get(file) ?? [];
  for (const imp of imps) {
    if (imp.wildcard) continue;
    if (!(imp.names ?? []).includes(name)) continue;
    const lang = state.langByFile.get(file);
    let targets = [];
    if (lang === "java") {
      if (imp.static) {
        const clsFile = javaImportTarget(state, (imp.fqn ?? "").replace(/\.[^.]+$/, ""));
        if (clsFile && defsInFile(state, name, clsFile).length) {
          return hit("exact", "import-static", clsFile, name);
        }
        continue;
      }
      if (imp.wildcard) {
        const inPkg = state.pkgIndex.get(imp.fqn ?? "");
        if (inPkg && inPkg.size) {
          const cands = (state.defsByName.get(name) ?? []).filter((d) => inPkg.has(d.file));
          const f = uniqueFileOf(cands);
          if (f) {
            const d = cands.find((c) => c.file === f);
            return hit("exact", "import-wildcard", f, d.qualname);
          }
        }
        continue;
      }
      const t = javaImportTarget(state, imp.fqn);
      if (t) targets = [t];
    } else if (lang === "python") {
      targets = pythonImportTargets(state, imp, file);
    } else if (lang === "typescript" || lang === "tsx") {
      targets = tsImportTargets(state, imp, file);
    } else if (lang === "go") {
      targets = goImportTargets(state, imp);
    }
    const cands = (state.defsByName.get(name) ?? []).filter((d) => targets.includes(d.file));
    const f = uniqueFileOf(cands);
    if (f) {
      const d = cands.find((c) => c.file === f);
      return hit("exact", "import", f, d.qualname);
    }
  }
  return null;
}

export function classifyByImport(state, name, file) {
  return resolveByImport(state, name, file);
}

function resolveSameDir(state, name, file) {
  const rel = relPosix(state.root, file);
  const dir = rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const peers = state.dirFiles.get(dir) ?? [];
  const cands = (state.defsByName.get(name) ?? []).filter((d) => peers.includes(d.file) && d.file !== file);
  const f = uniqueFileOf(cands);
  return f ? hit("likely", "same-dir", f) : null;
}

function resolveUnique(state, name) {
  const f = uniqueFileOf(state.defsByName.get(name) ?? []);
  return f ? hit("likely", "unique", f) : null;
}

function resolveNameOnly(state, name) {
  const files = [...new Set((state.defsByName.get(name) ?? []).map((d) => d.file))];
  if (!files.length) return null;
  return files.length === 1 ? hit("name", "name", files[0]) : hit("name", "name");
}

function resolveImplicitThis(state, name, file) {
  if (state.langByFile.get(file) !== "java") return null;
  const own = classesInFile(state, file);
  if (!own.length) return null;
  const direct = own.some((cls) => {
    const q = cls.qualname ?? cls.name;
    return (state.defsByName.get(name) ?? []).some(
      (d) => d.file === file && d.qualname && d.qualname.startsWith(q + ".")
    );
  });
  if (direct) return null;
  for (const cls of own) {
    const seen = new Set([`${cls.file}|${cls.qualname ?? cls.name}`]);
    const m = memberOfDeep(state, name, cls, seen);
    if (m) return hit("exact", "type", m.file, m.qualname);
  }
  return null;
}

export function classifyRef(state, { name, file, recv }) {
  if (!state || !name || !file) return null;
  const resolved =
    resolveByReceiver(state, name, file, recv) ??
    resolveLocal(state, name, file) ??
    resolveByImport(state, name, file) ??
    resolveExternalAnchor(state, name, file, recv) ??
    (recv ? null : resolveImplicitThis(state, name, file)) ??
    resolveSameDir(state, name, file);
  if (resolved) return resolved;
  return recv ? resolveNameOnly(state, name) : resolveUnique(state, name);
}
