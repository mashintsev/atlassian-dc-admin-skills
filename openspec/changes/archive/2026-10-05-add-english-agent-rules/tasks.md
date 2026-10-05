# Tasks

## 1. Agent Instructions

- [x] 1.1 Add root `AGENTS.md` with English-only rules for all code comments (inline comments, block comments, JSDoc, and TODO notes) and all agent rules and instructions (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`, and OpenSpec workflow guidance); verify the file is written in English and matches the proposal's two rules.
- [x] 1.2 Add root `CLAUDE.md` containing `@AGENTS.md`; verify the import references the existing root instructions and `git diff --check --no-index /dev/null AGENTS.md` and `git diff --check --no-index /dev/null CLAUDE.md` report no whitespace errors (the new files are initially untracked).
