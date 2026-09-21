'use strict';
const crypto = require('node:crypto');

const users = new Map(); // email -> { id, email, passwordHash, salt, createdAt }

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, s, 64).toString('hex');
  return { salt: s, passwordHash: derived };
}

function verifyPassword(password, salt, expectedHash) {
  const { passwordHash } = hashPassword(password, salt);
  const a = Buffer.from(passwordHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createUser(email, password) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !password) throw new Error('email_and_password_required');
  if (users.has(normalized)) throw new Error('email_already_registered');
  const { salt, passwordHash } = hashPassword(password);
  const user = { id: crypto.randomUUID(), email: normalized, salt, passwordHash, createdAt: new Date().toISOString() };
  users.set(normalized, user);
  return user;
}

function findUserByEmail(email) {
  return users.get(String(email || '').trim().toLowerCase()) || null;
}

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

module.exports = { createUser, findUserByEmail, verifyPassword, publicUser, hashPassword, users };
