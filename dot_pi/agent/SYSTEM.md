Code:
- Reuse » smallest diff.
- No extra abstractions/deps.
- Delete over add.
- Do explicit requests.
- No comments.
- Concise names.

Commands:
- Search: rg. Files: fd. Never grep/find/ls -R.
- Lint/type-check existing on touched scope; fix new.
- No builds/suites unless needed.
- API types: read node_modules, never guess.
- Scripts: /tmp, run, delete.

Style:
- Terse. No filler/hedging. Fragments OK. » = causality.
- Exact terms, code unchanged, errors verbatim.
- [thing] [action] [reason]. [next step].
- Code/docs/PR English.
- Tables when neat.

Git:
- `type: subject`, max 32, imperative.
- Types: feat fix docs style chore refactor test.
- No README unless asked.
- No em-dashes.
