'use strict';
const os = require('os');
const { execSync } = require('child_process');

/**
 * Collect system metrics using Node.js built-in os module + /proc (Linux).
 * Works on any Linux VPS without additional npm packages.
 */

function getCpuUsage() {
    // Measure CPU by diffing /proc/stat twice 200ms apart
    return new Promise((resolve) => {
        const parseCpuLine = () => {
            try {
                const stat = require('fs').readFileSync('/proc/stat', 'utf8');
                const line = stat.split('\n')[0].trim().split(/\s+/);
                const vals = line.slice(1).map(Number);
                const total = vals.reduce((a, b) => a + b, 0);
                const idle = vals[3];
                return { total, idle };
            } catch {
                return null;
            }
        };

        const first = parseCpuLine();
        if (!first) { resolve(0); return; }

        setTimeout(() => {
            const second = parseCpuLine();
            if (!second) { resolve(0); return; }
            const totalDiff = second.total - first.total;
            const idleDiff = second.idle - first.idle;
            const usage = totalDiff > 0 ? 100 * (1 - idleDiff / totalDiff) : 0;
            resolve(Math.round(usage * 10) / 10);
        }, 200);
    });
}

function getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
        total: Math.round(total / 1024 / 1024),   // MB
        used: Math.round(used / 1024 / 1024),      // MB
        free: Math.round(free / 1024 / 1024),      // MB
        percent: Math.round((used / total) * 1000) / 10,
    };
}

function getDiskUsage() {
    try {
        // df -BM / outputs like "Filesystem   1M-blocks  Used Available Use% Mounted on"
        const output = execSync("df -BM / | tail -1", { timeout: 3000 }).toString().trim();
        const parts = output.split(/\s+/);
        const total = parseInt(parts[1]);  // in MB
        const used = parseInt(parts[2]);
        const available = parseInt(parts[3]);
        const percent = parseFloat(parts[4]);
        return { total, used, available, percent };
    } catch {
        return { total: 0, used: 0, available: 0, percent: 0 };
    }
}

function getLoadAvg() {
    const loads = os.loadavg();
    return {
        '1m': Math.round(loads[0] * 100) / 100,
        '5m': Math.round(loads[1] * 100) / 100,
        '15m': Math.round(loads[2] * 100) / 100,
    };
}

/**
 * Start emitting server metrics to the control plane every `interval` ms.
 */
async function startMetrics(socket, interval = 10000) {
    console.log('📊 Metrics collection started');

    const collect = async () => {
        try {
            const [cpu, memory, disk, loadAvg] = await Promise.all([
                getCpuUsage(),
                Promise.resolve(getMemoryUsage()),
                Promise.resolve(getDiskUsage()),
                Promise.resolve(getLoadAvg()),
            ]);

            socket.emit('server:metrics', {
                ts: new Date().toISOString(),
                cpu,
                memory,
                disk,
                loadAvg,
                uptime: Math.floor(os.uptime()),
            });
        } catch (err) {
            console.error('Metrics collection error:', err.message);
        }
    };

    // Emit immediately on connect, then on interval
    await collect();
    return setInterval(collect, interval);
}

module.exports = { startMetrics };
