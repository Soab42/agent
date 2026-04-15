# Proplay Agent

The Proplay Agent is a standalone service designed to run on a Linux VPS. It communicates with the Proplay Control Plane via WebSockets to execute deployment tasks, manage services, and monitor system health.

## Installation

The recommended installation method is via the `install.sh` script:

```bash
curl -fsSL https://raw.githubusercontent.com/Soab42/agent/main/install.sh | bash -s -- \
  --token "YOUR_AGENT_TOKEN" \
  --control-plane "https://your-control-plane.com" \
  --encryption-key "YOUR_ENCRYPTION_KEY"
```

## Security & Encryption

The agent stores sensitive data (like database passwords for query management) in `~/.proplay/db_credentials.json`. 

### Dynamic Key Derivation
To ensure high security, the agent uses a **Dynamic Encryption Key** derived from:
- `ENCRYPTION_KEY`: A global master secret.
- `AGENT_TOKEN`: The unique token assigned to this specific server.

This derivation ensures that even if two servers share the same global key, their local secrets are encrypted with different keys, providing isolation between agents.

## Development

### Prerequisites
- Node.js 22.x+
- Nginx (for site management)
- PM2 (for process management)

### Local Setup
1. Install dependencies: `npm install`
2. Create `.env` file with required variables:
   - `AGENT_TOKEN`
   - `CONTROL_PLANE_URL`
   - `ENCRYPTION_KEY`
3. Run the agent: `npm start`
