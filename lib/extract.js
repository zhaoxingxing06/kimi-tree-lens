const MAX_IMPORTS_PER_FILE = 100;
const MAX_IMPORT_NAMES = 50;
const MAX_VARTYPES_PER_FILE = 200;
const MAX_NAME_LEN = 100;

const text = (n) => (n && n.text ? n.text : null);
const clipName = (s) => (s && s.length > 0 && s.length <= MAX_NAME_LEN ? s : null);

function* walkNodes(node, depth = 0) {
  if (!node || depth > 2000) return;
  yield node;
  for (let i = 0; i < node.childCount; i++) yield* walkNodes(node.child(i), depth + 1);
}

function firstChildOfType(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function childrenOfType(node, type) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

export function baseType(raw) {
  if (!raw) return null;
  let t = String(raw)
    .replace(/<[\s\S]*>/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/^\*+/, "")
    .replace(/\[\]*/g, "")
    .trim();
  if (!t) return null;
  const parts = t.split(".").filter(Boolean);
  t = parts[parts.length - 1] ?? t;
  t = t.replace(/[^A-Za-z0-9_$]/g, "");
  return t || null;
}

const JAVA_CONTAINERS = new Set([
  "class_declaration", "interface_declaration", "enum_declaration", "record_declaration",
]);
const PY_CONTAINERS = new Set(["class_definition"]);
const TS_CONTAINERS = new Set(["class_declaration", "abstract_class_declaration", "enum_declaration", "interface_declaration"]);

export function qualnameOf(defNode, lang) {
  if (!defNode) return null;
  const defName =
    text(defNode.childForFieldName?.("name")) ??
    text(defNode.childForFieldName?.("declarator")?.childForFieldName?.("name"));
  if (!defName) return null;
  const containers = lang === "java" ? JAVA_CONTAINERS : lang === "python" ? PY_CONTAINERS : TS_CONTAINERS;
  const chain = [];
  let p = defNode.parent;
  while (p) {
    if (containers.has(p.type)) {
      const n = text(p.childForFieldName?.("name"));
      if (n) chain.unshift(n);
    }
    p = p.parent;
  }
  if (lang === "go" && defNode.type === "method_declaration") {
    const recv = defNode.childForFieldName?.("receiver");
    const decl =
      recv?.type === "parameter_list"
        ? recv.children.find((c) => c.type === "parameter_declaration") ?? null
        : recv;
    const typeNode = decl?.childForFieldName?.("type");
    const t = baseType(text(typeNode));
    if (t) return `${t}.${defName}`;
  }
  return chain.length ? `${[...chain, defName].join(".")}` : null;
}

function pushImport(out, imp) {
  if (out.length >= MAX_IMPORTS_PER_FILE) return;
  if (imp.src && imp.src.length > MAX_NAME_LEN) return;
  out.push({
    src: imp.src ?? null,
    ...(imp.fqn ? { fqn: imp.fqn.slice(0, 200) } : {}),
    ...(imp.static ? { static: true } : {}),
    ...(imp.wildcard ? { wildcard: true } : {}),
    names: (imp.names ?? []).filter(Boolean).slice(0, MAX_IMPORT_NAMES),
  });
}

function javaImports(tree) {
  const out = [];
  let pkg = null;
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "package_declaration") {
      pkg = clipName(text(firstChildOfType(n, "scoped_identifier") ?? firstChildOfType(n, "identifier")));
    } else if (n.type === "import_declaration") {
      const isStatic = n.children.some((c) => c.type === "static");
      const target = firstChildOfType(n, "scoped_identifier") ?? firstChildOfType(n, "identifier");
      const fqn = text(target);
      if (!fqn) continue;
      const wildcard = n.children.some((c) => c.text === "*");
      const segs = fqn.split(".");
      const names = wildcard ? [] : [segs[segs.length - 1]];
      pushImport(out, { src: fqn, fqn, static: isStatic, wildcard, names });
    }
  }
  return { pkg, imports: out };
}

function pythonImports(tree) {
  const out = [];
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "import_statement") {
      for (const c of n.children) {
        if (c.type === "dotted_name") {
          pushImport(out, { src: text(c), names: [c.text.split(".").pop()] });
        } else if (c.type === "aliased_import") {
          const name = text(c.childForFieldName?.("name"));
          if (name) pushImport(out, { src: name, names: [name.split(".").pop()] });
        }
      }
    } else if (n.type === "import_from_statement") {
      const mod = n.childForFieldName?.("module_name");
      const src = text(mod);
      if (!src) continue;
      const names = [];
      let wildcard = false;
      for (const c of n.children) {
        if (c.type === "dotted_name" && c !== mod) names.push(text(c));
        else if (c.type === "aliased_import") {
          const nm = text(c.childForFieldName?.("name"));
          if (nm) names.push(nm);
        } else if (c.type === "wildcard_import") wildcard = true;
      }
      pushImport(out, { src, wildcard, names });
    }
  }
  return { pkg: null, imports: out };
}

