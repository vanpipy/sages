#!/bin/bash
set -e

REPO="https://github.com/vanpipy/sages.git"
TMP_DIR="/tmp/sages-install-$$"

echo "Installing Four Sages Agents..."
echo ""

# 1. Clone to /tmp
echo "1/3: Cloning repository..."
git clone --depth 1 "$REPO" "$TMP_DIR"

# 2. Run install script
echo ""
echo "2/3: Running installation..."
cd "$TMP_DIR"

# Prefer bun, fallback to npx
if command -v bun &> /dev/null; then
    echo "   Using: bun"
    bun run scripts/install.ts
elif command -v npx &> /dev/null; then
    echo "   Using: npx"
    npx tsx scripts/install.ts
else
    echo "   Error: Neither bun nor npx found."
    echo "   Please install bun (https://bun.sh) or node+npx"
    rm -rf "$TMP_DIR"
    exit 1
fi

# 3. Cleanup
echo ""
echo "3/3: Cleaning up..."
rm -rf "$TMP_DIR"

echo ""
echo "✓ Installation complete!"