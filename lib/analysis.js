import { baseType } from "./extract.js";

export const COMPLEXITY_SPEC = {
  java: {
    functions: ["method_declaration", "constructor_declaration"],
    decisions: ["if_statement", "for_statement", "while_statement", "do_statement", "catch_clause", "conditional_expression", "switch_block_statement_group", "switch_rule"],
    operatorTypes: ["binary_expression"],
    operators: ["&&", "||"],
  },
  python: {
    functions: ["function_definition"],
    decisions: ["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "conditional_expression", "match_case"],
    operatorTypes: ["boolean_operator"],
    operators: ["and", "or"],
  },
  go: {
    functions: ["function_declaration", "method_declaration", "func_literal"],
    decisions: ["if_statement", "for_statement", "case_clause", "comm_clause"],
    operatorTypes: ["binary_expression"],
    operators: ["&&", "||"],
  },
  typescript: {
    functions: ["function_declaration", "method_definition", "generator_function_declaration", "function_expression", "arrow_function"],
    decisions: ["if_statement", "for_statement", "while_statement", "do_statement", "case_clause", "catch_clause", "conditional_expression"],
    operatorTypes: ["binary_expression"],
    operators: ["&&", "||"],
  },
  tsx: {
    functions: ["function_declaration", "method_definition", "generator_function_declaration", "function_expression", "arrow_function"],
    decisions: ["if_statement", "for_statement", "while_statement", "do_statement", "case_clause", "catch_clause", "conditional_expression"],
    operatorTypes: ["binary_expression"],
    operators: ["&&", "||"],
  },
};

export const CALL_SPEC = {
  java: {
    functions: ["method_declaration", "constructor_declaration"],
    calls: ["method_invocation", "object_creation_expression"],
    callee(node) {
      if (node.type === "object_creation_expression") {
        return baseType(node.childForFieldName("type")?.text ?? null);
      }
      return node.childForFieldName("name")?.text ?? null;
    },
  },
  python: {
    functions: ["function_definition"],
    calls: ["call"],
    callee(node) {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier") return fn.text;
      if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
      return null;
    },
  },
  go: {
    functions: ["function_declaration", "method_declaration", "func_literal"],
    calls: ["call_expression"],
    callee(node) {
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier") return fn.text;
      if (fn.type === "selector_expression") return fn.childForFieldName("field")?.text ?? null;
      return null;
    },
  },
  typescript: {
    functions: ["function_declaration", "method_definition", "function_expression", "arrow_function"],
    calls: ["call_expression", "new_expression"],
    callee(node) {
      if (node.type === "new_expression") {
        const ctor = node.childForFieldName("constructor");
        return ctor?.type === "identifier" ? ctor.text : null;
      }
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier") return fn.text;
      if (fn.type === "member_expression") return fn.childForFieldName("property")?.text ?? null;
      return null;
    },
  },
  tsx: {
    functions: ["function_declaration", "method_definition", "function_expression", "arrow_function"],
    calls: ["call_expression", "new_expression"],
    callee(node) {
      if (node.type === "new_expression") {
        const ctor = node.childForFieldName("constructor");
        return ctor?.type === "identifier" ? ctor.text : null;
      }
      const fn = node.childForFieldName("function");
      if (!fn) return null;
      if (fn.type === "identifier") return fn.text;
      if (fn.type === "member_expression") return fn.childForFieldName("property")?.text ?? null;
      return null;
    },
  },
};

function defNameOf(node) {
  return node.childForFieldName("name")?.text ?? null;
}

export function countDecisions(node, spec, depth = 0) {
  if (depth > 800) return 0;
  let n = 0;
  if (spec.decisions.includes(node.type)) n++;
  if (spec.operatorTypes.includes(node.type)) {
    for (const c of node.children) {
      if (spec.operators.includes(c.type)) n++;
    }
  }
  for (const c of node.children) {
    n += countDecisions(c, spec, depth + 1);
  }
  return n;
}

function recvText(node) {
  const clip = (n) => (n && n.text && n.text.length <= 80 ? n.text : null);
  const fn = node.childForFieldName("function") ?? node.childForFieldName("name");
  if (fn && (fn.type === "attribute" || fn.type === "member_expression" || fn.type === "selector_expression")) {
    return clip(fn.childForFieldName("object") ?? fn.childForFieldName("operand"));
  }
  if (node.type === "method_invocation") return clip(node.childForFieldName("object"));
  return null;
}

export function callsOf(tree, lang, maxCalls = 5000) {
  const spec = CALL_SPEC[lang];
  if (!spec) return [];
  const out = [];
  function visit(node, caller, depth) {
    if (out.length >= maxCalls || depth > 800) return;
    if (spec.functions.includes(node.type)) {
      caller = defNameOf(node) ?? caller;
    }
    if (spec.calls.includes(node.type)) {
      const callee = spec.callee(node);
      if (callee) out.push({ caller, callee, line: node.startPosition.row + 1, recv: recvText(node) });
    }
    for (const c of node.children) {
      visit(c, caller, depth + 1);
      if (out.length >= maxCalls) return;
    }
  }
  visit(tree.rootNode, null, 0);
  return out;
}
