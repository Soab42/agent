'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
    const secret = process.env.ENCRYPTION_KEY || '36e26527868f6eb660b55baae7dc431bbe80ee99fd20d167ccc6b47461658c81';
    const salt = process.env.AGENT_TOKEN || 'proplay-default-salt';
    return crypto.scryptSync(secret, salt, 32);
}

function encrypt(text) {
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
        iv.toString('hex'),
        tag.toString('hex'),
        encrypted.toString('hex'),
    ].join(':');
}

function decrypt(encryptedText) {
    if (!encryptedText) {
        throw new Error('Encrypted text is missing or undefined.');
    }
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted text format.');
        }
        const [ivHex, tagHex, dataHex] = parts;
        const key = getKey();
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const data = Buffer.from(dataHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        
        // Use Buffer.concat for robust decoding
        const decrypted = Buffer.concat([
            decipher.update(data),
            decipher.final()
        ]);
        return decrypted.toString('utf8');
    } catch (err) {
        console.error('Decryption failed:', err.message);
        if (err.message.includes('Unsupported state') || err.message.includes('authentication data')) {
            const currentToken = process.env.AGENT_TOKEN ? '(token set)' : '(token missing)';
            throw new Error(`Decryption failed: Authentication failed. This usually means your AGENT_TOKEN ${currentToken} or ENCRYPTION_KEY does not match what was used during encryption. Re-save your database credentials from the dashboard to refresh.`);
        }
        throw new Error(`Decryption failed: ${err.message}. Check your keys or data integrity.`);
    }
}

module.exports = { encrypt, decrypt };
