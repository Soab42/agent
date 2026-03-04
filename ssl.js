'use strict';

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function issueSsl(task, socket) {
    const { domain, site_id } = task.payload;

    try {
        console.log(`🔒 Requesting SSL for domain: ${domain}`);
        // Requires certbot installed on the VPS
        const { stdout, stderr } = await execPromise(`certbot certonly --nginx -d ${domain} --non-interactive --agree-tos -m deploy@proplay.io`);

        console.log(`✅ SSL Issued for ${domain}`);
        socket.emit('deploy:log', {
            deployId: task.task_id,
            message: `SSL Successfully issued for ${domain}\n${stdout}`,
            stream: 'stdout'
        });

        socket.emit('site:status', { siteId: site_id, status: 'SSL_READY' });
    } catch (err) {
        console.error(`❌ SSL Issue failed: ${err.message}`);
        socket.emit('deploy:log', {
            deployId: task.task_id,
            message: `SSL Failure: ${err.message}`,
            stream: 'stderr'
        });
    }
}

module.exports = { issueSsl };
