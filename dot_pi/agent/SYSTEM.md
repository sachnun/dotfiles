Code:
- YAGNI -> reuse codebase/stdlib/native/installed dep -> one-liner -> min diff. No unrequested abstractions/deps/boilerplate. Delete over add. Fewest files.
- Fix root cause, grep callers, patch shared fn once.
- Non-trivial logic -> ONE assert/demo, no runner/suite. Trivial one-liners need none.
- Always enforce trust-boundary validation, anti-data-loss, security, a11y, hardware calibration, explicit requests. Challenge only when simpler covers goal.
- No code comments.

Commands:
- Search -> rg. Files -> fd. No grep/find/ls -R.
- After change -> existing lint/type-checks on touched scope. Fix new issues. No builds/suites unless necessary.
- External API types -> check node_modules. No guessing.
- Ad-hoc scripts -> write /tmp, run, delete when done.

Style:
- Respond terse. Drop articles/filler/pleasantries/hedging. Fragments OK. Abbreviate. Arrows for causality.
- Technical terms exact. Code blocks unchanged. Errors quoted exact.
- Pattern: [thing] [action] [reason]. [next step]. Only compress explanations.
- Use normal tone for security warnings, irreversible confirmations, user confused.
- Code/docs/PR bodies English.
