---
name: colab
description: Operates Google Colab via the `colab` CLI — use for any compute job on Colab VMs (CPU/GPU/TPU) from this session.
---

# Colab Session Operator

Operate Google Colab from the command line through the `colab` CLI. This lets you rent a VM (optionally with GPU/TPU), run Python or shell on it, and release it — all without opening a browser.

## When to use
- Provisioning or managing Colab CPU/GPU/TPU sessions from a terminal or agent.
- Running a Python script or shell commands on a remote Colab VM.
- One-off compute jobs: rent a fresh VM, run something heavy, tear it down.
- Syncing files between local machine and the VM.
- Automating setup: packages, Drive mount, in-VM credentials.
- Capturing session history as a Jupyter notebook.

## Mental model
- **A session is a live Jupyter kernel on a rented VM.** `colab new` allocates a billable VM; `colab stop` releases it. Unstopped sessions keep burning compute units.
- **Kernel state persists across `colab exec` calls.** Each invocation reattaches to the same kernel; imports, variables, and functions survive between separate commands. Build up state incrementally. `colab stop` and `colab restart-kernel` reset it.
- **Working directory default is `/content`** for `exec`/`repl`/`run`; prefer absolute `/content/...` paths for file work.
- **Each command is fire-and-forget**: authenticate, do one thing, exit. A background daemon spawned by `colab new` handles keep-alive.

## Authentication
- Global flag `--auth={adc,oauth2}` goes **before** the subcommand: `colab --auth=adc new -s x`.
- **Prefer `adc` (Application Default Credentials) for headless/agent use**; the `oauth2` flow opens a browser consent screen on first use.
- The Colab backends need four scopes in ADC. Re-mint if a call 401s/403s:
  ```bash
  gcloud auth application-default login \
    --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory
  ```
  Missing `userinfo.email` → 401 from `colab.research.google.com`; missing `colaboratory` → 403 from `colab.pa.googleapis.com` (keep-alive).
- Verify auth with `colab sessions` (read-only) or `colab whoami` (hidden debug command: prints email, scopes, expiry).
- **Don't confuse `colab auth` with CLI auth.** `colab auth` injects *VM-side* GCP credentials into the kernel so notebook code can call GCS/BigQuery. It does not fix CLI 401/403 — those are scope problems fixed with the `gcloud` command above.

## Provision
- `colab new -s <name>` for a CPU VM. Always pass `-s <name>`; an omitted name is a random hex string that's hard to target later.
- Accelerators: `colab new -s <name> --gpu <T4|L4|G4|H100|A100>` or `--tpu <v5e1|v6e1>`.
- Gotchas:
  - An unrecognized `--gpu` value silently falls back to **A100**.
  - A `400` from `colab new` with an accelerator means no quota/entitlement — fall back to `--gpu T4` or CPU.
  - Accelerator availability is account-tiered; don't assume a GPU/TPU will allocate.

## Execute
- Run a local file: `colab exec -s <name> -f script.py` (read locally, executed remotely).
- Pipe code or a file via stdin: `echo "print(1)" | colab exec -s <name>` or `cat script.py | colab exec -s <name>`. `colab exec` takes no positional code argument — only `-f` or stdin.
- Notebooks: `colab exec -s <name> -f nb.ipynb` runs each cell and writes `<basename>_output.ipynb`. A `# @title Foo` first line labels the cell in progress output.
- Plots/images: PNG/JPEG outputs are intercepted. Use `--output-image <path>` to save to a known location. Inline image escapes are suppressed when stdout isn't a TTY.
- Shell: `echo "cmd" | colab console -s <name>`. Console wraps bash in tmux, so piped output contains terminal-control bytes — filter with `grep -a`.
- Never run `colab repl`, `colab console`, `colab auth`, or `colab drivemount` interactively from an agent — they expect a TTY and hang. `repl`/`console` accept piped stdin and exit on EOF; `auth`/`drivemount` need a human.

## Ephemeral one-shot jobs
- `colab run [--gpu T4] [--tpu v6e1] [--keep] [-s NAME] script.py [args...]` = `new` + `exec` + `stop` in one command. Provisions a fresh VM, runs the script with `sys.argv` and `__name__ == "__main__"` set like native `python script.py args`, then tears the VM down (unless `--keep`).
- Exit codes propagate: an uncaught exception or `sys.exit(N)` makes `colab run` exit non-zero.
- Stream separation: `colab run` writes `[colab] ...` chatter to **stderr** and script output to **stdout**, so `colab run job.py > out.txt` captures only the script's output.
- Works as a shebang: `#!/usr/bin/env -S colab run --gpu T4` turns an executable `.py` into a self-contained rent-a-GPU-and-run script.
- A nonexistent script path exits non-zero before allocating a VM — no wasted compute.

## Automation on the VM
- `colab auth -s <name>`: VM-side GCP credentials (interactive; not agent-runnable).
- `colab drivemount -s <name> [PATH]`: mounts Google Drive at `/content/drive` by default (interactive; not agent-runnable).
- `colab install -s <name> pkg1 pkg2`: installs via `uv pip install --system`, falling back to `pip`. Also `colab install -s <name> -r requirements.txt`.

## Inspect & report
- `colab sessions`: lists server-side assignments, auto-prunes stale local entries.
- `colab status [-s <name>]`: hardware, IDLE/BUSY, last execution.
- `colab log -s <name> [-n 20] [-t TYPE]`: recent structured events; invaluable on failure (keep-alive errors carry the raw `response_body`).
- Export history: `colab log -s <name> -o summary.ipynb` (also `.md`, `.txt`, `.jsonl` by suffix).
- `colab url -s <name>`: browser URL that attaches the Colab web UI to the existing CLI session (`--open` to launch).
- `colab skill` / `colab readme`: print the CLI's bundled skill and README for self-discovery; `colab help [cmd]` documents commands.

## Safety
- **Always `colab stop -s <name>` when done** — idle VMs burn compute units. `colab run` without `--keep` self-cleans even on script errors.
- Local state lives in `~/.config/colab-cli/` (`sessions.json`, `settings.json`, `history/*.jsonl`). Don't edit by hand.
- Isolate parallel/agent runs with the global `--config <path>` flag pointing session state at a scratch file; the keep-alive daemon inherits `--auth` and `--config` automatically.

## Troubleshooting
- **CLI crashes with `AttributeError: ... 'jupyter_kernel_client' ... no attribute 'KernelClient'`**: the installed `jupyter_kernel_client` is too new for the CLI. colab-cli expects the <=0.15.x API (which exports `KernelClient`); 1.x renamed it. Pin `jupyter_kernel_client==0.15.0` in the CLI's Python environment, then retry.
- **"Session not found" / 404 / 401 on exec**: the backend pruned the VM. `colab exec` cleans up local state automatically — run `colab sessions` and re-create with `colab new`.
- **Execution timeout or wedged kernel**: `colab restart-kernel -s <name>` (keeps VM, resets kernel) or `colab stop` + `colab new`.
- **Keep-alive daemon died** (`colab log` shows `keep_alive_stopped reason=consecutive_4xx_errors`): almost always the missing `colaboratory` scope — re-auth per Authentication.