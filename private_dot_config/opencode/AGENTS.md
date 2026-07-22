Use conventional commit-style messages and PR titles: `type: general`. 
Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`.

- Commit message is subject line only (no body).
- Commit message limit max 32 characters, make it short.
- One commit per logical change (atomic commits). Don't mix unrelated changes in a single commit.
- Use imperative mood (present tense): "add" not "added", "fix" not "fixed".

- Runtime & Package Manager: Always use Bun.
- Never suggest `npm install`, `npx`, or `node`.
- Use `bun add` instead of `npm install`.
- Use `bunx` instead of `npx`.
- Use `bun run` instead of `npm run`.
