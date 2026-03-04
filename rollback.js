'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SITES_ROOT = process.env.SITES_ROOT || '/var/www';
const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

function rollback(task, socket) {
    const { site_id, payload } = task;
    const { site_name, release_id, port } = payload;

    const siteRoot = path.join(SITES_ROOT, site_name);
    const releaseDir = path.join(siteRoot, 'releases', release_id);
    const currentLink = path.join(siteRoot, 'current');

    try {
        if (!fs.existsSync(releaseDir)) {
            throw new Error(`Release directory not found: ${release_id}`);
        }
        if (fs.existsSync(currentLink)) fs.unlinkSync(currentLink);
        fs.symlinkSync(releaseDir, currentLink);
        execSync(`sudo systemctl restart ${site_name}`);
        console.log(`✅ Rolled back to ${release_id}`);
        socket.emit('deploy:status', { siteId: site_id, status: 'SUCCESS' });
    } catch (err) {
        console.error(`Rollback failed: ${err.message}`);
        socket.emit('deploy:status', { siteId: site_id, status: 'FAILED' });
    }
}

module.exports = { rollback };
