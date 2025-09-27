// index.js - Updated: admin detection + admin/user-specific messages + admin notifications
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const Fuse = require('fuse.js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS_RAW = process.env.ADMIN_IDS || process.env.ADMIN_ID || ''; // support both
const ADMIN_IDS = ADMIN_IDS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const BASE_URL = process.env.BASE_URL;
const PORT = process.env.PORT || 3000;
const SA_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;

// Basic env validation
if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !SHEET_ID || !SA_BASE64 || !BASE_URL) {
  console.error('Missing required env vars. Required: BOT_TOKEN, ADMIN_IDS (or ADMIN_ID), SHEET_ID, GOOGLE_SERVICE_ACCOUNT_BASE64, BASE_URL');
  process.exit(1);
}

// parse service account JSON
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

// Telegram setup (webhook)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json({ limit: '15mb' }));

// In-memory books index
let books = [];
let fuse = new Fuse([], { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });

// load sheet (expects Sheet1!A:D -> id | title | author | file_id)
async function loadSheet() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D'
    });
    const rows = res.data.values || [];
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
    return true;
  } catch (err) {
    console.error('loadSheet error:', err.message);
    throw err;
  }
}

async function appendRow(id, title, author, file_id) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A:D',
    valueInputOption: 'RAW',
    resource: { values: [[id, title, author, file_id]] }
  });
  console.log('Appended row:', id, title);
}

// webhook endpoint
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// start server + set webhook
app.listen(PORT, async () => {
  console.log('Server started on port', PORT);
  const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set to', webhookUrl);
  } catch (err) {
    console.error('Failed to set webhook:', err.message);
  }
  try {
    await loadSheet();
  } catch (e) {
    console.error('Initial sheet load failed:', e.message);
  }
});

// helpers
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function adminNotifyText(request) {
  // request: { userId, userName, query, time }
  return `📚 *Book request*\nUser: ${request.userName} (id: ${request.userId})\nQuery: "${request.query}"\nTime: ${request.time}\n\nSend the file to the bot (admin chat) or add to sheet.`;
}

async function notifyAdminsAboutRequest(request) {
  for (const adminId of ADMIN_IDS) {
    try {
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Mark as handled', callback_data: `handled:${request.time}:${request.userId}` }
          ]]
        }
      };
      await bot.sendMessage(adminId, adminNotifyText(request), opts);
    } catch (e) {
      console.error('notify admin failed for', adminId, e.message);
    }
  }
}

// temp storage for admin-upload-without-caption flow
const waitingForMeta = {};

// bot handlers

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const textUser = `📚 Welcome to the library bot!\n\nType a book title, author, or ID and I'll search our collection.`;
  const textAdmin = `📚 Welcome back, Librarian.\n• Send a document with caption: id|title|author to save it automatically.\n• Or send without caption and reply to the bot's prompt with id|title|author.`;
  const text = isAdmin(msg.from.id) ? textAdmin : textUser;
  bot.sendMessage(chatId, text);
});

bot.onText(/\/list/, (msg) => {
  const sample = books.slice(0, 30).map(b => `${b.id || '-'} | ${b.title} — ${b.author || '-'}`).join('\n') || 'No books yet';
  bot.sendMessage(msg.chat.id, `Books (first 30):\n${sample}`);
});

bot.onText(/\/reload/, async (msg) => {
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, 'Only admins can use /reload.');
  bot.sendMessage(msg.chat.id, 'Reloading sheet...');
  try {
    await loadSheet();
    bot.sendMessage(msg.chat.id, `Reloaded ${books.length} books.`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Reload failed: ' + e.message);
  }
});

// handle callback query (admin pressed "Mark as handled")
bot.on('callback_query', async (cq) => {
  const data = cq.data || '';
  if (!cq.from || !isAdmin(cq.from.id)) {
    return bot.answerCallbackQuery(cq.id, { text: 'Only admin can use this.' });
  }
  if (data.startsWith('handled:')) {
    try {
      await bot.editMessageText('Marked handled ✅', { chat_id: cq.message.chat.id, message_id: cq.message.message_id });
      return bot.answerCallbackQuery(cq.id, { text: 'Marked handled' });
    } catch (e) {
      return bot.answerCallbackQuery(cq.id, { text: 'Action failed' });
    }
  }
  return bot.answerCallbackQuery(cq.id, { text: 'Unknown action' });
});

