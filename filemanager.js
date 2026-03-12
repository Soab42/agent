'use strict';
const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB read limit
const TEXT_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt', '.env', '.sh',
    '.py', '.rb', '.php', '.html', '.htm', '.css', '.scss', '.yaml', '.yml',
    '.xml', '.toml', '.ini', '.cfg', '.conf', '.nginx', '.sql', '.log',
    '.gitignore', '.dockerignore', '.editorconfig', '.babelrc', '.prettierrc',
    '.eslintrc', '.htaccess', 'Dockerfile', 'Makefile',
]);

function isTextFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base)) return true;
    // No extension — try to read first 512 bytes and check for binary chars
    return false;
}

const os = require('os');

function safePath(inputPath) {
    // Normalize and prevent going above root weirdly
    const resolved = path.resolve(inputPath || '/');
    return resolved;
}

async function handleFileManager(task, socket) {
    const { task_id, action, payload = {} } = task;

    const respond = (data, error = null) => {
        socket.emit('fs:response', { task_id, action, data, error });
    };

    try {
        switch (action) {
            case 'FS_LIST': {
                const dir = safePath(payload.path || '/var/www');
                const isNodeModules = path.basename(dir) === 'node_modules';

                if (isNodeModules) {
                    const items = [{
                        name: 'Listing disabled for performance.md',
                        path: path.join(dir, 'Listing disabled for performance.md'),
                        isDir: false,
                        isSymlink: false,
                        size: 0,
                        mtime: new Date().toISOString(),
                        ext: '.md',
                    }];
                    respond({ path: dir, items });
                    break;
                }

                const entries = fs.readdirSync(dir, { withFileTypes: true });
                const items = entries.map(e => {
                    const fullPath = path.join(dir, e.name);
                    let size = 0;
                    let mtime = null;
                    if (e.name !== 'node_modules') {
                        try {
                            const stat = fs.statSync(fullPath);
                            size = stat.size;
                            mtime = stat.mtime.toISOString();
                        } catch {}
                    }
                    return {
                        name: e.name,
                        path: fullPath,
                        isDir: e.isDirectory(),
                        isSymlink: e.isSymbolicLink(),
                        size,
                        mtime,
                        ext: path.extname(e.name).toLowerCase(),
                    };
                });
                // Dirs first, then files
                items.sort((a, b) => {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
                respond({ path: dir, items });
                break;
            }

            case 'FS_READ': {
                const filePath = safePath(payload.path);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    respond(null, 'Path is a directory');
                    break;
                }
                if (stat.size > MAX_FILE_SIZE) {
                    respond(null, `File too large to edit (${Math.round(stat.size / 1024)}KB > 2MB)`);
                    break;
                }
                const content = fs.readFileSync(filePath, 'utf8');
                respond({ path: filePath, content, size: stat.size, mtime: stat.mtime.toISOString() });
                break;
            }

            case 'FS_WRITE': {
                const filePath = safePath(payload.path);
                // Ensure parent directory exists
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, payload.content || '', 'utf8');
                respond({ path: filePath, saved: true });
                break;
            }

            case 'FS_DELETE': {
                const targetPath = safePath(payload.path);
                fs.rmSync(targetPath, { recursive: true, force: true });
                respond({ path: targetPath, deleted: true });
                break;
            }

            case 'FS_RENAME': {
                const oldPath = safePath(payload.oldPath);
                const newPath = safePath(payload.newPath);
                fs.renameSync(oldPath, newPath);
                respond({ oldPath, newPath, renamed: true });
                break;
            }

            case 'FS_MKDIR': {
                const dirPath = safePath(payload.path);
                fs.mkdirSync(dirPath, { recursive: true });
                respond({ path: dirPath, created: true });
                break;
            }

            case 'FS_CREATE': {
                const filePath = safePath(payload.path);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                // Don't overwrite if exists
                if (!fs.existsSync(filePath)) {
                    fs.writeFileSync(filePath, '', 'utf8');
                }
                respond({ path: filePath, created: true });
                break;
            }

            default:
                respond(null, `Unknown file manager action: ${action}`);
        }
    } catch (err) {
        socket.emit('fs:response', { task_id, action, data: null, error: err.message });
    }
}

module.exports = { handleFileManager };
