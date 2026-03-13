'use strict';

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function issueSsl(task, socket) {
    const { domain, site_id, email } = task.payload;

    try {
        // Check if certbot is installed
        try {
            await execPromise('certbot --version');
        } catch (e) {
            console.log('⚠️ certbot not found. Attempting to install...');
            socket.emit('deploy:log', { deployId: task.task_id, message: 'certbot not found. Attempting to install...', stream: 'stdout' });
            
            if (process.platform === 'linux') {
                await execPromise('sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx');
                console.log('✅ certbot installed successfully.');
            } else {
                throw new Error('certbot is not installed and automatic installation is only supported on Linux. Please install certbot manually.');
            }
        }

        console.log(`🔒 Requesting SSL for domain: ${domain} (Email: ${email})`);
        // Requires certbot installed on the VPS
        const { stdout, stderr } = await execPromise(`sudo certbot certonly --nginx -d ${domain} --non-interactive --agree-tos -m ${email}`);

        console.log(`✅ SSL Issued for ${domain}`);
        socket.emit('ssl:response', {
            task_id: task.task_id,
            success: true,
            message: `SSL Successfully issued for ${domain}`,
            stdout
        });

        socket.emit('site:status', { siteId: site_id, status: 'SSL_READY' });
    } catch (err) {
        console.error(`❌ SSL Issue failed: ${err.message}`);
        socket.emit('ssl:response', {
            task_id: task.task_id,
            error: err.message
        });
    }
}

module.exports = { issueSsl };
