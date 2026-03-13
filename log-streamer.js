'use strict';

const { spawn } = require('child_process');

const activeStreams = new Map();

function streamLogs(task, socket) {
    const { site_id, payload } = task;
    const { site_name, source, domain } = payload; // source: 'app' | 'nginx' | 'pm2'

    // Kill existing stream for this site and source if any
    const streamKey = `${site_id}:${source}`;
    if (activeStreams.has(streamKey)) {
        activeStreams.get(streamKey).kill();
        activeStreams.delete(streamKey);
    }

    let proc;
    if (source === 'app') {
        proc = spawn('journalctl', ['-u', `${site_name}.service`, '-f', '-n', '200', '--output=cat'], { shell: false });
    } else if (source === 'pm2') {
        // PM2 logs for the specific site
        proc = spawn('pm2', ['logs', site_id, '--lines', '200', '--no-colors'], { shell: true });
    } else if (source === 'nginx') {
        const logFile = `/var/log/nginx/${domain || site_name}.access.log`;
        proc = spawn('tail', ['-f', '-n', '200', logFile], { shell: false });
    } else {
        console.error(`Unknown log source: ${source}`);
        return;
    }

    activeStreams.set(streamKey, proc);

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
            socket.emit('log:line', { siteId: site_id, message: line, source });
        }
    });

    proc.stderr.on('data', (data) => {
        socket.emit('log:line', { siteId: site_id, message: data.toString().trim(), source: 'stderr' });
    });

    proc.on('close', () => {
        console.log(`Log stream closed for ${site_name} (${source})`);
        activeStreams.delete(streamKey);
    });

    // Stop streaming when socket disconnects or explicitly stops
    const cleanup = () => {
        proc.kill();
        activeStreams.delete(streamKey);
    };

    socket.on('disconnect', cleanup);
    socket.once('stop:logs', cleanup);

    return proc;
}

module.exports = { streamLogs };
