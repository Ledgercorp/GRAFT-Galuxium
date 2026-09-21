'use strict';
const { json } = require('../lib/router');
const { createUser, findUserByEmail, verifyPassword, publicUser } = require('../lib/users');
const { COOKIE_NAME, createSession, getSession, destroySession, sessionCookie, clearedCookie } = require('../lib/sessions');
const { findUserById } = require('../lib/lookup');

// Server-side authorization guard. Every protected route must go through this.
function requireAuth(handler) {
  return function (req, res) {
    const sid = req.cookies[COOKIE_NAME];
    const session = sid ? getSession(sid) : null;
    if (!session) return json(res, 401, { error: 'unauthenticated' });
    req.session = session;
    req.user = findUserById(session.userId);
    if (!req.user) return json(res, 401, { error: 'unauthenticated' });
    return handler(req, res);
  };
}

function register(router) {
  router.add('POST', '/auth/register', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return json(res, 400, { error: 'email_and_password_required' });
    if (String(password).length < 8) return json(res, 400, { error: 'password_too_short' });
    let user;
    try { user = createUser(email, password); }
    catch (err) { return json(res, 409, { error: String(err.message) }); }
    const sid = createSession(user.id);
    return json(res, 201, { user: publicUser(user) }, { 'set-cookie': sessionCookie(sid) });
  });

  router.add('POST', '/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(String(password || ''), user.salt, user.passwordHash)) {
      return json(res, 401, { error: 'invalid_credentials' });
    }
    const sid = createSession(user.id);
    return json(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(sid) });
  });

  router.add('POST', '/auth/logout', (req, res) => {
    const sid = req.cookies[COOKIE_NAME];
    if (sid) destroySession(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': clearedCookie() });
  });

  router.add('GET', '/auth/me', requireAuth((req, res) => json(res, 200, { user: publicUser(req.user) })));

  // Example protected business route guarded by the same middleware.
  router.add('GET', '/account', requireAuth((req, res) => json(res, 200, { accountFor: req.user.email })));
}

module.exports = register;
module.exports.requireAuth = requireAuth;
