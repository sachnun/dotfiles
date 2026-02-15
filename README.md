# dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [transcrypt](https://github.com/elasticdog/transcrypt).

## Install

```sh
sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply --include=scripts sachnun
chezmoi cd
transcrypt -c aes-256-cbc -p 'YOUR_PASSWORD'
chezmoi apply
```
