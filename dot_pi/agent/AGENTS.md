Quality:
- Ask before removing intentional code. No backward compat unless asked.
- Always check dependency files before guessing APIs.
- Prefer strong typing over `any`.
- Upgrade outdated deps instead of downgrading code.
- Follow principles KISS, YAGNI, DRY.

Commands:
- After code changes: run the project's check/lint/type-check and fix all issues before committing.
- Never commit unless asked. do once.
- Never run build/test unless asked.
- Run tests you create until they pass.
- Write ad-hoc scripts to system temp dir.
- IMPORTANT: Don't use `find` and old tools, use `rg` instead.

Git:
- Conventional commits: `type: general`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Subject line only, max 32 chars, imperative mood.
- One commit per logical change.
- Keep `README.md` simple, clean, and minimal — no tree.
