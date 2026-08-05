'use strict';

/**
 * Main reply keyboard shown to all users.
 * Labels must match handler button text exactly.
 */
const BUTTONS = {
  SOFT_COPIES: '📚 የተቀሩ ኪታቦች ሶፍት ኮፒ(ፒዲኤፍ)',
  DERS_PROGRAM: '📅 የሸይኽ ሙሀመድ አሚን የደርስ መርሀግብሮች',
  COMPETITION_LINK: '🔗 የመጋበዣ ሊንክ ለማግኘት',
  FEEDBACK: '💬 አስተያየት ለመስጠት',
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
