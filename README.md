Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [age](https://age-encryption.org/).

```sh
sh -c "$(curl -fsLS get.chezmoi.io)" -- -b ~/.local/bin init --apply sachnun
```

`-b ~/.local/bin` pins the install directory to an absolute path; without it
`get.chezmoi.io/lb` installs relative to the current working directory (e.g.
`/workspaces/<repo>` on GitHub Codespaces), which breaks PATH detection.
