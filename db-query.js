'use strict';
const { loadCreds } = require('./db-creds-manager');
const { decrypt } = require('./crypto-utils');

let pgClient;
let mysql;

try {
    pgClient = require('pg').Client;
    mysql = require('mysql2/promise');
} catch (err) {
    console.warn('Database drivers (pg, mysql2) not found. Database queries may fail.');
}

async function executePgQuery(host, port, database, user, password, query) {
    if (!pgClient) throw new Error('Postgres driver (pg) not installed on agent');
    
    const client = new pgClient({ host, port, database, user, password });
    await client.connect();
    try {
        const res = await client.query(query);
        return res.rows;
    } finally {
        await client.end();
    }
}

async function executeMysqlQuery(host, port, database, user, password, query) {
    if (!mysql) throw new Error('MySQL driver (mysql2) not installed on agent');

    const connection = await mysql.createConnection({ host, port, database, user, password });
    try {
        const [rows] = await connection.execute(query);
        return rows;
    } finally {
        await connection.end();
    }
}

async function handleDbQuery(task, socket) {
    const { task_id, action, payload = {} } = task;

    const respond = (data, error = null) => {
        socket.emit('db:query_response', { task_id, action, data, error });
    };

    try {
        const { credentialId, query, queryOverride } = payload;
        const creds = loadCreds();
        const cred = creds.find(c => c.id === credentialId);

        if (!cred) {
            return respond(null, 'Credential not found on this server');
        }

        const password = decrypt(cred.passwordEnc);
        const { dbName, username } = cred;
        
        // Host and engine are passed in payload because they aren't sensitive but needed for connection
        const { host, port, engine } = payload;

        const result = await (engine === 'postgres'
            ? executePgQuery(host, port, dbName, username, password, queryOverride || query)
            : executeMysqlQuery(host, port, dbName, username, password, queryOverride || query));

        respond(result);
    } catch (err) {
        respond(null, err.message);
    }
}

module.exports = { handleDbQuery };
