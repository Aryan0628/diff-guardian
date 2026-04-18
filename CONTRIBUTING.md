# Contributing to Diff Guardian

Thank you for your interest in contributing to Diff Guardian. This guide covers everything you need to get started — from setting up your local environment to submitting a pull request.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Writing Classification Rules](#writing-classification-rules)
- [Adding Language Support](#adding-language-support)
- [Testing](#testing)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/diff-guardian.git
   cd diff-guardian
   ```
3. **Add the upstream remote:**
   ```bash
   git remote add upstream https://github.com/Aryan0628/diff-guardian.git
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/your-feature-name
   ```

---

## Development Setup

### Prerequisites

| Dependency | Version        |
| ---------- | -------------- |
| Node.js    | >= 18          |
| npm        | >= 9           |
| Git        | Latest stable  |

### Install Dependencies

```bash
npm install
```

### Build WASM Grammars

The WASM grammar binaries are not checked into git. You must build them locally after cloning:

```bash
npm run build:grammars
```

This downloads `wasi-sdk` and compiles Tree-Sitter grammars for TypeScript, JavaScript, Python, Go, Java, and Rust into WASM binaries in the `grammars/` directory.

### Build the Project

```bash
npm run build
```

### Run in Development Mode

```bash
npm run dev
```

### Verify Everything Works

```bash
# Type-check without emitting
npm run lint

# Run the test suite
npm test

# Run the CLI locally
npx dg --help
```

---

## Project Structure

```
diff-guardian/
├── src/
│   ├── cli.ts                  # CLI entry point — command routing
│   ├── config.ts               # Configuration loader (dg.config.json)
│   ├── index.ts                # Public API entry point (library consumers)
│   ├── pipeline.ts             # Orchestrates the full analysis pipeline
│   │
│   ├── core/
│   │   ├── types.ts            # Shared type definitions (signatures, changes)
│   │   ├── constants.ts        # Language-to-extension mappings
│   │   └── utils.ts            # Shared utilities
│   │
│   ├── parsers/
│   │   ├── git-diff.ts         # Git diff extraction (working tree, staged, ref comparison)
│   │   ├── ast-mapper.ts       # WASM Tree-Sitter AST parsing and signature extraction
│   │   └── translators/
│   │       ├── typescript.ts   # TypeScript/JavaScript translator
│   │       ├── python.ts       # Python translator
│   │       ├── go.ts           # Go translator
│   │       ├── java.ts         # Java translator
│   │       └── rust.ts         # Rust translator
│   │
│   ├── classifier/
│   │   ├── engine.ts           # Classification engine — runs all rules against signatures
│   │   ├── types.ts            # Rule and result types
│   │   └── rules/
│   │       ├── index.ts        # Rule barrel file
│   │       ├── R01_param_removed.ts
│   │       ├── R02_param_reordered.ts
│   │       ├── ...             # 26 rules total
│   │       └── R28_exported.ts
│   │
│   ├── reporter/
│   │   ├── types.ts            # Reporter interface and config types
│   │   ├── terminal.ts         # Terminal (CLI) reporter with chalk formatting
│   │   ├── github.ts           # GitHub PR comment reporter
│   │   └── json.ts             # JSON file reporter
│   │
│   └── tracer/
│       ├── index.ts            # Tracer barrel file
│       ├── scanner.ts          # JIT import scanner — finds all importers of a symbol
│       ├── tracer.ts           # Call-site tracer — resolves exact usage locations
│       └── languages/          # Language-specific import resolution
│
├── grammars/                   # Pre-built WASM grammar binaries
├── tests/                      # Test suite
├── .husky/                     # Git hook scripts
├── .github/workflows/          # CI/CD pipeline
├── dg.config.json              # Project configuration
├── tsconfig.json               # TypeScript configuration
└── vitest.config.ts            # Test runner configuration
```

---

## Development Workflow

### 1. Pick or Create an Issue

- Check the [Issues](https://github.com/Aryan0628/diff-guardian/issues) page for open items.
- If you want to work on something not listed, create an issue first to discuss scope and approach.
- Issues labeled `good first issue` are a great starting point for new contributors.

### 2. Create a Feature Branch

Use the following branch naming convention:

| Type          | Pattern           | Example                  |
| ------------- | ----------------- | ------------------------ |
| Feature       | `feat/<name>`     | `feat/gitlab-reporter`   |
| Bug fix       | `fix/<name>`      | `fix/enum-tracing-crash` |
| Documentation | `docs/<name>`     | `docs/api-examples`      |
| Refactor      | `refactor/<name>` | `refactor/tracer-perf`   |
| Chore         | `chore/<name>`    | `chore/update-deps`      |

### 3. Make Your Changes

- Follow existing code style and patterns.
- Add tests for all new functionality.
- Update documentation when your changes affect the public API or user-facing behavior.

### 4. Verify Locally

Run the full verification suite before submitting:

```bash
# Lint — ensure no type errors
npm run lint

# Run the full test suite
npm test

# Build — ensure it compiles cleanly
npm run build

# Run a local sanity check
npx dg check
```

### 5. Submit a Pull Request

See the [Pull Request Process](#pull-request-process) section below.

---

## Writing Classification Rules

Classification rules are the core of Diff Guardian's analysis engine. Each rule is a single TypeScript file in `src/classifier/rules/`.

### Rule Template

```typescript
// src/classifier/rules/R99_your_rule.ts

import { FunctionRule, RuleResult } from "../types";

export const yourRule: FunctionRule = {
  id: "R99",
  name: "Your Rule Name",
  description: "What this rule detects and why it matters.",
  languages: "all", // or specify: ['typescript', 'python']
  target: "function", // 'function' | 'interface' | 'enum'

  check(oldSig, newSig): RuleResult | null {
    // Compare oldSig and newSig
    // Return null if no issue detected
    // Return a RuleResult if the rule fires

    return {
      severity: "breaking", // 'breaking' | 'warning'
      changeType: "signature_change",
      message: "Describe exactly what changed and why it matters.",
    };
  },
};
```

### Checklist for New Rules

Before submitting a new rule, ensure the following:

1. Assign the next available rule ID (`R29`, `R30`, etc.)
2. Create the rule file in `src/classifier/rules/`
3. Export it from `src/classifier/rules/index.ts`
4. Write tests covering both positive and negative cases
5. Document the rule in the README classification rules table
6. Validate with a real codebase using `npx dg compare`

---

## Adding Language Support

To add support for a new programming language:

1. **Install the Tree-Sitter grammar:**

   ```bash
   npm install tree-sitter-<language>
   ```

2. **Build the WASM binary:**
   Add the build command to the `build:grammars` script in `package.json`.

3. **Create a translator:**
   Add `src/parsers/translators/<language>.ts` implementing the signature extraction logic. Use an existing translator (e.g., `typescript.ts`) as a reference.

4. **Register the language** in `src/core/constants.ts` with its file extensions.

5. **Add tracer support** for import resolution patterns in `src/tracer/languages/`.

6. **Write tests** covering the new language's function, interface, and enum signatures.

---

## Testing

Diff Guardian uses [Vitest](https://vitest.dev/) as its test framework.

```bash
# Run all tests
npm test

# Run tests in watch mode
npx vitest --watch

# Run a specific test file
npx vitest tests/classifier.test.ts

# Run tests with coverage
npx vitest --coverage
```

### Test Categories

| Category              | Scope                                        |
| --------------------- | -------------------------------------------- |
| **Unit tests**        | Individual rules, translators, and utilities |
| **Integration tests** | Full pipeline with real git diffs            |
| **Snapshot tests**    | Reporter output format stability             |

### Test Pattern

Follow the Arrange-Act-Assert pattern:

```typescript
import { describe, it, expect } from "vitest";

describe("R01: Parameter Removed", () => {
  it("should flag when a required parameter is removed", () => {
    // Arrange: create before/after signatures
    // Act: run the rule
    // Assert: verify the result
  });

  it("should pass when all parameters are preserved", () => {
    // Arrange / Act / Assert
  });
});
```

---

## Commit Conventions

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Format

```
<type>(<scope>): <description>

[optional body]
```

### Types

| Type       | Purpose                                    |
| ---------- | ------------------------------------------ |
| `feat`     | New feature                                |
| `fix`      | Bug fix                                    |
| `docs`     | Documentation changes                      |
| `refactor` | Code refactoring without functional change |
| `test`     | Adding or updating tests                   |
| `chore`    | Build process, dependency updates, tooling |
| `perf`     | Performance improvement                    |

### Examples

```
feat(classifier): add R29 discriminated union narrowing rule
fix(tracer): handle re-exported barrel files beyond depth 10
docs(readme): add GitLab CI recipe
test(rules): add edge cases for R04 type narrowing
chore(deps): upgrade tree-sitter-typescript to 0.22.x
```

---

## Pull Request Process

1. **Ensure CI passes.** All checks must be green before review.
2. **Fill out the PR template** with:
   - What changed and why
   - How it was tested
   - Breaking changes (if any)
3. **Link the related issue** using `Closes #123` or `Fixes #123`.
4. **Request review** from a maintainer.
5. **Address feedback** by pushing additional commits. Do not force-push during review.
6. **Squash on merge.** All PRs are squash-merged into `main`.

### PR Title Format

Follow the same convention as commits:

```
feat(classifier): add R29 discriminated union narrowing rule
```

---

## Issue Reporting

### Bug Reports

When reporting a bug, include the following:

| Field                  | Details                                      |
| ---------------------- | -------------------------------------------- |
| **Environment**        | Node.js version, OS, `diff-guardian` version |
| **Steps to reproduce** | Minimal reproduction case                    |
| **Expected behavior**  | What should happen                           |
| **Actual behavior**    | What actually happens                        |
| **Terminal output**    | Full error output with stack traces          |

### Feature Requests

When requesting a feature, include:

| Field                       | Details                      |
| --------------------------- | ---------------------------- |
| **Use case**                | Why you need this            |
| **Proposed solution**       | How you think it should work |
| **Alternatives considered** | What else you tried          |

---

## Getting Help

- Open a [Discussion](https://github.com/Aryan0628/diff-guardian/discussions) for general questions
- Open an [Issue](https://github.com/Aryan0628/diff-guardian/issues) for bugs and feature requests
- Check the [Documentation](https://diffguardian.space/docs) for guides and references

---

Thank you for contributing to Diff Guardian. Every contribution helps make API contract enforcement better for the entire community.
