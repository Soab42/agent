#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { io } = require('socket.io-client');
const { execDeploy } = require('./executor');
const { rollback } = require('./rollback');
const { streamLogs } = require('./log-streamer');
const { handleTerminal } = require('./terminal');
const { issueSsl } = require('./ssl');
const { startMetrics } = require('./metrics');
const { handleFileManager } = require('./filemanager');
const { handleServices } = require('./services');
const { handleExec } = require('./exec');
const { handleNginxUpdate, handleNginxGet, handleNginxSave } = require('./nginx-manager');
const { handleSiteDelete, handleSiteRestart } = require('./site-manager');


const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:3001';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const METRICS_INTERVAL = parseInt(process.env.METRICS_INTERVAL || '10000', 10);

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

let metricsTimer = null;

socket.on('connect', async () => {
    console.log(`✅ Agent connected to control plane: ${CONTROL_PLANE_URL}`);
    // Start sending metrics immediately after connection
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = await startMetrics(socket, METRICS_INTERVAL);
});

socket.on('disconnect', (reason) => {
    console.warn(`⚠️  Agent disconnected: ${reason}`);
    if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
    }
});

socket.onAny((event, ...args) => {
    console.log(`📡 Socket Event: ${event}`, JSON.stringify(args));
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
            case 'NGINX_UPDATE':
                await handleNginxUpdate(task, socket);
                break;
            case 'NGINX_GET':
                await handleNginxGet(task, socket);
                break;
            case 'NGINX_SAVE':
                await handleNginxSave(task, socket);
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
            case 'FS_LIST':
            case 'FS_READ':
            case 'FS_WRITE':
            case 'FS_DELETE':
            case 'FS_RENAME':
            case 'FS_MKDIR':
            case 'FS_CREATE':
                await handleFileManager(task, socket);
                break;
            case 'SERVICES_LIST':
            case 'SERVICE_START':
            case 'SERVICE_STOP':
            case 'SERVICE_RESTART':
            case 'SERVICE_STATUS':
                await handleServices(task, socket);
                break;
            case 'EXEC':
                await handleExec(task, socket);
                break;
            case 'SITE_DELETE':
                await handleSiteDelete(task, socket);
                break;
            case 'SITE_RESTART':
                await handleSiteRestart(task, socket);
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
    if (metricsTimer) clearInterval(metricsTimer);
    socket.disconnect();
    process.exit(0);
});

console.log(`🚀 Proplay Agent starting... connecting to ${CONTROL_PLANE_URL}`);
