require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot/index');
const { setupWeb } = require('./web/index');
const pool = require('./db/pool');

const PORT = process.env.PORT || 8080;

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('DB ok');
  } catch (err) {
    console.error('DB error:', err.message);
    process.exit(1);
  }

  const app = express();

  setupWeb(app);

  app.listen(PORT, '0.0.0.0', function() {
    console.log('Server on port ' + PORT);
  });

  const bot = setupBot();
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  bot.launch({}, () => {
    console.log('Bot started polling');
    // Serial, rate-limited maintenance must never delay incoming updates.
    Promise.resolve().then(() => require('./bot/staff-menu').getStaffMenu(bot).syncApproved()).then(counts => {
      console.log('Staff menus checked:', counts.updated, 'updated,', counts.skipped, 'skipped,', counts.failed, 'failed');
    }).catch(() => console.error('Staff menu sync unavailable'));
    Promise.resolve().then(() => require('./bot/case-card-sync').createCaseCardSync({pool,telegram:bot.telegram})()).then(counts => {
      console.log('Client report buttons checked:', counts.updated, 'updated,', counts.unchanged, 'unchanged,', counts.skipped, 'skipped,', counts.failed, 'failed');
    }).catch(() => console.error('Client report button sync unavailable'));
  }).catch(error => {
    console.error('Bot polling stopped:', error.code || error.response?.error_code || error.name || 'error');
    process.exit(1);
  });

  process.once('SIGINT', function() {
    try { bot.stop('SIGINT'); } catch(e) {}
  });
  process.once('SIGTERM', function() {
    try { bot.stop('SIGTERM'); } catch(e) {}
  });
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
