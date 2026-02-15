# dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [transcrypt](https://github.com/elasticdog/transcrypt).

## Install

```sh
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply --include=scripts sachnun
```

```sh
cd ~/.local/share/chezmoi
transcrypt -c aes-256-cbc -p 'YOUR_PASSWORD'
```

```sh
chezmoi apply
chsh -s /usr/bin/zsh
```
