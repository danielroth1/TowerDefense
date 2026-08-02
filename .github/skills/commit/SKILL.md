---
name: commit
user-invocable: true
description: "Generate structured git commit messages from staged or unstaged changes. Use when: the user asks to 'commit', 'create a commit', 'write a commit message', 'generate a commit', 'stage and commit', 'make a commit', 'commit changes', or says they want to commit their work. Also use when the user provides a diff and asks for a commit message. NOT for: reviewing code before committing (use the default agent), analyzing history."
---

# Commit Skill

Generate concise, well-structured commit messages by analyzing the current git
diff. Follow the project's established commit style.

## Project Commit Convention

Based on the existing history in this repo:

- **Imperative present tense** — "add feature", not "added feature" or "adds feature"
- **Lowercase subject** — no capital first letter
- **No trailing period** in the subject line
- **Conventional commit prefixes** used where appropriate:
  - `perf:` — performance improvements
  - `fix:` — bug fixes
  - No prefix for general features or additions
- **Subject line max ~72 characters**, body wraps at ~72 characters
- **Body paragraphs** separated by blank lines when more context is needed
- **Scope**: mention what area changed (e.g., "economy", "path generation", "rendering")

## Workflow

### 1. Gather Context

Run these commands to understand what's changed:

```
git status                    # which files are staged/unstaged
git diff --cached --stat      # staged diff summary
git diff --stat               # unstaged diff summary
git diff --cached             # full staged diff
```

If there are no staged changes but unstaged changes exist, ask whether to:
- Stage all (`git add -A`) and commit
- Stage specific files and commit
- Only commit what's already staged

### 2. Analyze the Diff

Read through the diff output and identify:

- **Primary purpose** — what does this change accomplish?
- **Scope** — which module/system is affected? (e.g., `economy`, `path`, `ui`, `perf`)
- **Files changed** — how many, what types (`.ts`, `.json`, `.html`, etc.)
- **Breaking changes** — any renamed symbols, removed APIs, changed signatures

### 3. Generate the Commit Message

#### Subject Line

Format: `[prefix: ]<imperative description of change>`

Examples from this project:
```
add upgraded building textures
fix path generation when placing economy tile
perf: pool HP bars, spatial-grid flyer targeting, cache enemy arrays
sell the correct resources in markets
```

#### Body (optional)

Include a body when:
- Multiple concerns are touched (list bullet points)
- A non-obvious design decision needs explanation
- Breaking changes need migration notes
- The change spans multiple systems

Format:
```
<subject line>

<bullet points or paragraphs explaining what changed and why>
```

#### Single-file, obvious changes

For trivial changes (typo fix, one-liner rename, simple config change), just
use the subject line — no body needed.

### 4. Present and Confirm

Show the proposed commit message to the user. Ask for confirmation or edits
before executing the commit. Let them know the command to run:

```bash
git commit -m "subject" -m "body paragraph 1" -m "body paragraph 2"
```

Or for simple one-liners, just the single `-m`.

### 5. Handle Special Cases

**WIP / partial commits**: If there are many unrelated changes, suggest
committing in logical groups using `git add -p` or separate commits.

**Co-authored commits**: If the work was collaborative, append:

```
Co-authored-by: Name <email>
```

**Fixes / references**: If the diff addresses an existing issue, include:

```
Fixes #123
```