// main message handler
bot.on('message', async (msg) => {
  try {
    if (!msg.chat || msg.chat.type !== 'private') return; // only handle private chats here
    const chatId = msg.chat.id;
    const fromId = msg.from.id;

    // admin uploaded a document
    if (msg.document && isAdmin(fromId)) {
      const file_id = msg.document.file_id;
      const caption = (msg.caption || '').trim();
      if (caption) {
        // expect id|title|author
        const parts = caption.split('|').map(s => s.trim());
        const id = parts[0] || '';
        const title = parts[1] || '';
        const author = parts[2] || '';
        if (!title || !file_id) {
          return bot.sendMessage(chatId, 'Caption format: id|title|author (title required). Example: 0005|My Book|Author Name');
        }
        try {
          await appendRow(id || '', title, author || '', file_id);
          await loadSheet();
          return bot.sendMessage(chatId, `Saved "${title}" to the sheet.`);
        } catch (e) {
          return bot.sendMessage(chatId, `Failed to save: ${e.message}`);
        }
      } else {
        // ask for metadata
        waitingForMeta[chatId] = { file_id };
        return bot.sendMessage(chatId, 'Please reply with metadata in this format: id|title|author', { reply_markup: { force_reply: true } });
      }
    }

    // admin replied with metadata after upload
    if (msg.reply_to_message && waitingForMeta[chatId] && isAdmin(fromId) && msg.text) {
      const meta = msg.text.trim();
      const parts = meta.split('|').map(s => s.trim());
      const id = parts[0] || '';
      const title = parts[1] || '';
      const author = parts[2] || '';
      const file_id = waitingForMeta[chatId].file_id;
      if (!title || !file_id) {
        return bot.sendMessage(chatId, 'Invalid metadata. Use: id|title|author (title required).');
      }
      try {
        await appendRow(id || '', title, author || '', file_id);
        delete waitingForMeta[chatId];
        await loadSheet();
        return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
      } catch (e) {
        return bot.sendMessage(chatId, `Failed to save: ${e.message}`);
      }
    }

    // ignore commands here
    if (msg.text && msg.text.startsWith('/')) return;

    // treat text as search query
    if (msg.text) {
      const query = msg.text.trim();
      const results = fuse.search(query);
      if (!results || results.length === 0) {
        // no match: inform user and notify admins
        const userMsg = isAdmin(fromId)
          ? `No match found for "${query}". I have notified the librarian and you can add the file by sending it with caption: id|title|author.`
          : `Sorry — I couldn't find "${query}" in the library. The librarian has been notified and will add it if available.`;
        // send user-friendly reply
        await bot.sendMessage(chatId, userMsg);

        // notify admins with details
        const request = {
          userId: fromId,
          userName: msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
          query,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(request);
        return;
      }

      // found something -> best match
      const best = results[0].item;
      // admin sees extra metadata
      if (isAdmin(fromId)) {
        const meta = `📗 Found: ${best.title}\nID: ${best.id || '-'}\nAuthor: ${best.author || '-'}\n\nSending file now...`;
        await bot.sendMessage(chatId, meta);
      } else {
        await bot.sendMessage(chatId, `Found "${best.title}" — sending file now...`);
      }

      try {
        await bot.sendDocument(chatId, best.file_id, {}, { filename: `${best.title || 'book'}` });
      } catch (e) {
        console.error('sendDocument error', e.message);
        // inform user + notify admins about failure
        await bot.sendMessage(chatId, `Found "${best.title}" but failed to send it: ${e.message}. The librarian has been notified.`);
        const failureNotice = {
          userId: fromId,
          userName: msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
          query: `Attempt to send "${best.title}" failed: ${e.message}`,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(failureNotice);
      }
    }
  } catch (err) {
    console.error('message handler error', err);
  }
});
