'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { generateNginxConfig } = require('./nginx');

const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

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

async function execCmd(cmd, cwd, pushLog, socket, deployId, siteId, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        pushLog(`$ ${cmd}`);
        const parts = cmd.split(' ');
        const proc = spawn(parts[0], parts.slice(1), { 
            cwd, 
            shell: true, 
            env: { ...process.env, ...extraEnv } 
        });
        proc.stdout.on('data', d => pushLog(d.toString().trimEnd(), 'stdout'));
        proc.stderr.on('data', d => pushLog(d.toString().trimEnd(), 'stderr'));
        proc.on('close', code => {
            if (code !== 0) reject(new Error(`Command failed with exit code ${code}: ${cmd}`));
            else resolve();
        });
    });
}

function forceSymlink(target, linkPath, pushLog) {
    if (pushLog) pushLog(`🔗 Creating symlink: ${linkPath} -> ${target}`);
    try {
        // Aggressive removal: try fs.rmSync first
        fs.rmSync(linkPath, { recursive: true, force: true });
        
        // Double check with lstat and unlink if it still exists (handles some edge cases on networked filesystems)
        try {
            if (fs.lstatSync(linkPath).isSymbolicLink()) {
                fs.unlinkSync(linkPath);
            }
        } catch (e) {}
    } catch (e) {
        if (pushLog) pushLog(`⚠️ Warning during symlink cleanup: ${e.message}`, 'stderr');
    }
    
    try {
        fs.symlinkSync(target, linkPath);
    } catch (err) {
        if (err.code === 'EEXIST') {
            if (pushLog) pushLog(`🚨 EEXIST error persisting at ${linkPath}. Attempting shell override...`, 'stderr');
            try {
                execSync(`rm -rf "${linkPath}"`);
                fs.symlinkSync(target, linkPath);
            } catch (finalErr) {
                throw new Error(`Failed to create symlink at ${linkPath} even after forced removal: ${finalErr.message}`);
            }
        } else {
            throw err;
        }
    }
}

/**
 * Embed a GitHub token into an HTTPS clone URL so git can authenticate
 * without a TTY prompt. Only modifies github.com HTTPS URLs.
 * Example: https://github.com/user/repo → https://<token>@github.com/user/repo
 */
