'use strict';

const os = require('os');
const { spawn } = require('child_process');

let pty;
try {
    pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
    console.warn("⚠️ PTY native module not found, falling back to basic child_process spawn. Interactive features like command-line apps may be limited.");
}

const sessions = new Map();

function handleTerminal(task, socket) {
    const { session_id, action, data, cols, rows } = task.payload;

    if (action === 'START') {
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        console.log(`🚀 Spawning shell: ${shell} (session: ${session_id})`);

        try {
            let ptyProcess;
            const cwd = process.env.HOME || process.env.USERPROFILE || process.cwd();
            let useBasicSpawn = !pty;

            if (pty) {
                try {
                    ptyProcess = pty.spawn(shell, [], {
                        name: 'xterm-color',
                        cols: cols || 80,
                        rows: rows || 24,
                        cwd,
                        env: process.env
                    });
                } catch (e) {
                    console.warn(`⚠️ PTY spawn failed (${e.message}), falling back to basic child_process spawn.`);
                    useBasicSpawn = true;
                }
            }

            if (!useBasicSpawn && ptyProcess) {
                ptyProcess.onData((data) => {
                    socket.emit('terminal:data', { session_id, data });
                });

                ptyProcess.onExit(() => {
                    socket.emit('terminal:exit', { session_id });
                    sessions.delete(session_id);
                });
            } else {
                // Fallback to basic spawn
                const isWin = os.platform() === 'win32';
                const args = isWin ? [] : ['-i'];
                ptyProcess = spawn(shell, args, {
                    cwd,
                    env: process.env,
                    shell: false
                });

                ptyProcess.stdout.on('data', (d) => {
                    // Convert basic newlines to terminal CRLF for xterm
                    socket.emit('terminal:data', { session_id, data: d.toString().replace(/\n/g, '\r\n') });
                });

                ptyProcess.stderr.on('data', (d) => {
                    socket.emit('terminal:data', { session_id, data: d.toString().replace(/\n/g, '\r\n') });
                });

                ptyProcess.on('close', () => {
                    socket.emit('terminal:exit', { session_id });
                    sessions.delete(session_id);
                });

                // Mock resize and write for fallback
                ptyProcess.write = (inputData) => ptyProcess.stdin.write(inputData);
                ptyProcess.resize = () => { };
            }

            sessions.set(session_id, { process: ptyProcess, isBasic: useBasicSpawn });

            // Send initial prompt for fallback
            if (useBasicSpawn) {
                socket.emit('terminal:data', { session_id, data: `\r\n\x1b[33m--- FALLBACK MODE: Pseudo-terminal missing. Basic shell only. ---\x1b[0m\r\n> ` });
            }
        } catch (error) {
            console.error(`Failed to spawn shell: ${error.message}`);
            socket.emit('terminal:exit', { session_id });
        }
    } else if (action === 'DATA') {
        const session = sessions.get(session_id);
        if (session && session.process) {
            session.process.write(data);
        }
    } else if (action === 'RESIZE') {
        const session = sessions.get(session_id);
        if (session && session.process && cols && rows) {
            try {
                session.process.resize(cols, rows);
            } catch (e) {
                // Ignore resize errors
            }
        }
    } else if (action === 'STOP') {
        const session = sessions.get(session_id);
        if (session && session.process) {
            session.process.kill();
            sessions.delete(session_id);
        }
    }
}

module.exports = { handleTerminal };
