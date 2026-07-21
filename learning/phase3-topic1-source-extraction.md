# Phase 3, Topic 1: Source Extraction (`git-diff.ts`)

Welcome to **Phase 3**! We are now looking at the **Core Engine** of Diff-Guardian. In Phase 2, we learned that the pipeline starts with taking a codebase and extracting the files that actually changed. This topic covers exactly how that is done.

The code we will be discussing lives in [`src/parsers/git-diff.ts`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts).

## What is Source Extraction?

Before we can parse Abstract Syntax Trees (ASTs) or figure out if an API broke, we need the raw code. But we don't just need the *current* code — we need the *before* and *after* versions of every file that changed.

**Analogy:** Imagine you are a detective investigating a robbery at an art gallery. To figure out what happened, you don't just look at the gallery *right now*. You look at the security camera photo from yesterday (the **base** state) and compare it to the photo from today (the **head** state). 

Source Extraction is the process of getting those two photos (the text of the code) directly from Git.

### Key Terms
- **Base SHA**: The commit hash (or branch name) representing the "before" state of the code.
- **Head SHA**: The commit hash representing the "after" state.
- **Working Tree**: The current state of your files on disk, including changes you haven't committed or staged yet.
- **Index (Staged)**: The staging area in Git where changes go when you run `git add`, before you run `git commit`.

---

## 1. The Entry Point: `extractGitSources()`

Let's look at the main function in `git-diff.ts` that kicks this all off. Its job is to return an array of `FileDiff` objects. A `FileDiff` contains everything about a changed file: its path, whether it was added/deleted, and the actual string text of its "before" and "after" code.

