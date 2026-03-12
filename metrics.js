'use strict';
const os = require('os');
const { execSync } = require('child_process');

/**
 * Collect system metrics using Node.js built-in os module + platform-specific fallback.
 */

async function getCpuUsage() {
    const isWindows = process.platform === 'win32';
    
    if (isWindows) {
        // Fast Windows CPU check via wmic or use os.cpus()
        try {
            const output = execSync('wmic cpu get loadpercentage /value').toString();
            const match = output.match(/LoadPercentage=(\d+)/);
            return match ? parseFloat(match[1]) : 0;
        } catch {
            return 0;
        }
    }

    // Linux: Measure CPU by diffing /proc/stat twice 200ms apart
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
        if (process.platform === 'win32') {
             // Windows disk check
             const output = execSync('wmic logicaldisk get size,freespace,caption /value').toString();
             const lines = output.split('\n').filter(l => l.trim().length > 0);
             const disk = {};
             lines.forEach(line => {
                 const [key, val] = line.split('=');
                 if (key && val) disk[key.trim()] = val.trim();
             });
             const total = parseInt(disk.Size);
             const available = parseInt(disk.FreeSpace);
             const used = total - available;
             return {
                 total: Math.round(total / 1024 / 1024),
                 used: Math.round(used / 1024 / 1024),
                 available: Math.round(available / 1024 / 1024),
                 percent: Math.round((used / total) * 1000) / 10
             };
        }
        // Linux: df -BM / outputs like "Filesystem   1M-blocks  Used Available Use% Mounted on"
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
    // Windows returns [0, 0, 0] for loadavg usually, but standardizes the return
    return {
        '1m': Math.round(loads[0] * 100) / 100,
        '5m': Math.round(loads[1] * 100) / 100,
        '15m': Math.round(loads[2] * 100) / 100,
    };
}

let lastNet = { rx: 0, tx: 0, ts: 0 };

async function getNetworkUsage() {
    try {
        if (process.platform === 'win32') {
            // Very simplified Windows check
            return { rx: 0, tx: 0 }; 
        }
        
        // Linux: /proc/net/dev
        const content = require('fs').readFileSync('/proc/net/dev', 'utf8');
        const lines = content.split('\n');
        let rx_total = 0, tx_total = 0;
        
        for (const line of lines) {
            if (line.includes(':') && !line.includes('lo:')) {
                const parts = line.trim().split(/\s+/);
                rx_total += parseInt(parts[1]);
                tx_total += parseInt(parts[9]);
            }
        }
        
        const now = Date.now();
        const delta = (now - lastNet.ts) / 1000;
        
        let rx_rate = 0, tx_rate = 0;
        if (lastNet.ts > 0 && delta > 0) {
            rx_rate = Math.round((rx_total - lastNet.rx) / delta);
            tx_rate = Math.round((tx_total - lastNet.tx) / delta);
        }
        
        lastNet = { rx: rx_total, tx: tx_total, ts: now };
        
        return {
            rx: Math.max(0, rx_rate), // B/s
            tx: Math.max(0, tx_rate)  // B/s
        };
    } catch {
        return { rx: 0, tx: 0 };
    }
}

function getSystemInfo(diskTotal) {
    return {
        hostname: os.hostname(),
        platform: process.platform,
        release: os.release(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        cpuCores: os.cpus().length,
        totalMem: Math.round(os.totalmem() / 1024 / 1024), // MB
        totalDisk: diskTotal || 0, // MB
    };
}

/**
 * Start emitting server metrics to the control plane every `interval` ms.
 */
async function startMetrics(socket, interval = 10000) {
    console.log('📊 Metrics collection started');

    const collect = async () => {
        try {
            const [cpu, memory, disk, loadAvg, network] = await Promise.all([
                getCpuUsage(),
                Promise.resolve(getMemoryUsage()),
                Promise.resolve(getDiskUsage()),
                Promise.resolve(getLoadAvg()),
                getNetworkUsage()
            ]);

            const system = getSystemInfo(disk.total);

            socket.emit('server:metrics', {
                ts: new Date().toISOString(),
                cpu,
                memory,
                disk,
                loadAvg,
                network,
                system,
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
