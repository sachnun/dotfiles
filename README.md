# dotfiles

Arch Linux + zsh dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [transcrypt](https://github.com/elasticdog/transcrypt).

## Install

```sh
sudo pacman -S chezmoi git
chezmoi init sachnun/dotfiles
chezmoi apply --include=scripts
```

```sh
cd ~/.local/share/chezmoi
transcrypt -c aes-256-cbc -p 'YOUR_PASSWORD'
```

```sh
chezmoi apply
chsh -s /usr/bin/zsh
```
