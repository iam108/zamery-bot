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

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  setupWeb(app);

  app.listen(PORT, '0.0.0.0', function() {
    console.log('Server on port ' + PORT);
  });

  const bot = setupBot();
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.launch();
  console.log('Bot started polling');

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