function buildCloneUrl(repoUrl, githubToken) {
    if (!githubToken) return repoUrl;
    try {
        const url = new URL(repoUrl);
        if (url.hostname === 'github.com' && url.protocol === 'https:') {
            url.username = githubToken;
            url.password = '';
            return url.toString();
        }
    } catch (e) {
        // Not a valid URL (e.g. SSH), return as-is
    }
    return repoUrl;
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

    pushLog(`👤 Running as user: ${require('os').userInfo().username}`);
    pushLog(`📂 Working directory: ${process.cwd()}`);

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

        // If previous releases exist, copy the contents of the latest one
        // This ensures the custom script starts with the previous state (git, node_modules, etc.)
        const previousReleases = fs.readdirSync(releasesDir)
            .filter(f => fs.statSync(path.join(releasesDir, f)).isDirectory() && f !== release_id)
            .sort()
            .reverse();

        if (previousReleases.length > 0) {
            const lastReleaseDir = path.join(releasesDir, previousReleases[0]);
            pushLog(`📦 Restoring state from previous release: ${previousReleases[0]}...`);
            try {
                // Using cp -a to preserve permissions, symlinks, and hidden files (.)
                execSync(`cp -a ${lastReleaseDir}/. ${releaseDir}/`);
                pushLog('✅ State restored.');
            } catch (e) {
                pushLog(`⚠️ Could not restore state: ${e.message}`, 'stderr');
            }
        }

        // Step 2: Write .env to shared (only provision it if it doesn't exist)
        const dotEnvPath = path.join(sharedDir, '.env');
        if (!fs.existsSync(dotEnvPath)) {
            const envContent = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
            fs.writeFileSync(dotEnvPath, envContent, { mode: 0o600 });
        }
        
        if (payload.deploy_script) {
            pushLog('🏃 Executing custom deploy script...');

            // If the folder is empty (e.g. first deploy or copy failed), clone the repo
            const isEmpty = fs.readdirSync(releaseDir).length === 0;
            if (isEmpty && payload.repo_url) {
                pushLog(`🔗 Directory is empty. Initializing repository: ${payload.repo_url} (${payload.branch})...`);
                if (!fs.existsSync(siteRoot)) fs.mkdirSync(siteRoot, { recursive: true });
                const cloneUrl = buildCloneUrl(payload.repo_url, payload.github_token);
                await execCmd(`git clone --depth=1 --branch ${payload.branch} ${cloneUrl} .`, releaseDir, pushLog, socket, deploy_id, site_id);
            }

            const shellCmd = process.platform === 'win32' ? 'cmd /c deploy.bat' : 'bash deploy.sh';
            const scriptName = process.platform === 'win32' ? 'deploy.bat' : 'deploy.sh';
            const scriptPath = path.join(releaseDir, scriptName);
            fs.writeFileSync(scriptPath, payload.deploy_script, { mode: 0o755 });
            
            const deployEnv = {
                PROPLAY_RELEASE_ID: release_id,
                PROPLAY_RELEASE_DIR: releaseDir,
                PROPLAY_SITE_ROOT: siteRoot,
                PROPLAY_SHARED_DIR: sharedDir,
                PROPLAY_CURRENT_LINK: currentLink,
                PROPLAY_SITE_NAME: site_name,
                PROPLAY_DOMAIN: payload.domain || site_name,
            };

            await execCmd(shellCmd, releaseDir, pushLog, socket, deploy_id, site_id, deployEnv);
        } else {
            // Step 3: Git clone
            pushLog(`🔗 Cloning ${repo_url} (${branch})...`);
            const cloneUrl = buildCloneUrl(repo_url, payload.github_token);
            await execCmd(`git clone --depth=1 --branch ${branch} ${cloneUrl} .`, releaseDir, pushLog, socket, deploy_id, site_id);

            const projectDir = payload.root_folder ? path.join(releaseDir, payload.root_folder) : releaseDir;
            if (payload.root_folder) {
                pushLog(`📂 Project directory set to subfolder: ${payload.root_folder}`);
                if (!fs.existsSync(projectDir)) {
                    throw new Error(`Root folder "${payload.root_folder}" not found in repository`);
                }
            }

            // Step 4: Intelligent Install
            const { cmd: installCmd, type: pkgManager } = getInstallCmd(projectDir);
            pushLog(`📦 Installing dependencies (${installCmd})...`);
            await execCmd(installCmd, projectDir, pushLog, socket, deploy_id, site_id);

            // Step 5: Build
            const defaultBuildCmd = ['NEXTJS', 'NESTJS', 'REACT_SPA'].includes(framework)
                ? (pkgManager === 'pnpm' ? 'pnpm build' : 'npm run build')
                : null;
            let effectiveBuild = build_cmd || defaultBuildCmd;

            if (effectiveBuild) {
                pushLog(`🔨 Building (${effectiveBuild})...`);
                await execCmd(effectiveBuild, projectDir, pushLog, socket, deploy_id, site_id);
            }

            // Step 6: Symlink .env
            const envLink = path.join(projectDir, '.env');
            forceSymlink(path.join(sharedDir, '.env'), envLink, pushLog);
        }

        // --- Unified Finalization Flow ---
        const projectDirForFinal = payload.root_folder ? path.join(releaseDir, payload.root_folder) : releaseDir;

        // Step 7: Atomic switch of `current` symlink
        pushLog('🔄 Switching current symlink...');
        forceSymlink(releaseDir, currentLink, pushLog);

        const activeProjectDir = payload.root_folder ? path.join(currentLink, payload.root_folder) : currentLink;

        // Step 8: Generate and reload Nginx config (only if it doesn't exist)
        pushLog('🌐 Checking Nginx configuration...');
        const finalNginxPath = path.join(NGINX_CONF_DIR, `${site_name}.conf`);
        if (fs.existsSync(finalNginxPath)) {
            pushLog(`⏩ Nginx configuration already exists at ${finalNginxPath}. Skipping overwrite.`);
        } else {
            pushLog('✨ Generating new Nginx configuration...');
            const nginxConfig = generateNginxConfig({
                site_name,
                framework,
                port,
                domain: payload.domain || site_name,
                base_path: siteRoot,
                root_folder: payload.root_folder,
                ssl_enabled: payload.ssl_enabled
            });
            const tempNginxPath = path.join(releaseDir, `${site_name}.conf`);
            fs.writeFileSync(tempNginxPath, nginxConfig);

            await execCmd(`sudo mv ${tempNginxPath} ${finalNginxPath}`, releaseDir, pushLog, socket, deploy_id, site_id);
            await execCmd('sudo nginx -t && sudo systemctl reload nginx', releaseDir, pushLog, socket, deploy_id, site_id);
        }

        // Step 9: PM2 Process Management
        pushLog('⚙️  Managing PM2 process...');
        if (!pm2Restart) {
            pushLog('⏩ Skipping PM2 restart as per settings.');
        } else {
            const { startOrRestartPM2 } = require('./pm2-manager');
            await startOrRestartPM2({
                site_id,
                site_name,
                framework,
                port,
                start_cmd: start_cmd,
                start_args: startArgs,
                pm2_instances: pm2Instances,
                project_dir: activeProjectDir
            }, pushLog);
        }

        // Step 10: Prune old releases
        pruneReleases(releasesDir, keep_releases || 5, pushLog);

        // Get commit metadata if available
        let commitSha = null, commitAuthor = null, commitMessage = null;
        try {
            const gitOutput = execSync('git log -1 --pretty=format:\'%H|%an|%s\' 2>/dev/null', { cwd: projectDirForFinal }).toString().trim();
            const parts = gitOutput.split('|');
            if (parts.length >= 3) {
                commitSha = parts[0];
                commitAuthor = parts[1];
                commitMessage = parts.slice(2).join('|');
            } else {
                commitSha = execSync('git rev-parse HEAD 2>/dev/null', { cwd: projectDirForFinal }).toString().trim();
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
