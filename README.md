# dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [transcrypt](https://github.com/elasticdog/transcrypt).

## Install

1. Bootstrap chezmoi and run scripts:
   ```sh
   sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply --include=scripts sachnun
   ```

2. Decrypt secrets:
   ```sh
   chezmoi cd
   transcrypt -c aes-256-cbc -p 'YOUR_PASSWORD'
   ```

3. Apply dotfiles and change default shell:
   ```sh
   chezmoi apply
   chsh -s $(which zsh)
   ```
