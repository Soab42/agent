'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function startOrRestartPM2(payload, pushLog) {
    const { site_id, site_name, framework, port, start_cmd, start_args, pm2_instances, project_dir } = payload;
    
    pushLog(`⚙️  Managing PM2 process: ${site_id} (${site_name})...`);

    // Helper for PM2 default start command
    const getDefaultStartCmd = (fw, p, pkg) => {
        if (fw === 'NODEJS') return 'npm start';
        if (fw === 'NESTJS') return 'node dist/main';
        if (fw === 'NEXTJS') return 'npm run start';
        if (fw === 'REACT_SPA') return `serve -s . -l ${p}`;
        return 'npm start';
    };

    // Determine package manager for defaults
    const pkgManager = 'npm'; // We could detect this from project_dir if needed

    const startCommand = start_cmd || getDefaultStartCmd(framework, port, pkgManager);
    
    try {
        pushLog(`$ pm2 delete ${site_id}`);
        await execAsync(`pm2 delete ${site_id}`, { cwd: project_dir });
    } catch (e) {
        // ignore if process doesn't exist
    }

    // New naming convention: domain-port (fallback to site_id if site_name is missing)
    const pmName = site_name ? `${site_name}-${port}` : site_id;

    try {
        pushLog(`$ pm2 delete ${pmName}`);
        await execAsync(`pm2 delete ${pmName}`, { cwd: project_dir });
    } catch (e) {
        // ignore if process doesn't exist
    }

    const instancesFlag = pm2_instances === 'max' ? '-i max' : `-i ${pm2_instances || '1'}`;
    const argsSuffix = start_args ? ` -- ${start_args}` : '';
    const fullCmd = `PORT=${port} pm2 start "${startCommand}" --name ${pmName} ${instancesFlag}${argsSuffix}`;
    
    pushLog(`$ ${fullCmd}`);
    await execAsync(fullCmd, { cwd: project_dir });
    
    pushLog(`$ pm2 save`);
    await execAsync(`pm2 save`);
}

module.exports = { startOrRestartPM2 };
