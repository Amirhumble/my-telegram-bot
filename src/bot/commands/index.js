'use strict';

/**
 * Bot command definitions registered with Telegram (menu button).
 * Admin commands are intentionally omitted from the public menu.
 */
const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Start the bot / main menu' },
  { command: 'ders_program', description: 'የደርስ ፕሮግራሞች' },
  { command: 'soft_copies', description: 'የኪታቦቹን ሶፍት ኮፒ' },
  { command: 'feedback', description: 'አስተያየት ለመስጠት' },
  { command: 'competition', description: 'Get your invitation link' },
];

module.exports = {
  PUBLIC_COMMANDS,
};
