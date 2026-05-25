require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot/index');
const { setupWeb } = require('./web/index');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL;

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL подключён');
  } catch (err) {
    console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
    process.exit(1);
  }

  const app = express();
  setupWeb(app);

  
    console.log(`🌐 Веб-сервер запущен на порту ${PORT}`);
  });

  const bot = setupBot();

  if (process.env.NODE_ENV === 'production') {
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
app.listen(PORT, '0.0.0.0', () => {
    await bot.telegram.setWebhook(`${WEBAPP_URL}${webhookPath}`);
    app.use(bot.webhookCallback(webhookPath));
    console.log('🤖 Бот запущен в режиме webhook');
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('🤖 Бот запущен в режиме polling (dev)');
  }

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
