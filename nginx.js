'use strict';

const fs = require('fs');
const path = require('path');

const NGINX_CONF_DIR = process.env.NGINX_CONF_DIR || '/etc/nginx/sites-enabled';

function generateNginxConfig({ site_name, framework, port, domain }) {
    let config;

    if (framework === 'REACT_SPA') {
        // Static file serving with SPA fallback
        config = `server {
    listen 80;
    server_name ${domain || '_'};

    access_log /var/log/nginx/${site_name}.access.log;
    error_log /var/log/nginx/${site_name}.error.log;

    root /var/www/${site_name}/current/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
`;
    } else {
        // Reverse proxy for Node apps (Next.js, Express, NestJS)
        config = `server {
    listen 80;
    server_name ${domain || '_'};

    access_log /var/log/nginx/${site_name}.access.log;
    error_log /var/log/nginx/${site_name}.error.log;

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

    const confPath = path.join(NGINX_CONF_DIR, `${site_name}.conf`);
    fs.writeFileSync(confPath, config, 'utf8');
    console.log(`✅ Nginx config written: ${confPath}`);
    return confPath;
}

module.exports = { generateNginxConfig };
