'use strict';
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Trusted command allowlist — only these prefixes are allowed for security.
 * The frontend sends a command key; the agent maps it to the real command.
 */
const COMMAND_MAP = {
    'nginx:restart':   'sudo systemctl restart nginx',
    'nginx:reload':    'sudo systemctl reload nginx',
    'nginx:test':      'sudo nginx -t',
    'php-fpm:restart': 'sudo systemctl restart php-fpm || sudo systemctl restart php8.1-fpm || sudo systemctl restart php8.2-fpm',
    'redis:restart':   'sudo systemctl restart redis',
    'server:reboot':   'sudo shutdown -r +0',
    'apt:update':      'sudo apt-get update -y && sudo apt-get upgrade -y',
    'docker:install':  'curl -fsSL https://get.docker.com | sh',
    'nvm:install':     'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash',
    'ufw:status':      'sudo ufw status verbose',
    'sysinfo':         'uname -a && df -h && free -h && uptime',
    
    // Agent management
    'agent:update':    'cd /opt/proplay-agent && ([ -f update.sh ] && bash update.sh || (git pull && npm install --production --silent && sudo systemctl restart proplay-agent))',
    'agent:restart':   'sudo systemctl restart proplay-agent',
    'agent:destroy':   'pm2 delete proplay-agent 2>/dev/null; sudo systemctl stop proplay-agent 2>/dev/null; sudo systemctl disable proplay-agent 2>/dev/null; echo "Agent destroyed."',
    'agent:logs':      'pm2 logs proplay-agent --lines 100 --no-colors --nostream 2>/dev/null || journalctl -u proplay-agent -n 100 --no-pager 2>/dev/null || echo "No agent logs found."',
    
    // Database installations
    'db:mysql:9.0':    'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mysql-server', 
    'db:mysql:8.4':    'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mysql-server',
    'db:mysql:8.0':    'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mysql-server',
    'db:mariadb:11.4': 'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mariadb-server',
    'db:mariadb:11.2': 'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mariadb-server',
    'db:mariadb:10.11':'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y mariadb-server',
    'db:postgres:18':  'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y postgresql-18',
    'db:postgres:17':  'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y postgresql-17',
    'db:postgres:16':  'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y postgresql-16',
    'db:postgres:15':  'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y postgresql-15',
    'db:postgres:14':  'export DEBIAN_FRONTEND=noninteractive && while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 1; done; sudo apt-get update && sudo apt-get install -y postgresql-14',
};

async function handleExec(task, socket) {
    const { task_id, payload = {} } = task;
    const { commandKey, rawCmd } = payload;

    const respond = (data, error = null) => {
        socket.emit('exec:response', { task_id, data, error });
    };

    try {
        let cmd = null;

        if (commandKey && COMMAND_MAP[commandKey]) {
            cmd = COMMAND_MAP[commandKey];
        } else if (rawCmd) {
            // rawCmd is only accepted for read-only commands
            const allowed = ['cat ', 'ls ', 'df ', 'free ', 'uptime', 'uname', 'systemctl status ', 'pm2 '];
            const isAllowed = allowed.some(prefix => rawCmd.trim().startsWith(prefix));
            if (!isAllowed) {
                return respond(null, 'Command not allowed. Use a predefined commandKey or a safe read-only command.');
            }
            cmd = rawCmd;
        } else {
            return respond(null, 'No command specified');
        }

        const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 });
        respond({ stdout: stdout.trim(), stderr: stderr.trim(), cmd, exitCode: 0 });
    } catch (err) {
        respond(null, err.message);
    }
}

module.exports = { handleExec, COMMAND_MAP };
