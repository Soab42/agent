'use strict';

const fs = require('fs');
const path = require('path');

const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

function generateNginxConfig({ site_name, framework, port, domain, base_path, redirects = [] }) {
    let config;
    let redirectRules = '';

    if (redirects && redirects.length > 0) {
        redirects.forEach(r => {
            const typeStr = r.type === 301 ? 'permanent' : 'redirect';
            // Simple validation: ensure from starts with / or is ^
            let from = r.from;
            if (!from.startsWith('/') && !from.startsWith('^') && !from.startsWith('~')) {
                from = '/' + from;
            }
            redirectRules += `    rewrite ${from} ${r.to} ${typeStr};\n`;
        });
    }

    if (framework === 'REACT_SPA') {
        const rootPath = base_path ? path.join(base_path, 'current/dist') : `/var/www/${site_name}/current/dist`;
        config = `server {
    listen 80;
    server_name ${domain || '_'};

    access_log /var/log/nginx/${site_name}.access.log;
    error_log /var/log/nginx/${site_name}.error.log;

    root ${rootPath};
    index index.html;

${redirectRules}
    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
`;
    } else {
        config = `server {
    listen 80;
    server_name ${domain || '_'};

    access_log /var/log/nginx/${site_name}.access.log;
    error_log /var/log/nginx/${site_name}.error.log;

${redirectRules}
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
`;
    }

    return config;
}

module.exports = { generateNginxConfig };
