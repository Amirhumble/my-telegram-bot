'use strict';

/**
 * Main reply keyboard shown to all users.
 * Labels must match handler button text exactly.
 */
const BUTTONS = {
  SOFT_COPIES: '📚 Soft Copies',
  DERS_PROGRAM: '📅 Ders Program',
  COMPETITION_LINK: '🔗 Competition Link',
  FEEDBACK: '💬 Feedback',
};

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: BUTTONS.SOFT_COPIES }, { text: BUTTONS.DERS_PROGRAM }],
      [{ text: BUTTONS.COMPETITION_LINK }, { text: BUTTONS.FEEDBACK }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

module.exports = {
  BUTTONS,
  mainMenuKeyboard,
};
