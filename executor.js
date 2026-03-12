'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateNginxConfig } = require('./nginx');

const SITES_ROOT = process.env.SITES_ROOT || '/var/www';

function hasCommand(cmd) {
    try {
        execSync(`command -v ${cmd} > /dev/null 2>&1`);
        return true;
    } catch (e) {
        return false;
    }
}

function log(socket, deployId, siteId, message, stream = 'stdout') {
    console.log(`[${stream}] ${message}`);
    socket.emit('deploy:log', { deployId, siteId, message, stream });
}

async function execCmd(cmd, cwd, pushLog, socket, deployId, siteId) {
    return new Promise((resolve, reject) => {
        pushLog(`$ ${cmd}`);
        const parts = cmd.split(' ');
        const proc = spawn(parts[0], parts.slice(1), { cwd, shell: true, env: { ...process.env } });
        proc.stdout.on('data', d => pushLog(d.toString().trimEnd(), 'stdout'));
        proc.stderr.on('data', d => pushLog(d.toString().trimEnd(), 'stderr'));
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
        build_cmd, start_cmd, port, release_id, keep_releases, env, base_path,
        startArgs, pm2Restart = true, pm2Instances = '1'
    } = payload;
    
    // Track duration and logs
    const startTime = Date.now();
    const deploymentLogs = [];
    const pushLog = (msg, stream = 'stdout') => {
        deploymentLogs.push(`[${stream}] ${msg}`);
        log(socket, deploy_id, site_id, msg, stream);
    };

    const siteRoot = base_path || path.join(SITES_ROOT, site_name);
    const releasesDir = path.join(siteRoot, 'releases');
    const sharedDir = path.join(siteRoot, 'shared');
    const releaseDir = path.join(releasesDir, release_id);
    const currentLink = path.join(siteRoot, 'current');

    try {
        // Step 1: Ensure directories exist
        pushLog('📁 Preparing release directory...');
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.mkdirSync(path.join(sharedDir, 'logs'), { recursive: true });

        // Step 2: Write .env to shared (only provision it if it doesn't exist)
        const dotEnvPath = path.join(sharedDir, '.env');
        if (!fs.existsSync(dotEnvPath)) {
            const envContent = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
            fs.writeFileSync(dotEnvPath, envContent, { mode: 0o600 });
        }
        
        if (payload.deploy_script) {
            pushLog('🏃 Executing custom deploy script...');
            const scriptPath = path.join(siteRoot, 'deploy.sh');
            fs.writeFileSync(scriptPath, payload.deploy_script, { mode: 0o755 });
            await execCmd('bash deploy.sh', siteRoot, pushLog, socket, deploy_id, site_id);
            
            // Re-generate Nginx config just in case
            pushLog('🌐 Configuring Nginx...');
            const nginxConfig = generateNginxConfig({
                site_name,
                framework,
                port,
                domain: payload.domain || site_name,
                base_path: siteRoot
            });
            const tempNginxPath = path.join(siteRoot, `${site_name}.conf`);
            fs.writeFileSync(tempNginxPath, nginxConfig);

            await execCmd(`sudo mv ${tempNginxPath} /etc/nginx/sites-enabled/${site_name}.conf`, siteRoot, pushLog, socket, deploy_id, site_id);
            await execCmd('sudo nginx -t && sudo systemctl reload nginx', siteRoot, pushLog, socket, deploy_id, site_id);

            // Get commit metadata if available
            let commitSha = null, commitAuthor = null, commitMessage = null;
            try {
                const gitOutput = execSync('git log -1 --pretty=format:\'%H|%an|%s\' 2>/dev/null', { cwd: fs.existsSync(releaseDir) ? releaseDir : siteRoot }).toString().trim();
                const parts = gitOutput.split('|');
                if (parts.length >= 3) {
                    commitSha = parts[0];
                    commitAuthor = parts[1];
                    commitMessage = parts.slice(2).join('|');
                } else {
                    commitSha = execSync('git rev-parse HEAD 2>/dev/null', { cwd: fs.existsSync(releaseDir) ? releaseDir : siteRoot }).toString().trim();
                }
            } catch(e) {
                // Ignore git errors if directory isn't a repo
            }

            pushLog('✅ Deployment successful!');
            socket.emit('deploy:status', { siteId: site_id, status: 'SUCCESS', deployId: deploy_id, duration: Math.round((Date.now() - startTime) / 1000), logs: deploymentLogs.join('\n'), commitSha, commitAuthor, commitMessage });
            return;
        }

        // Step 3: Git clone
        pushLog(`🔗 Cloning ${repo_url} (${branch})...`);
        await execCmd(`git clone --depth=1 --branch ${branch} ${repo_url} .`, releaseDir, pushLog, socket, deploy_id, site_id);

        // Step 4: Intelligent Install
        const { cmd: installCmd, type: pkgManager } = getInstallCmd(releaseDir);
        pushLog(`📦 Installing dependencies (${installCmd})...`);
        await execCmd(installCmd, releaseDir, pushLog, socket, deploy_id, site_id);

        // Step 5: Build
        const defaultBuildCmd = ['NEXTJS', 'NESTJS', 'REACT_SPA'].includes(framework)
            ? (pkgManager === 'pnpm' ? 'pnpm build' : 'npm run build')
            : null;
        let effectiveBuild = build_cmd || defaultBuildCmd;

        if (effectiveBuild) {
            pushLog(`🔨 Building (${effectiveBuild})...`);
            await execCmd(effectiveBuild, releaseDir, pushLog, socket, deploy_id, site_id);
        }

        // Step 6: Symlink .env
        const envLink = path.join(releaseDir, '.env');
        if (!fs.existsSync(envLink)) {
            fs.symlinkSync(path.join(sharedDir, '.env'), envLink);
        }

        // Step 7: Atomic switch of `current` symlink
        pushLog('🔄 Switching current symlink...');
        if (fs.existsSync(currentLink)) {
            fs.unlinkSync(currentLink);
        }
        fs.symlinkSync(releaseDir, currentLink);

        // Step 8: Generate and reload Nginx config
        pushLog('🌐 Configuring Nginx...');
        const nginxConfig = generateNginxConfig({
            site_name,
            framework,
            port,
            domain: payload.domain || site_name,
            base_path: siteRoot
        });
        const tempNginxPath = path.join(releaseDir, `${site_name}.conf`);
        fs.writeFileSync(tempNginxPath, nginxConfig);

        await execCmd(`sudo mv ${tempNginxPath} /etc/nginx/sites-enabled/${site_name}.conf`, releaseDir, pushLog, socket, deploy_id, site_id);
        await execCmd('sudo nginx -t && sudo systemctl reload nginx', releaseDir, pushLog, socket, deploy_id, site_id);

        // Step 9: PM2 Process Management
        pushLog('⚙️  Managing PM2 process...');
        if (!pm2Restart) {
            pushLog('⏩ Skipping PM2 restart as per settings.');
        } else {
            const startCommand = start_cmd || getDefaultStartCmd(framework, port, pkgManager);
            
            try {
                await execCmd(`pm2 delete ${site_id}`, currentLink, pushLog, socket, deploy_id, site_id);
            } catch (e) {
                // ignore if process doesn't exist
            }

            const instancesFlag = pm2Instances === 'max' ? '-i max' : `-i ${pm2Instances}`;
            const argsSuffix = startArgs ? ` -- ${startArgs}` : '';
            await execCmd(`PORT=${port} pm2 start "${startCommand}" --name ${site_id} ${instancesFlag}${argsSuffix}`, currentLink, pushLog, socket, deploy_id, site_id);
            await execCmd(`pm2 save`, currentLink, pushLog, socket, deploy_id, site_id);
        }

        // Step 10: Prune old releases
        pruneReleases(releasesDir, keep_releases || 5, pushLog);

        // Get commit metadata if available
        let commitSha = null, commitAuthor = null, commitMessage = null;
        try {
            const gitOutput = execSync('git log -1 --pretty=format:\'%H|%an|%s\' 2>/dev/null', { cwd: fs.existsSync(releaseDir) ? releaseDir : siteRoot }).toString().trim();
            const parts = gitOutput.split('|');
            if (parts.length >= 3) {
                commitSha = parts[0];
                commitAuthor = parts[1];
                commitMessage = parts.slice(2).join('|');
            } else {
                commitSha = execSync('git rev-parse HEAD 2>/dev/null', { cwd: fs.existsSync(releaseDir) ? releaseDir : siteRoot }).toString().trim();
            }
        } catch(e) {
            // Ignore git errors if directory isn't a repo
        }

        // Report success
        pushLog('✅ Deployment successful!');
        socket.emit('deploy:status', { siteId: site_id, status: 'SUCCESS', deployId: deploy_id, duration: Math.round((Date.now() - startTime) / 1000), logs: deploymentLogs.join('\n'), commitSha, commitAuthor, commitMessage });
    } catch (err) {
        pushLog(`❌ Deploy failed: ${err.message}`, 'stderr');
        
        // Attempt to extract commit data even on failure
        let commitSha = null, commitAuthor = null, commitMessage = null;
        try {
            const gitOutput = execSync('git log -1 --pretty=format:\'%H|%an|%s\' 2>/dev/null', { cwd: fs.existsSync(releaseDir) ? releaseDir : siteRoot }).toString().trim();
            const parts = gitOutput.split('|');
            if (parts.length >= 3) {
                commitSha = parts[0];
                commitAuthor = parts[1];
                commitMessage = parts.slice(2).join('|');
            }
        } catch(e) {}

        socket.emit('deploy:status', { siteId: site_id, status: 'FAILED', deployId: deploy_id, duration: Math.round((Date.now() - startTime) / 1000), logs: deploymentLogs.join('\n'), failedStep: String(err.message).slice(0, 250), commitSha, commitAuthor, commitMessage });
    }
}

function getInstallCmd(releaseDir) {
    const pnpmExists = hasCommand('pnpm');
    const yarnExists = hasCommand('yarn');

    if (fs.existsSync(path.join(releaseDir, 'pnpm-lock.yaml')) && pnpmExists) {
        return { cmd: 'pnpm install --frozen-lockfile', type: 'pnpm' };
    }
    if (fs.existsSync(path.join(releaseDir, 'yarn.lock')) && yarnExists) {
        return { cmd: 'yarn install --frozen-lockfile', type: 'yarn' };
    }
    if (fs.existsSync(path.join(releaseDir, 'package-lock.json'))) {
        return { cmd: 'npm ci', type: 'npm' };
    }

    // Fallback logic
    if (pnpmExists) return { cmd: 'pnpm install', type: 'pnpm' };
    return { cmd: 'npm install', type: 'npm' };
}

function getDefaultStartCmd(framework, port, pkgManager) {
    switch (framework) {
        case 'NEXTJS': return `node node_modules/next/dist/bin/next start -p ${port}`;
        case 'NESTJS': return `node dist/main.js`;
        case 'EXPRESS': return `node dist/server.js`;
        case 'REACT_SPA': return null; // static, no process needed
        default: return pkgManager === 'pnpm' ? 'pnpm start' : 'npm start';
    }
}


function pruneReleases(releasesDir, keep, pushLog) {
    try {
        const releases = fs.readdirSync(releasesDir).sort();
        const toDelete = releases.slice(0, Math.max(0, releases.length - keep));
        for (const rel of toDelete) {
            fs.rmSync(path.join(releasesDir, rel), { recursive: true, force: true });
            pushLog(`🗑️  Pruned old release: ${rel}`);
        }
    } catch (e) {
        pushLog(`⚠️  Could not prune releases: ${e.message}`, 'stderr');
    }
}

module.exports = { execDeploy };
