#!/bin/bash
# Proplay Agent Installation Script

set -e

echo "🚀 Installing Proplay Agent..."

TOKEN=""
CONTROL_PLANE=""
GIT_TOKEN=""
ENCRYPTION_KEY=""
AGENT_USER="$USER" # Default to current user

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --token) TOKEN="$2"; shift ;;
        --control-plane) CONTROL_PLANE="$2"; shift ;;
        --git-token) GIT_TOKEN="$2"; shift ;;
        --encryption-key) ENCRYPTION_KEY="$2"; shift ;;
        --user) AGENT_USER="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

if [ -z "$TOKEN" ] || [ -z "$CONTROL_PLANE" ]; then
    echo "❌ Missing required arguments: --token or --control-plane"
    exit 1
fi

# Create user if it doesn't exist
if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
    echo "👤 Creating user '$AGENT_USER'..."
    sudo useradd -m -s /bin/bash "$AGENT_USER"
    sudo usermod -aG sudo "$AGENT_USER"
fi

# Grant passwordless sudo to this user for all tasks as requested
echo "🛡️ Configuring full sudo permissions for '$AGENT_USER'..."
echo "$AGENT_USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/proplay-$AGENT_USER > /dev/null
sudo chmod 0440 /etc/sudoers.d/proplay-$AGENT_USER

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
sudo chown -R $AGENT_USER:$AGENT_USER /opt/proplay-agent
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
chmod +x update.sh

# 3. Create .env file
echo "🔑 Finalizing configuration..."
cat <<EOF > .env
CONTROL_PLANE_URL=$CONTROL_PLANE
AGENT_TOKEN=$TOKEN
ENCRYPTION_KEY=$ENCRYPTION_KEY
EOF

# 4. Create Systemd Service
echo "⚙️ Registering System Service..."

# Dynamically resolve Node.js executable and PATH
NODE_EXEC=$(command -v node)
if [ -z "$NODE_EXEC" ]; then
    NODE_EXEC="/usr/bin/node"
fi

cat <<EOF | sudo tee /etc/systemd/system/proplay-agent.service > /dev/null
[Unit]
Description=Proplay Server Agent
After=network.target

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=/opt/proplay-agent
ExecStart=$NODE_EXEC index.js
Restart=always
Environment="PATH=$PATH"
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 5. Start Service
sudo systemctl daemon-reload
sudo systemctl enable proplay-agent
sudo systemctl restart proplay-agent

echo "✅ Proplay Agent installed and running successfully in the background!"
