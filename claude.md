# Claude — Diff-Guardian Learning Preferences

## Who I Am
- I'm **Aryan**, the author of this project.
- I need to learn this project **from absolute scratch** for an **SDE/Software Engineering interview**.
- Assume I don't know what an AST, WASM, Tree-Sitter, or any technical concept is until I've been taught it in a session.
- This project is on my resume. Interviewers will ask me to explain the architecture, code decisions, design patterns, and trade-offs.

## Learning Mode
- We are learning **phase by phase, topic by topic** as outlined in `learning/learning.md`.
- I will ask you to explain a specific topic (e.g., "explain Phase 1, Topic 2").
- You will create a **detailed markdown file** for that topic inside the `learning/` folder.

## Session File Rules
- Save each session's output as a markdown file in: `learning/`
- Naming convention: `phase{N}-topic{M}-{short-name}.md`
  - Example: `phase0-topic1-what-is-an-ast.md`
  - Example: `phase4-topic3-typescript-translator.md`
- After creating the file, update `learning/learning.md` to mark that topic as ✅ completed.

## Explanation Style
- **Explain from absolute scratch.** If a concept (like AST, WASM, parsing, git internals) is needed, explain it first before diving into code.
- **Use real code from this project.** Don't use generic examples — reference actual files and line numbers from `src/`.
- **Line-by-line code walkthroughs.** For important code blocks, explain what each line does and WHY.
- **Use analogies.** Relate complex concepts to simple real-world things.
- **Include "Interview Tip" sections.** — How to phrase this concept when answering an interview question.
- **Include "Why This Matters" sections.** — Why this design decision was made and what alternatives were considered.
- **Include "If They Ask..." sections.** — Common follow-up questions an interviewer might ask and how to answer them.
- **Include "Key Terms" sections.** — Important vocabulary with definitions. These are the words I should be comfortable using.

## Interview Focus Areas
- System design and architecture decisions
- Why specific technologies were chosen (and what alternatives exist)
- Data flow through the system
- Performance characteristics and how scale is handled
- Design patterns used and why
- Trade-offs made and what I'd improve
- How testing works

## Don't Do
- Don't give me everything in one massive document. We learn topic by topic.
- Don't skip "obvious" concepts. Explain everything as if I'm hearing it for the first time.
- Don't use placeholder examples. Always use real code from this project.
- Don't just describe what code does — explain WHY it was written that way.
