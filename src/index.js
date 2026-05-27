require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot/index');
const { setupWeb } = require('./web/index');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('DB ok');
  } catch (err) {
    console.error('DB error:', err.message);
    process.exit(1);
  }

  const app = express();
  const bot = setupBot();

  if (process.env.NODE_ENV === 'production') {
    const webhookPath = '/webhook/' + process.env.BOT_TOKEN;
    await bot.telegram.setWebhook(process.env.WEBAPP_URL + webhookPath);

    // Webhook роут БЕЗ json middleware — Telegraf сам парсит
    app.use(webhookPath, bot.webhookCallback(webhookPath));
    console.log('webhook mode');
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('polling mode');
  }

  // JSON middleware с большим лимитом — ПОСЛЕ webhook роута
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
