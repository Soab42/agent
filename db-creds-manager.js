'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { encrypt, decrypt } = require('./crypto-utils'); // I'll need to extract crypto logic

function getProplayDir() {
    if (process.env.PROPLAY_DIR) return process.env.PROPLAY_DIR;
    
    const homeBase = '/home';
    const pathsToCheck = [];

    // If running as root, check all /home/ subdirectories
    if (process.getuid && process.getuid() === 0 && fs.existsSync(homeBase)) {
        try {
            const users = fs.readdirSync(homeBase);
            for (const user of users) {
                pathsToCheck.push(path.join(homeBase, user, '.proplay'));
            }
        } catch (err) {
            console.error('Failed to scan /home for .proplay:', err.message);
        }
    }

    // Always include the current user's home fallback
    pathsToCheck.push(path.join(os.homedir(), '.proplay'));

    for (const p of pathsToCheck) {
        if (fs.existsSync(p)) {
            console.log('Using Proplay directory:', p);
            return p;
        }
    }

    return pathsToCheck[pathsToCheck.length - 1]; // Fallback to current user's home
}

const CREDS_DIR = getProplayDir();
const CREDS_FILE = path.join(CREDS_DIR, 'db_credentials.json');

function ensureDir() {
    console.log(CREDS_DIR, CREDS_FILE);
    if (!fs.existsSync(CREDS_DIR)) {
        fs.mkdirSync(CREDS_DIR, { recursive: true });
    }
}

function loadCreds() {
    ensureDir();
    if (!fs.existsSync(CREDS_FILE)) {
        return [];
    }
    try {
        const content = fs.readFileSync(CREDS_FILE, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error('Failed to load credentials file:', err.message);
        return [];
    }
}

function saveCreds(creds) {
    ensureDir();
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), 'utf8');
}

async function handleDbCreds(task, socket) {
    const { task_id, action, payload = {} } = task;

    const respond = (data, error = null) => {
        socket.emit('db:creds_response', { task_id, action, data, error });
    };

    try {
        switch (action) {
            case 'DB_CREDS_LIST': {
                const creds = loadCreds();
                // Strip passwords for listing if needed, but here we just send metadata
                const list = creds.map(c => ({
                    id: c.id,
                    dbName: c.dbName,
                    username: c.username,
                    siteId: c.siteId,
                    dbInstanceId: c.dbInstanceId,
                    createdAt: c.createdAt
                }));
                respond(list);
                break;
            }

            case 'DB_CREDS_SAVE': {
                const creds = loadCreds();
                const id = payload.id || require('crypto').randomUUID();
                const existingIndex = creds.findIndex(c => c.id === id);

                const updateData = {
                    id,
                    dbName: payload.dbName,
                    username: payload.username,
                    siteId: payload.siteId,
                    dbInstanceId: payload.dbInstanceId,
                };

                if (payload.passwordEnc) {
                    updateData.passwordEnc = payload.passwordEnc;
                }

                if (existingIndex > -1) {
                    creds[existingIndex] = { ...creds[existingIndex], ...updateData };
                } else {
                    const newCred = {
                        ...updateData,
                        createdAt: new Date().toISOString()
                    };
                    creds.push(newCred);
                }

                saveCreds(creds);
                respond({ id, saved: true });
                break;
            }

            case 'DB_CREDS_DELETE': {
                let creds = loadCreds();
                creds = creds.filter(c => c.id !== payload.id);
                saveCreds(creds);
                respond({ id: payload.id, deleted: true });
                break;
            }

            case 'DB_CREDS_GET': {
                const creds = loadCreds();
                const cred = creds.find(c => c.id === payload.id);
                if (!cred) {
                    respond(null, 'Credential not found');
                } else {
                    respond(cred);
                }
                break;
            }

            default:
                respond(null, `Unknown database credentials action: ${action}`);
        }
    } catch (err) {
        respond(null, err.message);
    }
}

module.exports = { handleDbCreds, loadCreds };
