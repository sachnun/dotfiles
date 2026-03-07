Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [age](https://age-encryption.org/).

Supported environments:

- Arch Linux
- Ubuntu and Debian
- GitHub Codespaces (safe container mode; skips machine-level changes like `chsh`, locale generation, and Docker service setup)

```sh
sh -c "$(curl -fsLS get.chezmoi.io/lb)" -- init --apply sachnun
```
