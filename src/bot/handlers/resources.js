'use strict';

const resourcesService = require('../../services/resources');
const usersService = require('../../services/users');

async function ensureUser(message) {
  const from = message.from || {};
  await usersService.upsertUser({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
  });
}

async function handleSoftCopies(message) {
  await ensureUser(message);
  await resourcesService.sendSoftCopies(message.chat.id);
}

async function handleDersProgram(message) {
  await ensureUser(message);
  await resourcesService.sendDersProgram(message.chat.id);
}

module.exports = {
  handleSoftCopies,
  handleDersProgram,
};
