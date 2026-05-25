require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { setupWeb } = require('./web/index');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const WEBHOOK_PATH = '/webhook/' + BOT_TOKEN;

const app = express();
const bot = new Telegraf(BOT_TOKEN);

bot.start(function(ctx) { ctx.reply('Привет! Нажми кнопку для новой заявки.'); });
bot.command('stats', function(ctx) { ctx.reply('stats ok'); });

async function main() {
  await pool.query('SELECT 1');
  console.log('DB ok');

  await bot.telegram.setWebhook(WEBAPP_URL + WEBHOOK_PATH);
  console.log('Webhook set: ' + WEBAPP_URL + WEBHOOK_PATH);

  app.use(bot.webhookCallback(WEBHOOK_PATH));
  setupWeb(app);

  app.listen(PORT, '0.0.0.0', function() {
    console.log('Server on port ' + PORT);
  });
}

main().catch(function(e) {
  console.error(e);
  process.exit(1);
});
