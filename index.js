// index.js - Telegram Library Bot (Render-ready)
// Reads sheet: id | title | author | file_id
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const Fuse = require('fuse.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const BASE_URL = process.env.BASE_URL;
const PORT = process.env.PORT || 3000;
const SA_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;

if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !SHEET_ID || !SA_BASE64 || !BASE_URL) {
  console.error('Missing required env vars. Required: BOT_TOKEN, ADMIN_IDS, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_BASE64, BASE_URL');
  process.exit(1);
}

// Google Sheets auth
let svcJson;
try {
  svcJson = JSON.parse(Buffer.from(SA_BASE64, 'base64').toString('utf8'));
} catch (err) {
  console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_BASE64:', err.message);
  process.exit(1);
}
const jwt = new google.auth.JWT(
  svcJson.client_email,
  null,
  svcJson.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth: jwt });

// Telegram in webhook mode
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json({ limit: '15mb' }));

// In-memory book index: array of {id, title, author, file_id}
let books = [];
let fuse = new Fuse([], { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });

// Helper: load sheet (Sheet1!A:D)
async function loadSheet() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D'
    });
    const rows = res.data.values || [];
    // Expect header row at rows[0]
    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rowId = (r[0] || '').toString().trim();
      const title = (r[1] || '').toString().trim();
      const author = (r[2] || '').toString().trim();
      const file_id = (r[3] || '').toString().trim();
      if (title && file_id) parsed.push({ id: rowId, title, author, file_id });
    }
    books = parsed;
    fuse = new Fuse(books, { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });
    console.log(`Loaded ${books.length} books from sheet`);
  } catch (err) {
    console.error('loadSheet error:', err.message);
    throw err;
  }
}

// Helper: append row [id,title,author,file_id]
async function appendRow(id, title, author, file_id) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:D',
    valueInputOption: 'RAW',
    resource: { values: [[id, title, author, file_id]] }
  });
  console.log('Appended row:', id, title);
}

// Webhook endpoint for Telegram
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start server & set webhook
app.listen(PORT, async () => {
  console.log('Server started on port', PORT);
  const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set to', webhookUrl);
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
  }
  // Load sheet at startup
  try {
    await loadSheet();
  } catch (e) {
    console.error('Initial sheet load failed:', e.message);
  }
});

// UTIL: is admin?
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const txt = `📚 Welcome to the Library Bot.\n\nHow to use:\n• Type a book title, author, or id and I'll search.\n\nAdmins can send a document with caption: id|title|author to add it automatically.`;
  bot.sendMessage(chatId, txt);
});

// /list
bot.onText(/\/list/, (msg) => {
  const sample = books.slice(0, 30).map(b => `${b.id || '-'} | ${b.title} — ${b.author || '-'}`).join('\n') || 'No books yet';
  bot.sendMessage(msg.chat.id, `Books (first 30):\n${sample}`);
});

// /reload (admin only)
bot.onText(/\/reload/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Only admin can use /reload');
  bot.sendMessage(msg.chat.id, 'Reloading sheet...');
  try {
    await loadSheet();
    bot.sendMessage(msg.chat.id, `Reloaded ${books.length} books.`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Reload failed: ' + e.message);
  }
});

// Search & send file_id on any private text message
bot.on('message', async (msg) => {
  try {
    // ignore group messages except commands
    if (!msg.chat || msg.chat.type !== 'private') {
      return;
    }

    // ignore commands in this handler
    if (msg.text && msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const fromId = msg.from.id;

    // Admin sent a document -> capture file_id and append
    if (msg.document && isAdmin(fromId)) {
      // If caption present, expect caption format: id|title|author
      const file_id = msg.document.file_id;
      const caption = (msg.caption || '').trim();
      if (caption) {
        const parts = caption.split('|').map(s => s.trim());
        const id = parts[0] || '';
        const title = parts[1] || '';
        const author = parts[2] || '';
        if (!title || !file_id) {
          return bot.sendMessage(chatId, 'Caption must be: id|title|author (title required). Example: 0005|My Book|Author Name');
        }
        try {
          await appendRow(id || '', title, author || '', file_id);
          await loadSheet();
          return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
        } catch (e) {
          return bot.sendMessage(chatId, `Failed to save: ${e.message}`);
        }
      } else {
        // no caption: ask for metadata using force_reply
        // store the file_id temporarily in memory keyed by chatId
        waitingForMeta[chatId] = { file_id };
        return bot.sendMessage(chatId, 'Please reply with metadata in this format: id|title|author', { reply_markup: { force_reply: true } });
      }
    }

    // Admin replied with metadata after uploading (force-reply)
    if (msg.reply_to_message && waitingForMeta[msg.chat.id] && msg.text && isAdmin(fromId)) {
      const meta = msg.text.trim();
      const parts = meta.split('|').map(s => s.trim());
      const id = parts[0] || '';
      const title = parts[1] || '';
      const author = parts[2] || '';
      const file_id = waitingForMeta[msg.chat.id].file_id;
      if (!title || !file_id) {
        return bot.sendMessage(chatId, 'Invalid metadata. Use: id|title|author (title required).');
      }
      try {
        await appendRow(id || '', title, author || '', file_id);
        delete waitingForMeta[msg.chat.id];
        await loadSheet();
        return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
      } catch (e) {
        return bot.sendMessage(chatId, `Failed to save: ${e.message}`);
      }
    }

    // Otherwise treat text as a search query
    if (msg.text) {
      const query = msg.text.trim();
      // fuzzy search with Fuse
      const results = fuse.search(query);
      if (!results || results.length === 0) {
        return bot.sendMessage(chatId, `No match found for "${query}". Admins can add books by sending the file with caption: id|title|author`);
      }
      const best = results[0].item;
      // send the document using file_id (Telegram will deliver actual file)
      try {
        await bot.sendDocument(chatId, best.file_id, {}, { filename: `${best.title || 'book'}.pdf` });
      } catch (e) {
        console.error('sendDocument error', e.message);
        return bot.sendMessage(chatId, `Found "${best.title}" but failed to send file: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('handler error', err);
  }
});

// temp storage for admin uploads missing caption
const waitingForMeta = {};
