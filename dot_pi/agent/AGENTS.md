Style:

- Always write code, tools and documentation in English.
- Never add comments of any kind in code (no inline, block, or doc comments).

Commands:

- After code changes: run the project's check/lint/type-check and fix all issues.
- Always ask before committing.
- Never run build/test unless asked.
- For ad-hoc scripts, write them to a temp file system (e.g. `$TMPDIR` or `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in bash commands.

Git:

- Conventional commits: `type: general`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Subject line only, max 32 chars, imperative mood.
- Never create README.md unless asked.
