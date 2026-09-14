#!/usr/bin/env python3
"""Push the kg-bridge Kaggle kernel: sshd + cloudflared quick tunnel. -g = GPU."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

BRIDGE = r'''import re, subprocess, threading, time

PASS = "kgbridge"
CF = "/usr/local/bin/cloudflared"


def sh(c, t=None):
    return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t)


sh("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; "
   "apt-get install -y -qq openssh-server curl", t=1800)
sh("mkdir -p /run/sshd")
sh("echo 'root:%s' | chpasswd" % PASS)
open("/etc/ssh/sshd_config.d/99-bridge.conf", "w").write(
    "PermitRootLogin yes\nPasswordAuthentication yes\nUsePAM no\n")
sh("ssh-keygen -A")
sh("pkill -x sshd; /usr/sbin/sshd")
sh("curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/"
   "cloudflared-linux-amd64 -o %s && chmod +x %s" % (CF, CF), t=600)
print("BRIDGE_READY", flush=True)


def alive():
    while True:
        time.sleep(60)
        print("ALIVE", time.strftime("%H:%M:%S"), flush=True)


threading.Thread(target=alive, daemon=True).start()

while True:
    p = subprocess.Popen([CF, "tunnel", "--url", "tcp://localhost:22", "--no-autoupdate"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in p.stdout:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            print("TUNNEL_READY", m.group(0), flush=True)
    time.sleep(3)
'''


def main():
    cfg = subprocess.run(["kaggle", "config", "view"], capture_output=True, text=True).stdout
    user = next((l.split(": ", 1)[1].strip() for l in cfg.splitlines()
                 if l.startswith("- username:")), "")
    if not user:
        sys.exit("no kaggle username in config")
    meta = {
        "id": user + "/kg-bridge",
        "title": "kg-bridge",
        "code_file": "bridge.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": "-g" in sys.argv,
        "enable_internet": True,
        "dataset_sources": [],
        "competition_sources": [],
        "kernel_sources": [],
    }
    with tempfile.TemporaryDirectory() as d:
        Path(d, "bridge.py").write_text(BRIDGE)
        Path(d, "kernel-metadata.json").write_text(json.dumps(meta, indent=2) + "\n")
        subprocess.run(["kaggle", "kernels", "push", "-p", d], check=True)
    print("id: " + meta["id"])


main()
