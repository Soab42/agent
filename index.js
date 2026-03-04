#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { io } = require('socket.io-client');
const { execDeploy } = require('./executor');
const { rollback } = require('./rollback');
const { streamLogs } = require('./log-streamer');
const { handleTerminal } = require('./terminal');
const { issueSsl } = require('./ssl');

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3001';
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
    console.error('❌ AGENT_TOKEN environment variable is required');
    process.exit(1);
}

const socket = io(`${CONTROL_PLANE_URL}/agent`, {
    auth: { token: AGENT_TOKEN },
    reconnection: true,
    reconnectionDelay: 3000,
    transports: ['websocket'],
});

socket.on('connect', () => {
    console.log(`✅ Agent connected to control plane: ${CONTROL_PLANE_URL}`);
});

socket.on('disconnect', (reason) => {
    console.warn(`⚠️  Agent disconnected: ${reason}`);
});

socket.on('task', async (task) => {
    console.log(`📦 Received task: ${task.action} [${task.task_id}]`);

    try {
        switch (task.action) {
            case 'DEPLOY':
                await execDeploy(task, socket);
                break;
            case 'ROLLBACK':
                await rollback(task, socket);
                break;
            case 'STREAM_LOGS':
                streamLogs(task, socket);
                break;
            case 'TERMINAL':
                handleTerminal(task, socket);
                break;
            case 'ISSUE_SSL':
                await issueSsl(task, socket);
                break;
            default:
                console.warn(`Unknown action: ${task.action}`);
        }
    } catch (err) {
        console.error(`Task failed: ${err.message}`);
        socket.emit('deploy:status', {
            siteId: task.site_id,
            status: 'FAILED',
        });
    }
});

process.on('SIGTERM', () => {
    socket.disconnect();
    process.exit(0);
});

console.log(`🚀 Proplay Agent starting... connecting to ${CONTROL_PLANE_URL}`);