Take a look at the core of [`extractGitSources()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts#L65-L119):

```typescript
  // ── Build the git diff command based on mode ────────────────────────────
  let diffCmd: string;

  if (headSha === WORKING_TREE) {
    // Compare baseSha against working tree (uncommitted files)
    diffCmd = `git diff --name-status ${baseSha}`;
  } else if (headSha === STAGED) {
    // Compare baseSha against staged index (git add'd files)
    diffCmd = `git diff --name-status --cached ${baseSha}`;
  } else {
    // Standard: compare two committed refs
    diffCmd = `git diff --name-status ${baseSha} ${headSha}`;
  }
```

### The Three Modes of Extraction
Diff-Guardian doesn't just run on Pull Requests (comparing two commits). It can also run *locally* on your machine before you even commit! To do this, it supports three modes:

1. **Standard**: You pass two commits (`baseSha` and `headSha`). It compares them.
2. **Working Tree**: You want to check your unsaved/uncommitted work. `headSha` is the special string `'WORKING_TREE'`.
3. **Staged**: You want to check only the files you've `git add`ed (useful for `pre-commit` hooks). `headSha` is `'STAGED'`.

### Why This Matters
If you only supported commit-to-commit comparisons, developers couldn't use Diff-Guardian to check their code *while* writing it. By supporting the working tree and staging area, Diff-Guardian becomes a tool developers can use locally to catch breaking changes before they even push to GitHub.

---

## 2. Parsing `git diff --name-status`

Once the command is built, we execute it. We use `git diff --name-status` because it doesn't give us the full text of the diff (which is slow to parse and often incomplete). Instead, it just gives us a list of files that changed and a status code indicating *how* they changed.

```typescript
  const { stdout: nameStatus } = await execAsync(
    diffCmd,
    { maxBuffer: MAX_BUFFER, cwd: repoRoot },
  );

  const lines = nameStatus.trim().split('\n').filter(Boolean);
```

### 10MB Buffer Limit
Notice `maxBuffer: MAX_BUFFER` (which is set to 10MB). When you run shell commands in Node.js via `exec`, it buffers the output in memory. If a PR touches thousands of files, the stdout from git could exceed Node's default 1MB limit and crash the program. Increasing it to 10MB ensures scalability for massive monorepos.

### Status Codes (M/A/D/R)
Let's look inside [`processLine()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts#L125-L173), which handles each file from the git output.

```typescript
  // Git uses TAB as the delimiter — never split on \s+ (breaks paths with spaces)
  const parts  = line.split('\t');
  const status = parts[0][0]; // First char: M, A, D, R, C, T, U, X
```

Git status codes tell us what happened to the file:
- **M**: Modified (file changed)
- **A**: Added (new file)
- **D**: Deleted (file removed)
- **R**: Renamed (file moved to a new path)

#### Handling Renames
```typescript
  let oldPath = parts[1];
  let newPath = parts[1];

  // R (rename) and C (copy) have two paths: [status, oldPath, newPath]
  const isRenamed = status === 'R' || status === 'C';
  if (isRenamed && parts.length === 3) {
    oldPath = parts[1];
    newPath = parts[2];
  }
```

If a file was renamed, Git gives us *both* the old and new path (e.g., `R100 \t old.ts \t new.ts`). We extract both so our system knows it's the same file under a different name.

---

## 3. Extracting the Text (`git show`)

Now we know *which* files changed. But we need their actual text to parse them.

```typescript
  // Fetch full source text — mode-aware
  const [oldSource, newSource] = await Promise.all([
    isNew     ? Promise.resolve('') : runGitShow(baseSha, oldPath, repoRoot),
    isDeleted ? Promise.resolve('') : getNewSource(headSha, newPath, repoRoot),
  ]);
```

If a file is new, there's no `oldSource`. If it's deleted, there's no `newSource`. Otherwise, we go fetch it.

Inside [`getNewSource()`](file:///Users/aryangupta/Documents/Projects/diff-guardian/src/parsers/git-diff.ts#L182-L206):

```typescript
  if (headSha === WORKING_TREE) {
    // Read directly from disk
    const absolutePath = path.resolve(repoRoot, filePath);
    return fs.readFileSync(absolutePath, 'utf-8');
  }

  if (headSha === STAGED) {
    // Read from the git index (staged snapshot)
    // `:path` is git's syntax for "the version in the index"
    return runGitShow('', `:${filePath}`, repoRoot);
  }

  // Standard: read from a committed ref
  return runGitShow(headSha, filePath, repoRoot);
```

- **Working Tree**: Just use Node's `fs.readFileSync()` to read what's on the hard drive right now.
- **Staged**: Use the git syntax `:{filepath}`. Git keeps a hidden copy of files when you run `git add`. This syntax tells Git, "give me the version of this file that is currently sitting in the staging area."
- **Standard**: Run `git show {sha}:{filepath}`. This reaches back into Git's history and pulls the exact text of the file from that specific commit, completely ignoring what's on the hard drive.

---

## 4. Concurrency with `Promise.allSettled()`

Back in `extractGitSources()`, we fire off all these `git show` commands for all the changed files:

```typescript
  const settled = await Promise.allSettled(
    lines.map(line => processLine(line, baseSha, headSha, repoRoot)),
  );
```

### Why `Promise.allSettled()` instead of `Promise.all()`?
If a PR changes 50 files, we want to fetch them in parallel to be fast. 

If we used `Promise.all()`, and *one* of those `git show` commands failed (maybe a weird permissions issue or a corrupted file), the **entire** Promise would reject, and Diff-Guardian would crash completely.

By using `Promise.allSettled()`, we let all 50 files try to process. If 49 succeed and 1 fails, we get a list showing 49 `fulfilled` and 1 `rejected`. We can then log the failure for the 1 file but continue analyzing the other 49! This is called **Error Isolation** or **Fault Tolerance**.

```typescript
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      if (outcome.value !== null) diffs.push(outcome.value);
    } else {
      // Real failure — log but don't crash the entire run
      console.warn('[git-diff] skipped file due to error:', outcome.reason?.message ?? outcome.reason);
    }
  }
```

---

## Interview Tip
When an interviewer asks you about how you handled interacting with the filesystem or external tools (like Git), focus on **Fault Tolerance and Scalability**. 

> *"In the Source Extraction layer, I had to ensure the tool didn't crash on massive PRs. I increased the child process maxBuffer limit to 10MB to handle large diff metadata, and I used `Promise.allSettled` when executing `git show` concurrently. This provided fault tolerance — if Git failed to extract one corrupted file, I could catch that isolated rejection and continue analyzing the rest of the PR without failing the entire CI job."*

---

## If They Ask...

**Q: Why do you use `git diff --name-status` instead of just parsing the raw `git diff` patch output?**
**A:** "Parsing a unified diff patch output is extremely complex and error-prone, especially for tracking file renames and binary files. By using `--name-status`, I get a clean, tabular list of exactly what files changed and how (Added, Modified, Deleted, Renamed). Then, I fetch the full, pristine source code of the file before and after using `git show`. Having the *full* file content is required anyway because Tree-Sitter (the AST parser) needs the entire file to build a valid syntax tree; it can't parse a fragmented diff patch."

**Q: Does spawning a separate `git show` child process for every single file cause performance bottlenecks?**
**A:** "It can if a PR touches thousands of files. Node handles concurrent I/O well, but spawning thousands of child processes simultaneously could hit OS file descriptor limits. In Diff-Guardian, we mitigate this by only running `git show` on files that pass our `isTargetFile()` filter (e.g., ignoring `.txt`, `.md`, or `node_modules`). If scaling to massive monorepo PRs became an issue, the next optimization would be using a concurrency limiter (like `p-limit`) to batch the child processes, or using Node's native C++ bindings for Git (`nodegit`) to bypass shell execution entirely."
