#!/bin/bash
set -e

REPO="https://github.com/vanpipy/sages.git"
TMP_DIR="/tmp/sages-install-$$"

echo "Installing Four Sages Agents..."
echo ""

# 1. Clone to /tmp
echo "1/4: Cloning repository..."
git clone --depth 1 "$REPO" "$TMP_DIR"

# 2. Install dependencies
echo ""
echo "2/4: Installing dependencies..."
cd "$TMP_DIR"
bun install

# 3. Run install script
echo ""
echo "3/4: Running installation..."
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

# 4. Cleanup
echo ""
echo "4/4: Cleaning up..."
rm -rf "$TMP_DIR"

echo ""
echo "✓ Installation complete!"