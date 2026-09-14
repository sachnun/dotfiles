---
name: kaggle
description: Interactive root SSH shell on a Kaggle VM via the `kaggle` CLI, relayed by a cloudflared quick tunnel, hosted in tmux.
---

# Kaggle

Kernel `<user>/kg-bridge` runs `sshd` + a cloudflared quick tunnel; SSH in from tmux, keyless.
Push = new version = cancels the running one. Life ~9h CPU / ~12h GPU; must stay `RUNNING`.

## 1. Push

```bash
<skill-dir>/kaggle.py        # CPU (saves quota)
<skill-dir>/kaggle.py -g     # GPU
```

## 2. Tunnel URL

```bash
kaggle kernels logs -f <user>/kg-bridge   # wait for: TUNNEL_READY https://xxx.trycloudflare.com
```

Re-read per reconnect: the URL changes on every cloudflared restart.

## 3. Connect

```bash
H=<xxx>.trycloudflare.com
tmux kill-session -t kaggle 2>/dev/null
tmux new -d -s kaggle
tmux send-keys -t kaggle "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PubkeyAuthentication=no -o PreferredAuthentications=password \
  -o ProxyCommand='cloudflared access ssh --hostname %h' root@$H" Enter
sleep 8                                          # wait for "password:"
tmux send-keys -t kaggle 'kgbridge' Enter        # root password
tmux capture-pane -p -t kaggle -S -40
```

Drive remote: `tmux send-keys -t kaggle '<cmd>' Enter` / `tmux capture-pane -p -t kaggle -S -40`.

## Inspect / stop

```bash
kaggle kernels status <id> | kaggle kernels logs -f <id> | kaggle quota
kaggle kernels output <id> -p <dir>              # files, once the run ends
```

No cancel command: push a script that exits, or `kaggle kernels delete`.

## Pitfalls

- One `RUNNING` kernel per account; another (even stuck on an orphan process) makes the next push `CANCEL_ACKNOWLEDGED` in ~1 min.
- Quick tunnels are HTTP at the edge; raw TCP only via `cloudflared access ssh|tcp`.
- `cloudflared access tcp --hostname <h> --url 127.0.0.1:2222` = local listener instead of ProxyCommand.
- `nvidia-smi` is `/opt/bin/nvidia-smi`, not on PATH over SSH.
- P100 is sm_60, mismatches torch cu12x (`sm_70+`); use another accelerator or CPU.
- `kernels logs` needs `-f` while the kernel runs.

## Setup

`cloudflared` + `tmux` + `kaggle` locally:
`curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared`
