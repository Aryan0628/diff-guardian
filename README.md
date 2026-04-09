# diff-guardian
diff-guardian is an impact-aware git diff CLI. Git only sees text changes—it doesn't know adding a parameter just broke 12 call sites. Powered by a WASM tree-sitter AST, diff-guardian maps the true blast radius, applies 28 strict breaking rules, and flags test gaps to give your PRs a 0-100 risk score.
