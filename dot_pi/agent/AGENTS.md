Style:

- Be short, direct, technical. No emojis or fluff.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- Always write code, tools and documentation in English.

Quality:

- Ask before removing intentional code. No backward compat unless asked.
- Check dependency (e.g. `node_modules`) for external API types; don't guess.
- No `any` unless absolutely necessary.
- Upgrade outdated deps instead of downgrading code.

Commands:

- After code changes: run the project's check/lint/type-check and fix all issues before committing.
- Never commit unless asked, do once.
- Never run build/test unless asked.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For ad-hoc scripts, write them to a temp file system (e.g. `$TMPDIR` or `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in bash commands.

Git:

- Conventional commits: `type: general`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Subject line only, max 32 chars, imperative mood.
- Never create README.md unless asked.
