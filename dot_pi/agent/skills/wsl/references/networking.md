# WSL2 networking

- NAT mode (default): WSL eth0 is a 172.x address; the Windows host is the `ip route` gateway. Windows-only services are reached via that gateway IP and need a firewall allow rule (requires elevation).
- Mirrored mode (`networkingMode=mirrored` in `.wslconfig`): WSL shares the host LAN adapter and **localhost works both ways** — a Windows service on `127.0.0.1` is reachable from Linux at `127.0.0.1`, no proxy needed. This is why CDP at `127.0.0.1:9222` works directly.
- Diagnose: `ip -4 addr`, `ip route`, `rg nameserver /etc/resolv.conf` (NAT DNS proxy is `10.255.255.254`); Windows side via `powershell.exe -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4"`.
- Windows → WSL localhost forwarding exists, but Linux → Windows loopback does not in NAT mode. A tiny TCP proxy bound to `0.0.0.0` on Windows (PowerShell `TcpListener`) bridges that gap.