function tsImports(tree) {
  const out = [];
  const collectClause = (clause, imp) => {
    if (!clause) return;
    for (const c of clause.children) {
      if (c.type === "identifier") imp.names.push(text(c));
      else if (c.type === "namespace_import") {
        const nm = text(c.childForFieldName?.("name"));
        if (nm) imp.names.push(nm);
      } else if (c.type === "named_imports") {
        for (const s of childrenOfType(c, "import_specifier")) {
          const nm = text(s.childForFieldName?.("alias") ?? s.childForFieldName?.("name"));
          if (nm) imp.names.push(nm);
        }
      }
    }
  };
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "import_statement") {
      const srcNode = n.childForFieldName?.("source");
      const src = srcNode ? srcNode.text.replace(/^['"]|['"]$/g, "") : null;
      if (!src) continue;
      const imp = { src, names: [] };
      collectClause(firstChildOfType(n, "import_clause"), imp);
      pushImport(out, imp);
    } else if (n.type === "export_statement") {
      const srcNode = n.childForFieldName?.("source");
      if (!srcNode) continue;
      const src = srcNode.text.replace(/^['"]|['"]$/g, "");
      const clause = firstChildOfType(n, "export_clause");
      const imp = { src, names: [] };
      if (clause) {
        for (const s of childrenOfType(clause, "export_specifier")) {
          const nm = text(s.childForFieldName?.("alias") ?? s.childForFieldName?.("name"));
          if (nm) imp.names.push(nm);
        }
      }
      pushImport(out, imp);
    }
  }
  return { pkg: null, imports: out };
}

function goImports(tree) {
  const out = [];
  let pkg = null;
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "package_clause") {
      pkg = clipName(text(firstChildOfType(n, "package_identifier")));
    } else if (n.type === "import_spec") {
      const pathNode = n.childForFieldName?.("path");
      if (!pathNode) continue;
      const src = pathNode.text.replace(/^"|"$/g, "");
      const nameNode = n.childForFieldName?.("name");
      const localName = nameNode && nameNode.text !== "_" && nameNode.text !== "." ? nameNode.text : src.split("/").pop();
      pushImport(out, { src, names: localName ? [localName] : [] });
    }
  }
  return { pkg, imports: out };
}

function vartypePut(map, name, type) {
  const n = clipName(name);
  const t = clipName(type);
  if (!n || !t || map.size >= MAX_VARTYPES_PER_FILE || map.has(n)) return;
  map.set(n, t);
}

function javaVartypes(tree, map) {
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "field_declaration" || n.type === "local_variable_declaration") {
      const t = text(n.childForFieldName?.("type"));
      if (!t) continue;
      for (const d of childrenOfType(n, "variable_declarator")) {
        const name = text(d.childForFieldName?.("name"));
        vartypePut(map, name, t);
      }
    } else if (n.type === "formal_parameter") {
      const t = text(n.childForFieldName?.("type"));
      const decl = n.childForFieldName?.("name");
      const name = decl ? text(decl.childForFieldName?.("name") ?? decl) : null;
      vartypePut(map, name, t);
    } else if (n.type === "enhanced_for_statement") {
      const kids = n.children.filter((c) => c.isNamed && c.type !== "modifiers");
      vartypePut(map, kids[1] ? text(kids[1]) : null, kids[0] ? text(kids[0]) : null);
    } else if (n.type === "catch_formal_parameter") {
      const ct = firstChildOfType(n, "catch_type");
      const t = text(ct);
      const first = t ? t.split("|")[0].trim() : null;
      vartypePut(map, text(n.childForFieldName?.("name")), first);
    }
  }
}

function pythonVartypes(tree, map) {
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "assignment") {
      const t = n.childForFieldName?.("type");
      if (!t) continue;
      const left = n.childForFieldName?.("left");
      const name = left ? text(left.childForFieldName?.("name") ?? left) : null;
      vartypePut(map, name, text(t));
    } else if (n.type === "typed_parameter" || n.type === "typed_default_parameter") {
      const t = n.childForFieldName?.("type") ?? firstChildOfType(n, "type");
      const name = n.childForFieldName?.("name") ?? firstChildOfType(n, "identifier");
      vartypePut(map, text(name), text(t));
    }
  }
}

