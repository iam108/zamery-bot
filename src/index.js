require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot/index');
const { setupWeb } = require('./web/index');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL ok');
  } catch (err) {
    console.error('DB error:', err.message);
    process.exit(1);
  }

  const app = express();
  const bot = setupBot();

  if (process.env.NODE_ENV === 'production') {
    const webhookPath = '/webhook/' + process.env.BOT_TOKEN;
    await bot.telegram.setWebhook(process.env.WEBAPP_URL + webhookPath);
    app.use(bot.webhookCallback(webhookPath));
    console.log('webhook registered: ' + webhookPath);
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch();
  }

  setupWeb(app);

  app.listen(PORT, '0.0.0.0', function() {
    console.log('Server on port ' + PORT);
  });

  process.once('SIGINT', function() { bot.stop('SIGINT'); });
  process.once('SIGTERM', function() { bot.stop('SIGTERM'); });
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
