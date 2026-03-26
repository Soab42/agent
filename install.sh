#!/bin/bash
# Proplay Agent Installation Script

set -e

echo "🚀 Installing Proplay Agent..."

TOKEN=""
CONTROL_PLANE=""
GIT_TOKEN=""
ENCRYPTION_KEY=""

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --token) TOKEN="$2"; shift ;;
        --control-plane) CONTROL_PLANE="$2"; shift ;;
        --git-token) GIT_TOKEN="$2"; shift ;;
        --encryption-key) ENCRYPTION_KEY="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

if [ -z "$TOKEN" ] || [ -z "$CONTROL_PLANE" ]; then
    echo "❌ Missing required arguments: --token or --control-plane"
    exit 1
fi

echo "📦 Setting up environment..."

# 1. Install Node.js 22.x if not installed
if ! command -v node > /dev/null 2>&1; then
    echo "⚙️ Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# 2. Setup Directory and Download Agent
echo "📂 Downloading Agent..."
sudo mkdir -p /opt/proplay-agent
sudo chown -R $USER:$USER /opt/proplay-agent
cd /opt/proplay-agent

# Clean up any existing content
rm -rf .git * .env .gitignore

# Clone the standalone agent repository
if [ -n "$GIT_TOKEN" ]; then
    git clone --depth=1 "https://$GIT_TOKEN@github.com/Soab42/agent.git" .
else
    git clone --depth=1 https://github.com/Soab42/agent.git .
fi

echo "📦 Installing Dependencies..."
npm install --production --silent

# 3. Create .env file
echo "🔑 Finalizing configuration..."
cat <<EOF > .env
CONTROL_PLANE_URL=$CONTROL_PLANE
AGENT_TOKEN=$TOKEN
ENCRYPTION_KEY=$ENCRYPTION_KEY
EOF

# 4. Create Systemd Service
echo "⚙️ Registering System Service..."
sudo bash -c 'cat <<EOF > /etc/systemd/system/proplay-agent.service
[Unit]
Description=Proplay Server Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/proplay-agent
ExecStart=/usr/bin/node index.js
Restart=always
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF'

# 5. Start Service
sudo systemctl daemon-reload
sudo systemctl enable proplay-agent
sudo systemctl restart proplay-agent

echo "✅ Proplay Agent installed and running successfully in the background!"
