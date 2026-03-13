'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { generateNginxConfig } = require('./nginx');

const execAsync = promisify(exec);
const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

async function handleNginxGet(task, socket) {
    const { site_name } = task.payload;
    const configPath = path.join(NGINX_CONF_DIR, `${site_name}.conf`);
    
    try {
        if (!fs.existsSync(configPath)) {
            return socket.emit('nginx:response', { task_id: task.task_id, error: `Nginx config not found for ${site_name} at expected path: ${configPath}` });
        }
        const content = fs.readFileSync(configPath, 'utf8');
        socket.emit('nginx:response', { task_id: task.task_id, content });
    } catch (err) {
        socket.emit('nginx:response', { task_id: task.task_id, error: err.message });
    }
}

async function handleNginxSave(task, socket) {
    const { site_name, content } = task.payload;
    const configPath = path.join(NGINX_CONF_DIR, `${site_name}.conf`);
    const tempPath = path.join('/tmp', `${site_name}.conf.save`);

    try {
        fs.writeFileSync(tempPath, content);
        await execAsync(`sudo mv ${tempPath} ${configPath}`);
        await execAsync('sudo nginx -t && sudo systemctl reload nginx');
        socket.emit('nginx:response', { task_id: task.task_id, success: true });
    } catch (err) {
        socket.emit('nginx:response', { task_id: task.task_id, error: err.message });
    }
}

async function handleNginxUpdate(task, socket) {
    const { task_id, site_id, payload } = task;
    console.log(`🌐 Received NGINX_UPDATE for site: ${payload.site_name}, SSL enabled: ${payload.ssl_enabled}`);
    const { site_name, domain, framework, port, base_path, root_folder, redirects } = payload;

    try {
        const config = generateNginxConfig({
            site_name,
            framework,
            port,
            domain,
            base_path,
            root_folder,
            ssl_enabled: payload.ssl_enabled,
            redirects
        });
        console.log(`📄 Generated Nginx config (first 100 chars): ${config.substring(0, 100)}...`);

        const tempPath = path.join('/tmp', `${site_name}.conf`);
        fs.writeFileSync(tempPath, config);

        // Debian-style robust update: available -> enabled link
        const availableDir = NGINX_CONF_DIR.replace('sites-enabled', 'sites-available');
        const availableFile = path.join(availableDir, `${site_name}.conf`);
        const enabledFile = path.join(NGINX_CONF_DIR, `${site_name}.conf`);

        // 1. Move to sites-available if it exists, otherwise just sites-enabled
        if (fs.existsSync(availableDir)) {
            await execAsync(`sudo mv ${tempPath} ${availableFile}`);
            // 2. Ensure symlink exists in sites-enabled
            try {
                // Remove if it's a regular file instead of a link
                const stat = fs.lstatSync(enabledFile);
                if (!stat.isSymbolicLink()) {
                    await execAsync(`sudo rm -f ${enabledFile}`);
                }
            } catch (e) {}
            await execAsync(`sudo ln -sf ${availableFile} ${enabledFile}`);
        } else {
            await execAsync(`sudo mv ${tempPath} ${enabledFile}`);
        }

        await execAsync('sudo nginx -t && sudo systemctl reload nginx');

        console.log(`✅ Nginx config updated for ${site_name}`);
        socket.emit('nginx:response', { task_id: task_id, success: true });
    } catch (err) {
        console.error(`❌ Failed to update Nginx for ${site_name}: ${err.message}`);
        socket.emit('nginx:response', { 
            task_id: task_id,
            error: err.message
        });
    }
}

module.exports = { handleNginxUpdate, handleNginxGet, handleNginxSave };
