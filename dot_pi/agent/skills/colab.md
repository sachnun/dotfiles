---
name: colab
description: Run compute jobs on Google Colab VMs (CPU/GPU/TPU) via the `colab` CLI.
---

# Colab

Rent a Colab VM, run code, release it, via the `colab` CLI.

A session is a live Jupyter kernel on a billable VM: `colab new` allocates, `colab stop` releases, idle VMs burn units. Kernel state persists across `colab exec`; `stop`/`restart-kernel` resets it. Default workdir `/content`.

## Run

```bash
colab new -s x [--gpu T4|L4|G4|H100|A100] [--tpu v5e1|v6e1]
colab exec -s x -f script.py     # or: cat script.py | colab exec -s x
colab run --gpu T4 script.py arg # new + exec + stop; --keep to persist
colab console -s x               # shell, piped
colab stop -s x
```

- `new` bad `--gpu` silently falls back to A100; `400` means no quota, fall back to T4 or CPU.
- `exec` takes only `-f` or stdin. `.ipynb` in → `<basename>_output.ipynb` out. `--output-image <path>` saves plots.
- `run` streams chatter to stderr, script output to stdout; exit codes propagate.
- Never run `repl`, `console`, `auth`, `drivemount` interactively (need a TTY, hang).

## Inspect

```bash
colab sessions | colab status -s x | colab log -s x -n 20 | colab url -s x
colab install -s x pkg1 pkg2 | colab log -s x -o summary.ipynb
```

## Pitfalls

- `jupyter_kernel_client` 1.x breaks the CLI (`no attribute 'KernelClient'`): pin `==0.15.0`.
- `404`/`401` on exec: VM pruned, re-`new`.
- Wedged kernel: `colab restart-kernel -s x` or `stop` + `new`.
- State in `~/.config/colab-cli/`; isolate runs with `--config <path>`.
