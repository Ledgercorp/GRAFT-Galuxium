'use strict';
const { users } = require('./users');

function findUserById(id) {
  for (const user of users.values()) if (user.id === id) return user;
  return null;
}

module.exports = { findUserById };
