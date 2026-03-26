#!/bin/bash
# Proplay Agent Update Script
# This script handles syncing with the standalone repository and restarting the service.

set -e

# Detect agent directory
# If installed via install.sh, it's in /opt/proplay-agent
# Otherwise we use the current directory
AGENT_DIR="/opt/proplay-agent"
if [ ! -d "$AGENT_DIR" ]; then
    AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

cd "$AGENT_DIR"

echo "🔄 Updating Proplay Agent in $AGENT_DIR..."

# 1. Pull latest changes
# Note: This assumes the remote 'origin' is set correctly to the standalone repo or proplay repo.
echo "📥 Syncing with repository..."
git pull origin main --rebase || git pull origin master --rebase

# 2. Install dependencies
echo "📦 Installing dependencies..."
# We use npm install --production to skip devDependencies
if [ -f "package-lock.json" ]; then
    npm ci --production --silent
else
    npm install --production --silent
fi

# 3. Restart the service
echo "⚙️  Restarting service..."
if command -v systemctl > /dev/null 2>&1; then
    sudo systemctl restart proplay-agent
else
    echo "⚠️  systemctl not found, skipping service restart."
    echo "💡 Please restart the agent manually."
fi

echo "✅ Proplay Agent updated successfully!"
