require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const cloudinary = require('cloudinary').v2;
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL; // e.g. https://your-app.up.railway.app
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !BASE_URL) {
  console.error('Missing BOT_TOKEN or BASE_URL in environment variables.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------- SIMPLE JSON "DATABASE" ----------
const DB_PATH = path.join(__dirname, 'db.json');

function loadDb() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// id -> { shopeeLink, imageUrl, createdAt }
let db = loadDb();

// ---------- IN-MEMORY SESSION (per chat, hindi need i-save) ----------
// chatId -> { shopeeLink?, imageUrl? }
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = {};
  return sessions[chatId];
}

function isShopeeLink(text) {
  return /https?:\/\/(shopee\.[a-z.]+|shp\.ee|s\.shopee\.[a-z.]+)\/\S+/i.test(text);
}

function isTiktokLink(text) {
  return /https?:\/\/(www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i.test(text);
}

// ---------- TELEGRAM BOT ----------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    'Hi! Ako yung Shopee Preview Image Changer Bot.\n\n' +
    'Paano gamitin:\n' +
    '1. Ipadala mo yung Shopee link mo or Tiktok link\n' +
    '2. Ipadala mo yung larawan na gusto mong lumabas bilang preview\n' +
    '(kahit anong order, basta dalawa lang)\n\n' +
    'Ibabalik ko sayo yung bagong link na pwede mo nang i-post sa Facebook.'
  );
});

bot.help((ctx) => {
  ctx.reply('Magpadala ka lang ng Shopee link or Tiktok link, tapos magpadala ka ng image. Gagawa ako ng bagong link na may custom preview image.');
});

// Handle text messages (Shopee link)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return; // ignore other commands

  if (!isShopeeLink(text) && !isTiktokLink(text)) {
    ctx.reply('Hindi ko ma-recognize yan bilang Shopee o Tiktok link. Pakipadala ulit ng valid na Shopee o Tiktok link.');
    return;
  }
  

  const session = getSession(ctx.chat.id);
  session.shopeeLink  = text;

  if (session.imageUrl) {
    await finalizeLink(ctx, session);
  } else {
    ctx.reply('Nakuha ko na yung Shopee link. Ngayon ipadala mo yung image na gusto mong gamiting preview.');
  }
});

// Handle photo messages
bot.on('photo', async (ctx) => {
  const session = getSession(ctx.chat.id);
  const statusMsg = await ctx.reply('Ina-upload yung image, sandali lang...');

  try {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // highest resolution
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const uploadResult = await cloudinary.uploader.upload(fileLink.href, {
      folder: 'shopee-preview-bot',
    });

    session.imageUrl = uploadResult.secure_url;

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    if (session.shopeeLink) {
      await finalizeLink(ctx, session);
    } else {
      ctx.reply('Na-upload na yung image. Ngayon ipadala mo yung Shopee link.');
    }
  } catch (err) {
    console.error(err);
    ctx.reply('May error sa pag-upload ng image. Subukan mo ulit.');
  }
});

async function finalizeLink(ctx, session) {
  const id = nanoid(8);
  db[id] = {
    shopeeLink: session.shopeeLink,
    imageUrl: session.imageUrl,
    createdAt: new Date().toISOString(),
  };
  saveDb(db);

  // reset session para sa susunod na gamit
  delete session.shopeeLink;
  delete session.imageUrl;

  const previewLink = `${BASE_URL}/p/${id}`;
  await ctx.reply(
    'Tapos na! Eto yung bagong link mo, i-post mo na sa Facebook:\n\n' + previewLink
  );
}

// ---------- EXPRESS SERVER (OG preview + redirect) ----------
const app = express();

// User-agents ng mga link-preview crawlers (Facebook, Twitter/X, LinkedIn, Telegram, etc.)
// Sa mga ito, HUWAG mag-redirect — kailangan nilang makita yung OG tags natin.
const CRAWLER_UA_REGEX = /facebookexternalhit|Facebot|Twitterbot|LinkedInBot|TelegramBot|WhatsApp|Slackbot|Discordbot|Pinterest|redditbot|SkypeUriPreview|vkShare|Applebot/i;

app.get('/p/:id', (req, res) => {
  const entry = db[req.params.id];
  if (!entry) {
    return res.status(404).send('Link not found.');
  }

  const safeImage = entry.imageUrl;
  const safeRedirect = entry.shopeeLink;
  const userAgent = req.headers['user-agent'] || '';
  const isCrawler = CRAWLER_UA_REGEX.test(userAgent);

  // 1. KUNG TAO ANG BUMIBISITA: I-redirect agad sa Shopee (Mas mabilis at iwas glitches)
  if (!isCrawler) {
    return res.redirect(302, safeRedirect);
  }

  // 2. KUNG BOT/CRAWLER: I-serve ang HTML na may spoofed na og:url
  const ogHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:type" content="website" />
  
  <meta property="og:url" content="https://www.facebook.com" />
  
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${safeImage}" />
</head>
<body>
</body>
</html>`;

  res.send(ogHtml);
});

app.get('/', (req, res) => {
  res.send('Shopee Preview Bot is running.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

bot.launch();
console.log('Telegram bot started.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));