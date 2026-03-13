'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

const { startOrRestartPM2 } = require('./pm2-manager');

/**
 * Clean up all server-side resources for a site.
 */
async function handleSiteDelete(task, socket) {
    const { task_id, site_id, payload } = task;
    const { site_name, base_path } = payload;

    const results = {
        pm2: false,
        nginx: false,
        files: false
    };

    try {
        // 1. Delete PM2 process
        try {
            await execAsync(`pm2 delete ${site_id}`);
            await execAsync('pm2 save');
            results.pm2 = true;
        } catch (e) {
            // Ignore if process doesn't exist
            console.warn(`PM2: Could not delete process ${site_id}: ${e.message}`);
        }

        // 2. Delete Nginx config
        try {
            const configPath = path.join(NGINX_CONF_DIR, `${site_name}.conf`);
            if (fs.existsSync(configPath)) {
                await execAsync(`sudo rm ${configPath}`);
                await execAsync('sudo nginx -t && sudo systemctl reload nginx');
                results.nginx = true;
            }
        } catch (e) {
            console.error(`Nginx: Failed to cleanup config for ${site_name}: ${e.message}`);
        }

        // 3. Delete site folder
        try {
            if (base_path && fs.existsSync(base_path)) {
                // Security check: ensure we are not deleting something dangerous
                if (base_path.length > 5 && (base_path.startsWith('/var/www') || base_path.includes('/proplay/'))) {
                    fs.rmSync(base_path, { recursive: true, force: true });
                    results.files = true;
                } else {
                    console.warn(`Files: Skip deletion of potentially dangerous path: ${base_path}`);
                }
            }
        } catch (e) {
            console.error(`Files: Failed to delete path ${base_path}: ${e.message}`);
        }

        socket.emit('fs:response', { 
            task_id, 
            success: true, 
            details: results 
        });
        
        console.log(`✅ Site cleanup completed for ${site_name}`);

    } catch (err) {
        console.error(`❌ Site cleanup failed for ${site_name}: ${err.message}`);
        socket.emit('fs:response', { 
            task_id, 
            error: err.message 
        });
    }
}

/**
 * Restart a site's process using stored configuration.
 */
async function handleSiteRestart(task, socket) {
    const { task_id, site_id, payload } = task;
    const { site_name, framework, port, start_cmd, start_args, pm2_instances, base_path, root_folder } = payload;

    const pushLog = (msg, stream = 'stdout') => {
        console.log(`[${stream}] ${msg}`);
        socket.emit('site:log', { task_id, site_id, message: msg, stream });
    };

    try {
        const siteRoot = base_path;
        const currentLink = path.join(siteRoot, 'current');
        const projectDir = root_folder ? path.join(currentLink, root_folder) : currentLink;

        if (!fs.existsSync(projectDir)) {
            throw new Error(`Project directory not found: ${projectDir}. Have you deployed yet?`);
        }

        await startOrRestartPM2({
            site_id,
            site_name,
            framework,
            port,
            start_cmd,
            start_args,
            pm2_instances,
            project_dir: projectDir
        }, pushLog);

        socket.emit('site:response', { task_id, success: true });
        console.log(`✅ Site restart completed for ${site_name}`);

    } catch (err) {
        console.error(`❌ Site restart failed for ${site_name}: ${err.message}`);
        socket.emit('site:response', { 
            task_id, 
            error: err.message 
        });
    }
}

module.exports = { handleSiteDelete, handleSiteRestart };
