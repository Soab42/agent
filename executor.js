'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateNginxConfig } = require('./nginx');

const SITES_ROOT = process.env.SITES_ROOT || '/var/www';

function log(socket, deployId, siteId, message, stream = 'stdout') {
    console.log(`[${stream}] ${message}`);
    socket.emit('deploy:log', { deployId, siteId, message, stream });
}

async function execCmd(cmd, cwd, socket, deployId, siteId) {
    return new Promise((resolve, reject) => {
        log(socket, deployId, siteId, `$ ${cmd}`);
        const parts = cmd.split(' ');
        const proc = spawn(parts[0], parts.slice(1), { cwd, shell: true, env: { ...process.env } });
        proc.stdout.on('data', d => log(socket, deployId, siteId, d.toString().trimEnd(), 'stdout'));
        proc.stderr.on('data', d => log(socket, deployId, siteId, d.toString().trimEnd(), 'stderr'));
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
        build_cmd, start_cmd, port, release_id, keep_releases, env, base_path
    } = payload;

    const siteRoot = base_path || path.join(SITES_ROOT, site_name);
    const releasesDir = path.join(siteRoot, 'releases');
    const sharedDir = path.join(siteRoot, 'shared');
    const releaseDir = path.join(releasesDir, release_id);
    const currentLink = path.join(siteRoot, 'current');

    try {
        // Step 1: Ensure directories exist
        log(socket, deploy_id, site_id, '📁 Preparing release directory...');
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.mkdirSync(path.join(sharedDir, 'logs'), { recursive: true });

        // Step 2: Write .env to shared
        const envContent = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(sharedDir, '.env'), envContent, { mode: 0o600 });

        // Step 3: Git clone
        log(socket, deploy_id, site_id, `🔗 Cloning ${repo_url} (${branch})...`);
        await execCmd(`git clone --depth=1 --branch ${branch} ${repo_url} .`, releaseDir, socket, deploy_id, site_id);

        // Step 4: Intelligent Install
        const installCmd = getInstallCmd(releaseDir);
        log(socket, deploy_id, site_id, `📦 Installing dependencies (${installCmd})...`);
        await execCmd(installCmd, releaseDir, socket, deploy_id, site_id);

        // Step 5: Build
        const defaultBuildCmd = ['NEXTJS', 'NESTJS', 'REACT_SPA'].includes(framework) ? 'npm run build' : null;
        let effectiveBuild = build_cmd || defaultBuildCmd;

        // If using pnpm, try pnpm build if default was npm
        if (installCmd.startsWith('pnpm') && effectiveBuild === 'npm run build') {
            effectiveBuild = 'pnpm build';
        }

        if (effectiveBuild) {
            log(socket, deploy_id, site_id, `🔨 Building (${effectiveBuild})...`);
            await execCmd(effectiveBuild, releaseDir, socket, deploy_id, site_id);
        }

        // Step 6: Symlink .env
        const envLink = path.join(releaseDir, '.env');
        if (!fs.existsSync(envLink)) {
            fs.symlinkSync(path.join(sharedDir, '.env'), envLink);
        }

        // Step 7: Atomic switch of `current` symlink
        log(socket, deploy_id, site_id, '🔄 Switching current symlink...');
        if (fs.existsSync(currentLink)) {
            fs.unlinkSync(currentLink);
        }
        fs.symlinkSync(releaseDir, currentLink);

        // Step 8: Generate and reload Nginx config
        log(socket, deploy_id, site_id, '🌐 Configuring Nginx...');
        const nginxConfig = generateNginxConfig({
            site_name,
            framework,
            port,
            domain: payload.domain || site_name,
            base_path: siteRoot
        });
        const tempNginxPath = path.join(releaseDir, `${site_name}.conf`);
        fs.writeFileSync(tempNginxPath, nginxConfig);

        await execCmd(`sudo mv ${tempNginxPath} /etc/nginx/sites-enabled/${site_name}.conf`, releaseDir, socket, deploy_id, site_id);
        await execCmd('sudo nginx -t && sudo systemctl reload nginx', releaseDir, socket, deploy_id, site_id);

        // Step 9: PM2 Process Management
        log(socket, deploy_id, site_id, '⚙️  Managing PM2 process...');
        const startCommand = start_cmd || getDefaultStartCmd(framework, port);

        try {
            await execCmd(`pm2 delete ${site_name}`, currentLink, socket, deploy_id, site_id);
        } catch (e) {
            // ignore if process doesn't exist
        }

        await execCmd(`PORT=${port} pm2 start "${startCommand}" --name ${site_name}`, currentLink, socket, deploy_id, site_id);
        await execCmd(`pm2 save`, currentLink, socket, deploy_id, site_id);

        // Step 10: Prune old releases
        pruneReleases(releasesDir, keep_releases || 5, socket, deploy_id, site_id);

        // Report success
        log(socket, deploy_id, site_id, '✅ Deployment successful!');
        socket.emit('deploy:status', { siteId: site_id, status: 'SUCCESS', deployId: deploy_id });
    } catch (err) {
        log(socket, deploy_id, site_id, `❌ Deploy failed: ${err.message}`, 'stderr');
        socket.emit('deploy:status', { siteId: site_id, status: 'FAILED', deployId: deploy_id });
    }
}

function getInstallCmd(releaseDir) {
    if (fs.existsSync(path.join(releaseDir, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
    if (fs.existsSync(path.join(releaseDir, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
    if (fs.existsSync(path.join(releaseDir, 'package-lock.json'))) return 'npm ci';
    return 'npm install';
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


function pruneReleases(releasesDir, keep, socket, deployId, siteId) {
    try {
        const releases = fs.readdirSync(releasesDir).sort();
        const toDelete = releases.slice(0, Math.max(0, releases.length - keep));
        for (const rel of toDelete) {
            fs.rmSync(path.join(releasesDir, rel), { recursive: true, force: true });
            log(socket, deployId, siteId, `🗑️  Pruned old release: ${rel}`);
        }
    } catch (e) {
        log(socket, deployId, siteId, `⚠️  Could not prune releases: ${e.message}`, 'stderr');
    }
}

module.exports = { execDeploy };