function annTypeText(ann) {
  if (!ann) return null;
  const v = ann.childForFieldName?.("value") ?? ann.childForFieldName?.("type");
  if (v) return text(v);
  const kids = ann.children.filter((c) => c.type !== ":");
  return text(kids[kids.length - 1] ?? null);
}

function tsVartypes(tree, map) {
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "variable_declarator") {
      vartypePut(map, text(n.childForFieldName?.("name")), annTypeText(firstChildOfType(n, "type_annotation")));
    } else if (n.type === "required_parameter" || n.type === "optional_parameter") {
      vartypePut(map, text(n.childForFieldName?.("pattern")), annTypeText(firstChildOfType(n, "type_annotation")));
    } else if (n.type === "property_signature") {
      vartypePut(map, text(n.childForFieldName?.("name")), annTypeText(firstChildOfType(n, "type_annotation")));
    }
  }
}

function goVartypes(tree, map) {
  for (const n of walkNodes(tree.rootNode)) {
    if (n.type === "parameter_declaration" || n.type === "var_spec" || n.type === "field_declaration") {
      const t = text(n.childForFieldName?.("type"));
      const name = n.childForFieldName?.("name");
      vartypePut(map, text(name), t);
    }
  }
}

function collectTypeIds(node, depth, out, extra) {
  if (!node || depth > 3) return;
  if (node.type === "type_arguments") return;
  if (node.type === "type_identifier" || node.type === "scoped_type_identifier" || (extra && extra.includes(node.type))) {
    out.push(node);
    return;
  }
  for (let i = 0; i < node.childCount; i++) collectTypeIds(node.child(i), depth + 1, out, extra);
}

export function basesOf(defNode, lang) {
  try {
    if (lang === "java" && (defNode.type === "class_declaration" || defNode.type === "interface_declaration" || defNode.type === "record_declaration")) {
      const ids = [];
      for (const ct of ["superclass", "super_interfaces", "extends_interfaces", "interfaces"]) {
        const cl = defNode.childForFieldName?.(ct) ?? defNode.children.find((c) => c.type === ct);
        if (cl) collectTypeIds(cl, 0, ids);
      }
      const out = [];
      for (const id of ids) {
        const t = baseType(text(id));
        if (t) out.push(t);
      }
      return [...new Set(out)].slice(0, 10);
    }
    if (lang === "python" && defNode.type === "class_definition") {
      const args = defNode.childForFieldName?.("superclasses") ?? defNode.childForFieldName?.("parameters");
      const out = [];
      if (args) {
        for (const c of args.children) {
          if (c.type === "identifier") {
            const t = baseType(text(c));
            if (t) out.push(t);
          }
        }
      }
      return [...new Set(out)].slice(0, 10);
    }
    if ((lang === "typescript" || lang === "tsx") && (defNode.type === "class_declaration" || defNode.type === "abstract_class_declaration" || defNode.type === "interface_declaration")) {
      const ids = [];
      for (const ct of ["class_heritage", "extends_type_clause", "extends_clause", "implements_clause", "heritage"]) {
        const cl = defNode.childForFieldName?.(ct) ?? defNode.children.find((c) => c.type === ct);
        if (cl) collectTypeIds(cl, 0, ids, defNode.type === "interface_declaration" ? [] : ["identifier", "member_expression"]);
      }
      const out = [];
      for (const id of ids) {
        const t = baseType(text(id));
        if (t) out.push(t);
      }
      return [...new Set(out)].slice(0, 10);
    }
  } catch {}
  return [];
}

export function retOf(defNode, lang) {
  if (lang !== "java" || !defNode || defNode.type !== "method_declaration") return null;
  const t = text(defNode.childForFieldName?.("type"));
  if (!t || t === "void") return null;
  return baseType(t);
}

export function importsAndPackageOf(tree, lang) {
  try {
    if (lang === "java") return javaImports(tree);
    if (lang === "python") return pythonImports(tree);
    if (lang === "typescript" || lang === "tsx") return tsImports(tree);
    if (lang === "go") return goImports(tree);
  } catch {}
  return { pkg: null, imports: [] };
}

export function vartypesOf(tree, lang) {
  const map = new Map();
  try {
    if (lang === "java") javaVartypes(tree, map);
    else if (lang === "python") pythonVartypes(tree, map);
    else if (lang === "typescript" || lang === "tsx") tsVartypes(tree, map);
    else if (lang === "go") goVartypes(tree, map);
  } catch {}
  return Object.fromEntries(map);
}
