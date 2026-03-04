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
            const allowed = ['cat ', 'ls ', 'df ', 'free ', 'uptime', 'uname', 'systemctl status '];
            const isAllowed = allowed.some(prefix => rawCmd.trim().startsWith(prefix));
            if (!isAllowed) {
                return respond(null, 'Command not allowed. Use a predefined commandKey or a safe read-only command.');
            }
            cmd = rawCmd;
        } else {
            return respond(null, 'No command specified');
        }

        const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
        respond({ stdout: stdout.trim(), stderr: stderr.trim(), cmd, exitCode: 0 });
    } catch (err) {
        respond(null, err.message);
    }
}

module.exports = { handleExec, COMMAND_MAP };
