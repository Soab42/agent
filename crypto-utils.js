'use strict';
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
    const secret = process.env.ENCRYPTION_KEY || '32-char-encryption-key-change-me!!';
    return crypto.scryptSync(secret, 'salt', 32);
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
    try {
        const [ivHex, tagHex, dataHex] = encryptedText.split(':');
        const key = getKey();
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const data = Buffer.from(dataHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        console.error('Decryption failed:', err.message);
        throw new Error('Failed to decrypt data. Check your ENCRYPTION_KEY.');
    }
}

module.exports = { encrypt, decrypt };
