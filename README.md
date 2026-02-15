# dotfiles

Personal dotfiles managed with [chezmoi](https://chezmoi.io). Secrets encrypted with [transcrypt](https://github.com/elasticdog/transcrypt).

## Install

1. Bootstrap chezmoi and run scripts:
   ```sh
   sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply --include=scripts sachnun
   ```

2. Decrypt secrets and apply dotfiles:
   ```sh
   chezmoi cd && transcrypt && chezmoi apply
   ```
