'use strict';
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Parse `systemctl show <name> --no-pager` output into a structured object.
 */
function parseSystemctlShow(output) {
    const fields = {};
    for (const line of output.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > -1) {
            fields[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
        }
    }
    return fields;
}

/**
 * Get clean status for one service.
 */
async function getServiceStatus(name) {
    try {
        const { stdout } = await execAsync(
            `systemctl show "${name}" --no-pager --property=ActiveState,SubState,LoadState,Description,FragmentPath,MainPID,ExecMainStartTimestamp,ActiveEnterTimestamp`,
            { timeout: 5000 }
        );
        const f = parseSystemctlShow(stdout);
        return {
            name,
            description: f.Description || name,
            activeState: f.ActiveState || 'unknown',
            subState: f.SubState || 'unknown',
            loadState: f.LoadState || 'not-found',
            running: f.ActiveState === 'active' && f.SubState === 'running',
            pid: f.MainPID && f.MainPID !== '0' ? parseInt(f.MainPID) : null,
            startedAt: f.ActiveEnterTimestamp || null,
            exists: f.LoadState !== 'not-found',
        };
    } catch {
        return {
            name,
            description: name,
            activeState: 'unknown',
            subState: 'unknown',
            loadState: 'not-found',
            running: false,
            pid: null,
            startedAt: null,
            exists: false,
        };
    }
}

/**
 * Common services to always check + any site-specific systemd units.
 */
const COMMON_SERVICES = [
    'nginx',
    'ssh',
    'sshd',
    'ufw',
    'fail2ban',
    'redis',
    'redis-server',
    'postgresql',
    'mysql',
    'mariadb',
    'docker',
    'supervisor',
];

async function handleServices(task, socket) {
    const { task_id, action, payload = {} } = task;

    const respond = (data, error = null) => {
        socket.emit('services:response', { task_id, action, data, error });
    };

    try {
        switch (action) {
            case 'SERVICES_LIST': {
                const extraNames = (payload.siteServices || []);
                const names = [...new Set([...COMMON_SERVICES, ...extraNames])];

                const statuses = await Promise.all(names.map(getServiceStatus));
                // Filter to only services that exist OR are site-specific
                const filtered = statuses.filter(s => s.exists || extraNames.includes(s.name));
                respond({ services: filtered });
                break;
            }

            case 'SERVICE_START': {
                const { name } = payload;
                await execAsync(`sudo systemctl start "${name}"`, { timeout: 15000 });
                const status = await getServiceStatus(name);
                respond({ name, action: 'started', status });
                break;
            }

            case 'SERVICE_STOP': {
                const { name } = payload;
                await execAsync(`sudo systemctl stop "${name}"`, { timeout: 15000 });
                const status = await getServiceStatus(name);
                respond({ name, action: 'stopped', status });
                break;
            }

            case 'SERVICE_RESTART': {
                const { name } = payload;
                await execAsync(`sudo systemctl restart "${name}"`, { timeout: 20000 });
                const status = await getServiceStatus(name);
                respond({ name, action: 'restarted', status });
                break;
            }

            case 'SERVICE_STATUS': {
                const { name } = payload;
                const status = await getServiceStatus(name);
                respond({ name, status });
                break;
            }

            default:
                respond(null, `Unknown services action: ${action}`);
        }
    } catch (err) {
        socket.emit('services:response', { task_id, action, data: null, error: err.message });
    }
}

module.exports = { handleServices };
