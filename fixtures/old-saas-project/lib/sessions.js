'use strict';
const crypto = require('node:crypto');

const COOKIE_NAME = 'sid';
const sessions = new Map(); // sid -> { userId, expiresAt }
const TTL_MS = Number(process.env.SESSION_TTL_SECONDS || 86400) * 1000;

function createSession(userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId, expiresAt: Date.now() + TTL_MS });
  return sid;
}

function getSession(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  return s;
}

function destroySession(sid) { sessions.delete(sid); }

function sessionCookie(sid) {
  return `${COOKIE_NAME}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

function clearedCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

module.exports = { COOKIE_NAME, createSession, getSession, destroySession, sessionCookie, clearedCookie, sessions };
