'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateNginxConfig } = require('./nginx');

const SITES_ROOT = process.env.SITES_ROOT || '/var/www';

function log(socket, deployId, message, stream = 'stdout') {
    console.log(`[${stream}] ${message}`);
    socket.emit('deploy:log', { deployId, message, stream });
}

async function execCmd(cmd, cwd, socket, deployId) {
    return new Promise((resolve, reject) => {
        log(socket, deployId, `$ ${cmd}`);
        const parts = cmd.split(' ');
        const proc = spawn(parts[0], parts.slice(1), { cwd, shell: true, env: { ...process.env } });
        proc.stdout.on('data', d => log(socket, deployId, d.toString().trimEnd(), 'stdout'));
        proc.stderr.on('data', d => log(socket, deployId, d.toString().trimEnd(), 'stderr'));
        proc.on('close', code => {
            if (code !== 0) reject(new Error(`Command failed with exit code ${code}: ${cmd}`));
            else resolve();
        });
    });
}

async function execDeploy(task, socket) {
    const { deploy_id, site_id, payload } = task;
    const {
        site_name, repo_url, branch, framework,
        build_cmd, start_cmd, port, release_id, keep_releases, env,
    } = payload;

    const siteRoot = path.join(SITES_ROOT, site_name);
    const releasesDir = path.join(siteRoot, 'releases');
    const sharedDir = path.join(siteRoot, 'shared');
    const releaseDir = path.join(releasesDir, release_id);
    const currentLink = path.join(siteRoot, 'current');

    try {
        // Step 1: Ensure directories exist
        log(socket, deploy_id, '📁 Preparing release directory...');
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.mkdirSync(path.join(sharedDir, 'logs'), { recursive: true });

        // Step 2: Write .env to shared
        const envContent = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(sharedDir, '.env'), envContent, { mode: 0o600 });

        // Step 3: Git clone
        log(socket, deploy_id, `🔗 Cloning ${repo_url} (${branch})...`);
        await execCmd(`git clone --depth=1 --branch ${branch} ${repo_url} .`, releaseDir, socket, deploy_id);

        // Step 4: npm ci
        log(socket, deploy_id, '📦 Installing dependencies...');
        await execCmd('npm ci', releaseDir, socket, deploy_id);

        // Step 5: Build
        const defaultBuildCmd = ['NEXTJS', 'NESTJS', 'REACT_SPA'].includes(framework) ? 'npm run build' : null;
        const effectiveBuild = build_cmd || defaultBuildCmd;
        if (effectiveBuild) {
            log(socket, deploy_id, `🔨 Building (${effectiveBuild})...`);
            await execCmd(effectiveBuild, releaseDir, socket, deploy_id);
        }

        // Step 6: Symlink .env
        const envLink = path.join(releaseDir, '.env');
        if (!fs.existsSync(envLink)) {
            fs.symlinkSync(path.join(sharedDir, '.env'), envLink);
        }

        // Step 7: Atomic switch of `current` symlink
        log(socket, deploy_id, '🔄 Switching current symlink...');
        if (fs.existsSync(currentLink)) {
            fs.unlinkSync(currentLink);
        }
        fs.symlinkSync(releaseDir, currentLink);

        // Step 8: Generate and reload Nginx config
        log(socket, deploy_id, '🌐 Configuring Nginx...');
        generateNginxConfig({ site_name, framework, port });
        await execCmd('sudo nginx -t && sudo systemctl reload nginx', releaseDir, socket, deploy_id);

        // Step 9: Create/restart systemd service
        log(socket, deploy_id, '⚙️  Managing systemd service...');
        const serviceFile = `/etc/systemd/system/${site_name}.service`;
        const startCommand = start_cmd || getDefaultStartCmd(framework, port);
        const serviceContent = generateSystemdUnit(site_name, siteRoot, startCommand, port);
        fs.writeFileSync(serviceFile, serviceContent);
        await execCmd(`sudo systemctl daemon-reload`, releaseDir, socket, deploy_id);
        await execCmd(`sudo systemctl enable ${site_name}`, releaseDir, socket, deploy_id);
        await execCmd(`sudo systemctl restart ${site_name}`, releaseDir, socket, deploy_id);

        // Step 10: Prune old releases
        pruneReleases(releasesDir, keep_releases || 5, socket, deploy_id);

        // Report success
        log(socket, deploy_id, '✅ Deployment successful!');
        socket.emit('deploy:status', { siteId: site_id, status: 'SUCCESS', deployId: deploy_id });
    } catch (err) {
        log(socket, deploy_id, `❌ Deploy failed: ${err.message}`, 'stderr');
        socket.emit('deploy:status', { siteId: site_id, status: 'FAILED', deployId: deploy_id });
    }
}

function getDefaultStartCmd(framework, port) {
    switch (framework) {
        case 'NEXTJS': return `node node_modules/next/dist/bin/next start -p ${port}`;
        case 'NESTJS': return `node dist/main.js`;
        case 'EXPRESS': return `node dist/server.js`;
        case 'REACT_SPA': return null; // static, no process needed
        default: return `node index.js`;
    }
}

function generateSystemdUnit(siteName, siteRoot, startCmd, port) {
    return `[Unit]
Description=Proplay managed service: ${siteName}
After=network.target

[Service]
User=deploy
WorkingDirectory=${siteRoot}/current
EnvironmentFile=${siteRoot}/shared/.env
Environment=PORT=${port}
ExecStart=${startCmd}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${siteName}

[Install]
WantedBy=multi-user.target
`;
}

function pruneReleases(releasesDir, keep, socket, deployId) {
    try {
        const releases = fs.readdirSync(releasesDir).sort();
        const toDelete = releases.slice(0, Math.max(0, releases.length - keep));
        for (const rel of toDelete) {
            fs.rmSync(path.join(releasesDir, rel), { recursive: true, force: true });
            log(socket, deployId, `🗑️  Pruned old release: ${rel}`);
        }
    } catch (e) {
        log(socket, deployId, `⚠️  Could not prune releases: ${e.message}`, 'stderr');
    }
}

module.exports = { execDeploy };
