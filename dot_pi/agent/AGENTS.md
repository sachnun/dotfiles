Quality:
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Inline single-line helpers that have only one call site.
- Ask before removing intentional code. No backward compat unless asked.
- Check dependency (e.g. `node_modules`) for external API types; don't guess.
- No `any` unless absolutely necessary.
- Upgrade outdated deps instead of downgrading code.
- Follow principles KISS, YAGNI, DRY.

Commands:
- After code changes: run the project's check/lint/type-check and fix all issues before committing.
- Does not run tests.
- Never commit unless asked, do once.
- Never run build/test unless asked.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For ad-hoc scripts, write them to a temp file (e.g. /tmp), run, edit if needed, remove when done. Don't embed multi-line scripts in bash commands.
- IMPORTANT: Don't use `find` and old tools, use `rg` instead.

Git:
- Conventional commits: `type: general`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Subject line only, max 32 chars, imperative mood.
- Keep `README.md` simple, clean, and minimal — no tree.
