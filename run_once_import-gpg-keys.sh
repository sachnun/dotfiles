#!/bin/bash
set -euo pipefail

KEY_ID="95A9ECFC7CB65E2D"

# Skip if key already imported
if gpg --list-secret-keys "$KEY_ID" &>/dev/null; then
    echo "GPG key $KEY_ID already imported, skipping."
    exit 0
fi

echo "Importing GPG keys..."

PUBLIC_KEY="$HOME/.gnupg/gpg-public.asc"
PRIVATE_KEY="$HOME/.gnupg/gpg-private.asc"

if [ -f "$PUBLIC_KEY" ]; then
    gpg --batch --import "$PUBLIC_KEY"
    echo "Public key imported."
fi

if [ -f "$PRIVATE_KEY" ]; then
    gpg --batch --import "$PRIVATE_KEY"
    echo "Private key imported."
fi

# Trust the key ultimately
echo "${KEY_ID}:6:" | gpg --import-ownertrust
echo "GPG key $KEY_ID trusted."
