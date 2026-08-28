export const PATTERNS = {
  java: [
    {
      name: "exec-calls",
      description: "JDBC execute/executeQuery/executeUpdate call sites",
      query: '((method_invocation name: (identifier) @fn) (#match? @fn "^execute"))',
    },
    {
      name: "system-exit",
      description: "System.exit call sites",
      query:
        '((method_invocation object: (identifier) @recv name: (identifier) @fn) (#eq? @recv "System") (#eq? @fn "exit"))',
    },
    {
      name: "reflection-class-load",
      description: "Class.forName dynamic loading",
      query:
        '((method_invocation object: (identifier) @recv name: (identifier) @fn) (#eq? @recv "Class") (#eq? @fn "forName"))',
    },
  ],
  python: [
    {
      name: "eval-exec",
      description: "eval/exec/compile calls",
      query: '((call function: (identifier) @fn) (#match? @fn "^(eval|exec|compile)$"))',
    },
    {
      name: "subprocess-shell-true",
      description: "subprocess keyword shell=... usage",
      query: "(keyword_argument name: (identifier) @kw) (#eq? @kw \"shell\")",
    },
    {
      name: "marshal-pickle",
      description: "pickle/marshal load calls",
      query: '((call function: (attribute attribute: (identifier) @mod) (#match? @mod "^(pickle|marshal|dill)$"))',
    },
  ],
  go: [
    {
      name: "exec-command",
      description: "os/exec Command/CommandContext call sites",
      query:
        '((call_expression function: (selector_expression field: (field_identifier) @fn)) (#match? @fn "^(Command|CommandContext)$"))',
    },
    {
      name: "panic",
      description: "panic calls",
      query: '((call_expression function: (identifier) @fn) (#eq? @fn "panic"))',
    },
    {
      name: "unsafe-pointer",
      description: "unsafe.Pointer references",
      query:
        '((selector_expression object: (identifier) @pkg field: (field_identifier) @field) (#eq? @pkg "unsafe") (#eq? @field "Pointer"))',
    },
  ],
  typescript: [
    {
      name: "eval-usage",
      description: "eval calls",
      query: '((call_expression function: (identifier) @fn) (#eq? @fn "eval"))',
    },
    {
      name: "innerhtml-assign",
      description: "assignments to .innerHTML (XSS vector)",
      query:
        '(assignment_expression left: (member_expression property: (property_identifier) @prop) (#eq? @prop "innerHTML"))',
    },
    {
      name: "dynamic-import",
      description: "dynamic import() expressions",
      query: "(call_expression function: (import_expression))",
    },
  ],
  tsx: [
    {
      name: "dangerously-set-html",
      description: "dangerouslySetInnerHTML props (React XSS vector)",
      query:
        '(jsx_attribute (property_identifier) @prop (#eq? @prop "dangerouslySetInnerHTML"))',
    },
  ],
};
