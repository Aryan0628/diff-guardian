# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x (latest) | Yes |

As Diff Guardian is in active early development, security fixes are applied to the latest release only. Once the project reaches a stable `1.0` release, a formal support window will be defined.

---

## Reporting a Vulnerability

If you discover a security vulnerability in Diff Guardian, **please do not open a public issue.** Instead, report it privately so it can be addressed before disclosure.

### How to Report

Send an email to **aryangupta0628@gmail.com** with the following details:

| Field | Details |
|---|---|
| **Subject line** | `[SECURITY] Brief description of the vulnerability` |
| **Description** | A clear explanation of the vulnerability and its potential impact |
| **Reproduction steps** | Step-by-step instructions to reproduce the issue |
| **Affected versions** | Which version(s) of Diff Guardian are affected |
| **Environment** | OS, Node.js version, and any other relevant context |
| **Suggested fix** | If you have one (optional) |

### What to Expect

- **Acknowledgment** within 48 hours of your report.
- **Initial assessment** within 5 business days, including severity classification and estimated timeline.
- **Resolution** as quickly as possible, depending on complexity. You will be kept informed of progress.
- **Credit** in the release notes (unless you prefer to remain anonymous).

---

## Scope

The following are in scope for security reports:

- Arbitrary code execution through crafted input files or git diffs
- Path traversal vulnerabilities in file resolution or grammar loading
- Denial of service through malformed AST structures or unbounded recursion
- Information disclosure through error messages, reports, or log output
- Supply chain risks in WASM grammar loading or dependency resolution
- Vulnerabilities in the GitHub Actions integration (token handling, PR comment injection)

The following are **out of scope:**

- Vulnerabilities in upstream dependencies that have already been reported to their maintainers
- Issues requiring physical access to the machine running Diff Guardian
- Social engineering attacks

---

## Security Considerations

Diff Guardian processes source code and git diffs, which means it parses untrusted input. The project takes the following measures to reduce risk:

- **Sandboxed parsing.** All AST parsing runs through WASM-compiled Tree-Sitter grammars, which execute in a sandboxed WebAssembly environment.
- **No network access.** The core analysis pipeline makes no outbound network requests. The only network interaction is the optional GitHub PR comment feature, which uses the `GITHUB_TOKEN` provided by the CI environment.
- **No eval or dynamic code execution.** Diff Guardian does not evaluate or execute any of the code it analyzes.
- **Bounded recursion.** Barrel file resolution and tracer depth are capped by configurable limits (`maxBarrelDepth`, `maxTracerFiles`) to prevent unbounded resource consumption.

---

## Disclosure Policy

We follow a coordinated disclosure process:

1. The vulnerability is reported privately.
2. The maintainers assess severity and develop a fix.
3. A patched version is released.
4. The vulnerability is disclosed publicly in the release notes after the fix is available.

We ask that reporters allow a reasonable timeframe for a fix before any public disclosure.
