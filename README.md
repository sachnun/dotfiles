# dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io) for Arch Linux + zsh.

## Install

Install dependencies:

```sh
sudo pacman -S chezmoi age zsh git
```

Copy the age decryption key to the new machine:

```sh
mkdir -p ~/.config/chezmoi
# place your key.txt at ~/.config/chezmoi/key.txt
```

Initialize and apply:

```sh
chezmoi init sachnun/dotfiles --apply
```

Set zsh as default shell:

```sh
chsh -s /usr/bin/zsh
```
