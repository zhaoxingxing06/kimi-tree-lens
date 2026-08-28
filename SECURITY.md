# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a vulnerability

This plugin is designed to be pointed at arbitrary code by an LLM agent, so confinement and
integrity issues are treated as security bugs. Please report privately via GitHub's
**Report a vulnerability** (Security tab → Advisories) rather than a public issue.

In scope:

- Path confinement escapes (symlink, TOCTOU, case-insensitivity, relative-path handling)
- Grammar WASM integrity bypass
- Persistence-cache injection beyond the documented trust boundary
- Anything allowing writes outside `~/.kimi-code/tree-sitter-plugin-cache` or network access

Out of scope:

- Issues requiring an attacker to already control the user's home directory
- Denial-of-service by feeding pathological inputs that the resource caps bound anyway

## Hardening references

The security model is documented in the README (path confinement, read-time re-validation,
SHA-256-pinned grammar WASMs, resource caps). Fix timeline: critical issues within 7 days,
others best-effort.
