# Agent Instructions

## Language

- Write all code comments, including inline comments, block comments, JSDoc, and TODO notes, in English.
- Write all agent rules and instructions in English, including AGENTS.md, CLAUDE.md, SKILL.md, and OpenSpec workflow guidance.

## Superpowers

- Use [obra/superpowers](https://github.com/obra/superpowers) when its plugin is available. At the start of a task, check its `using-superpowers` guidance and apply the relevant skills; do not assume a skill is active just because the plugin is installed.
- For non-trivial changes, use `brainstorming` to clarify requirements and agree on a design before editing, then `writing-plans` to create an actionable implementation plan. Skip these steps for small, unambiguous changes where they would add no value.
- For code changes, follow `test-driven-development`: write a failing test, verify the failure, make the smallest change, and verify it passes. Use `systematic-debugging` for defects and `verification-before-completion` before reporting results.
- Use `requesting-code-review` for completed non-trivial changes, and address valid feedback before finishing. Delegate independent work only when it is safe and useful; retain responsibility for integrating and verifying it.
- Follow this repository's instructions, the user's requested scope, and applicable safety and confirmation requirements. Superpowers workflows do not authorize broader changes, bypass confirmation, or replace established repository workflows such as OpenSpec.
