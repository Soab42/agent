'use strict';

const fs = require('fs');
const path = require('path');

const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

function generateNginxConfig({ site_name, framework, port, domain, base_path, root_folder, ssl_enabled, redirects = [] }) {
    let redirectRules = '';

    if (redirects && redirects.length > 0) {
        redirects.forEach(r => {
            const typeStr = r.type === 301 ? 'permanent' : 'redirect';
            let from = r.from;
            if (!from.startsWith('/') && !from.startsWith('^') && !from.startsWith('~')) {
                from = '/' + from;
            }
            redirectRules += `    rewrite ${from} ${r.to} ${typeStr};\n`;
        });
    }

    const sslConfig = ssl_enabled ? `
    listen 443 ssl http2;
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
` : '    listen 80;';

    const httpRedirect = ssl_enabled ? `
server {
    listen 80;
    server_name ${domain || '_'};
    return 301 https://$host$request_uri;
}
` : '';

    let mainConfig;
    if (framework === 'REACT_SPA') {
        const distFolder = root_folder ? path.join('current', root_folder, 'dist') : 'current/dist';
        const rootPath = base_path ? path.join(base_path, distFolder) : `/var/www/${site_name}/${distFolder}`;
        mainConfig = `server {
${sslConfig}
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
        mainConfig = `server {
${sslConfig}
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

    return httpRedirect + mainConfig;
}

module.exports = { generateNginxConfig };
