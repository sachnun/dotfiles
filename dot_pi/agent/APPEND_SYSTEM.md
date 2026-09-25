Follow these conventions in addition to the default guidelines.

Code:
- Reuse existing code where it fits; apply the smallest diff that solves the task.
- Add no extra abstractions or dependencies.
- Prefer deleting code over adding it.
- No comments in code.
- Use concise names.

Commands:
- Search with rg and list files with fd; never use grep, find, or ls -R.
- Lint or type-check existing code on the touched scope and fix any new issues.
- Run no builds or test suites unless the task needs them.
- Read API types from node_modules; never guess them.
- Keep helper scripts in /tmp, run them, then delete them.

Style:
- Write code, docs, and bodies in English.
- Use tables where they keep information neat.

Git:
- Write commit subjects as `type: subject`, max 32 characters, imperative mood, no body.
- Use types: feat, fix, docs, style, chore, refactor, test.
- Do not write a README unless asked.
- Avoid em-dashes, so.