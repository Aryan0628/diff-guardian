# Contributing to Diff-Guardian

Thank you for your interest in contributing to Diff-Guardian! This document provides guidelines and instructions for contributing to the project.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
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

## Code of Conduct

This project adheres to a standard Code of Conduct. By participating, you are expected to uphold this code. Please be respectful in all interactions.

---

## Getting Started

1. **Fork** the repository on GitHub
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

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Git**
- **Emscripten SDK** (only needed if rebuilding WASM grammars from source)

### Install Dependencies

```bash
npm install
```

### Build WASM Grammars

The grammars are pre-built in the `grammars/` directory. If you need to rebuild them:

```bash
npm run build:grammars
```

This compiles Tree-Sitter grammars for TypeScript, JavaScript, Python, Go, Java, and Rust into WASM binaries.

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
│   │   ├── constants.ts        # Language → extension mappings
│   │   └── utils.ts            # Shared utilities
│   │
│   ├── parsers/
│   │   ├── git-diff.ts         # Git diff extraction (working tree, staged, ref comparison)
│   │   ├── ast-mapper.ts       # WASM Tree-Sitter AST parsing + signature extraction
│   │   └── translators/       
│   │       ├── typescript.ts   # TypeScript/JavaScript AST → signature translator
│   │       ├── python.ts       # Python AST → signature translator
│   │       ├── go.ts           # Go AST → signature translator
│   │       ├── java.ts         # Java AST → signature translator
│   │       └── rust.ts         # Rust AST → signature translator
│   │
│   ├── classifier/
│   │   ├── engine.ts           # Classification engine — runs all rules against signatures
│   │   ├── types.ts            # Rule and result types
│   │   └── rules/
│   │       ├── index.ts        # Rule barrel file
│   │       ├── R01_param_removed.ts
│   │       ├── R02_param_reordered.ts
│   │       ├── ... (26 rules total)
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

- Check the [Issues](https://github.com/Aryan0628/diff-guardian/issues) page for open issues
- If you want to work on something not listed, create an issue first to discuss it

### 2. Create a Feature Branch

Use the following branch naming convention:

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<name>` | `feat/gitlab-reporter` |
| Bug fix | `fix/<name>` | `fix/enum-tracing-crash` |
| Documentation | `docs/<name>` | `docs/api-examples` |
| Refactor | `refactor/<name>` | `refactor/tracer-perf` |
| Chore | `chore/<name>` | `chore/update-deps` |

### 3. Make Your Changes

- Follow the existing code style and patterns
- Add tests for new functionality
- Update documentation if needed

### 4. Verify Locally

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

See [Pull Request Process](#pull-request-process) below.

---

## Writing Classification Rules

Classification rules are the core of Diff-Guardian's analysis engine. Each rule is a single TypeScript file in `src/classifier/rules/`.

### Rule Template

```typescript
// src/classifier/rules/R99_your_rule.ts

import { FunctionRule, RuleResult } from '../types';

export const yourRule: FunctionRule = {
  id: 'R99',
  name: 'Your Rule Name',
  description: 'What this rule detects and why it matters.',
  languages: 'all',       // or specify: ['typescript', 'python']
  target: 'function',     // 'function' | 'interface' | 'enum'

  check(oldSig, newSig): RuleResult | null {
    // Compare oldSig and newSig
    // Return null if no issue detected
    // Return a RuleResult if the rule fires

    return {
      severity: 'breaking',   // 'breaking' | 'warning'
      changeType: 'signature_change',
      message: 'Describe exactly what changed and why it matters.',
    };
  },
};
```

### Checklist for New Rules

- [ ] Assign the next available rule ID (`R29`, `R30`, etc.)
- [ ] Add the rule file to `src/classifier/rules/`
- [ ] Export it from `src/classifier/rules/index.ts`
- [ ] Write tests covering both positive and negative cases
- [ ] Document the rule in the README rules table
- [ ] Test with a real codebase using `npx dg compare`

---

## Adding Language Support

To add support for a new language:

1. **Install the Tree-Sitter grammar:**
   ```bash
   npm install tree-sitter-<language>
   ```

2. **Build the WASM binary:**  
   Add the build command to the `build:grammars` script in `package.json`.

3. **Create a translator:**  
   Add `src/parsers/translators/<language>.ts` that implements the signature extraction logic.

4. **Register the language** in `src/core/constants.ts` with its file extensions.

5. **Add tracer support** for import resolution patterns in `src/tracer/languages/`.

6. **Write tests** covering the new language's function, interface, and enum signatures.

---

## Testing

We use [Vitest](https://vitest.dev/) as the test runner.

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

### Test Structure

- **Unit tests** — Test individual rules, translators, and utilities
- **Integration tests** — Test the full pipeline with real git diffs
- **Snapshot tests** — Verify reporter output format stability

When writing tests, follow this pattern:

```typescript
import { describe, it, expect } from 'vitest';

describe('R01: Parameter Removed', () => {
  it('should flag when a required parameter is removed', () => {
    // Arrange: create before/after signatures
    // Act: run the rule
    // Assert: verify the result
  });

  it('should pass when all parameters are preserved', () => {
    // ...
  });
});
```

---

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `refactor` | Code refactoring without functional change |
| `test` | Adding or updating tests |
| `chore` | Build process, dependency updates, tooling |
| `perf` | Performance improvement |

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

1. **Ensure CI passes** — all checks must be green before review
2. **Fill out the PR template** with:
   - What changed and why
   - How it was tested
   - Breaking changes (if any)
3. **Link the related issue** using `Closes #123` or `Fixes #123`
4. **Request review** from a maintainer
5. **Address feedback** — push additional commits, don't force-push during review
6. **Squash on merge** — PRs are squash-merged into `main`

### PR Title Format

Follow the same convention as commits:

```
feat(classifier): add R29 discriminated union narrowing rule
```

---

## Issue Reporting

### Bug Reports

When reporting a bug, please include:

1. **Environment** — Node.js version, OS, `diff-guardian` version
2. **Steps to reproduce** — minimal reproduction case
3. **Expected behavior** — what should happen
4. **Actual behavior** — what actually happens
5. **Terminal output** — full error output with stack traces

### Feature Requests

When requesting a feature, please include:

1. **Use case** — why you need this
2. **Proposed solution** — how you think it should work
3. **Alternatives considered** — what else you tried

---

## Need Help?

- 💬 Open a [Discussion](https://github.com/Aryan0628/diff-guardian/discussions) for general questions
- 🐛 Open an [Issue](https://github.com/Aryan0628/diff-guardian/issues) for bugs and feature requests
- 📖 Check the [Documentation](https://diff-guardian.dev/docs) for guides and references

---

Thank you for contributing to Diff-Guardian! Every contribution helps make API contract enforcement better for the entire community. 🛡️
