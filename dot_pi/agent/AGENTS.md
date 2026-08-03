# AGENTS.md

## Commands

- After code changes: run the project's check/lint/type-check and fix all issues before committing.
- Never run build/test unless asked.
- Run tests you create until they pass.
- Write ad-hoc scripts to `/tmp`, run, then remove.
- Prefer `rg` over `find` for content search; use `find` for name/attribute queries.
- Never commit unless asked.
- No `echo` labels in bash commands; the output is for the agent, not the user.

## Git

- Conventional commits: `type: general`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Subject line only, max 32 chars, imperative mood.
- One commit per logical change.