 
// index.js
// Telegram Library Bot - robust, Render-ready
// Expects Google Sheet columns: id | title | author | file_id (Sheet1!A:D)

// ---- deps ----
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const Fuse = require('fuse.js');

// ---- env ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS_RAW = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
const ADMIN_IDS = ADMIN_IDS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const SA_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
const BASE_URL = process.env.BASE_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !SHEET_ID || !SA_BASE64 || !BASE_URL) {
  console.error('ERROR: Missing required env vars. Required: BOT_TOKEN, ADMIN_IDS (or ADMIN_ID), SHEET_ID, GOOGLE_SERVICE_ACCOUNT_BASE64, BASE_URL');
  process.exit(1);
}

// ---- logging helper ----
function log(...args) { console.log(new Date().toISOString(), '-', ...args); }

// ---- parse service account ----
let svcJson;
try {
  svcJson = JSON.parse(Buffer.from(SA_BASE64, 'base64').toString('utf8'));
} catch (err) {
  console.error('ERROR: Failed to parse GOOGLE_SERVICE_ACCOUNT_BASE64:', err.message);
  process.exit(1);
}
log('DEBUG service account email =', svcJson.client_email);
log('DEBUG sheet id =', SHEET_ID);

// ---- Google Sheets client ----
const jwt = new google.auth.JWT(
  svcJson.client_email,
  null,
  svcJson.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth: jwt });

// ---- Telegram bot (webhook mode) ----
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json({ limit: '15mb' }));

// ---- in-memory index ----
let books = []; // {id, title, author, file_id}
let fuse = new Fuse([], { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });

// ---- utils ----
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}
function safeText(s) {
  if (!s) return '';
  // remove control characters that cause Telegram parse issues or sheet problems
  return String(s).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Sheets helpers ----
async function loadSheet() {
  try {
    log('Loading sheet rows from Sheet1!A:D ...');
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D'
    });
    const rows = res.data.values || [];
    const parsed = [];
    for (let i = 1; i < rows.length; i++) { // skip header
      const r = rows[i];
      const rowId = safeText(r[0] || '');
      const title = safeText(r[1] || '');
      const author = safeText(r[2] || '');
      const file_id = safeText(r[3] || '');
      if (title && file_id) {
        parsed.push({ id: rowId, title, author, file_id });
      }
    }
    books = parsed;
    fuse = new Fuse(books, { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });
    log(`Loaded ${books.length} books from sheet`);
    return true;
  } catch (err) {
    log('loadSheet error:', err && err.message ? err.message : err);
    throw err;
  }
}

async function appendRow(id, title, author, file_id) {
  try {
    // safe values
    const values = [[safeText(id || ''), safeText(title || ''), safeText(author || ''), safeText(file_id || '')]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      resource: { values }
    });
    log('Appended row:', id, title);
    // small backoff to avoid quota bursts
    await sleep(200);
    return true;
  } catch (err) {
    log('appendRow error:', err && err.message ? err.message : err);
    throw err;
  }
}

// ---- admin notify (plain text, robust) ----
async function notifyAdminsAboutRequest(request) {
  const text =
    "📚 Book request\n" +
    "User: " + (request.userName || '(unknown)') + " (id: " + (request.userId || '(unknown)') + ")\n" +
    "Query: \"" + (request.query || '') + "\"\n" +
    "Time: " + (request.time || new Date().toISOString()) + "\n\n" +
    "Add the file by sending it to the bot with caption: id|title|author";
  for (const adminId of ADMIN_IDS) {
    try {
      const opts = {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Mark as handled', callback_data: `handled:${request.time}:${request.userId}` }
          ]]
        }
      };
      await bot.sendMessage(adminId, text, opts).catch(e => { throw e; });
    } catch (e) {
      log('notify admin failed for', adminId, e && e.message ? e.message : e);
      // continue to next admin
    }
  }
}

// ---- webhook endpoint ----
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---- startup: set webhook, load sheet ----
app.listen(PORT, async () => {
  log('Server started on port', PORT);
  const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
  try {
    await bot.setWebHook(webhookUrl);
    log('Webhook set to', webhookUrl);
  } catch (err) {
    log('Failed to set webhook:', err && err.message ? err.message : err);
  }
  try {
    await loadSheet();
  } catch (e) {
    log('Initial sheet load failed:', e && e.message ? e.message : e);
  }
});

// ---- temp state for admin uploads without caption ----
const waitingForMeta = {}; // chatId -> { file_id }

// ---- Fuse-based search handler & send with validation ----
async function trySendDocument(chatId, fromId, best) {
  try {
    // validate file_id before attempting send
    const file_id = best.file_id;
    if (!file_id) throw new Error('No file_id available');
    // attempt to send
    await bot.sendDocument(chatId, file_id, {}, { filename: `${best.title || 'book'}` });
    return true;
  } catch (err) {
    // log and rethrow
    log('sendDocument error', err && err.message ? err.message : err);
    throw err;
  }
}

// ---- callback query handler (for admin inline buttons) ----
bot.on('callback_query', async (cq) => {
  try {
    const fromId = String(cq.from && cq.from.id);
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(cq.id, { text: 'Only admins can use this.' });
    }
    const data = cq.data || '';
    if (data.startsWith('handled:')) {
      try {
        await bot.editMessageText('Marked handled ✅', { chat_id: cq.message.chat.id, message_id: cq.message.message_id });
        return bot.answerCallbackQuery(cq.id, { text: 'Marked handled' });
      } catch (e) {
        return bot.answerCallbackQuery(cq.id, { text: 'Action failed' });
      }
    }
    return bot.answerCallbackQuery(cq.id, { text: 'Unknown action' });
  } catch (err) {
    log('callback_query handler error', err && err.message ? err.message : err);
  }
});

// ---- main message handler ----
bot.on('message', async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    // only private chats handled here
    if (msg.chat.type !== 'private') return;

    const chatId = msg.chat.id;
    const fromId = msg.from.id;

    // admin uploaded a document
    if (msg.document && isAdmin(fromId)) {
      const file_id = safeText(msg.document.file_id);
      const caption = safeText(msg.caption || '');
      if (caption) {
        // caption expected: id|title|author
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
          return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
        } catch (e) {
          log('appendRow failed after admin upload:', e && e.message ? e.message : e);
          return bot.sendMessage(chatId, `Failed to save "${title}": ${e && e.message ? e.message : 'unknown error'}`);
        }
      } else {
        // no caption: ask for metadata
        waitingForMeta[chatId] = { file_id };
        return bot.sendMessage(chatId, 'Please reply with metadata in this format: id|title|author', { reply_markup: { force_reply: true } });
      }
    }

    // admin replied with metadata after uploading
    if (msg.reply_to_message && waitingForMeta[chatId] && isAdmin(fromId) && msg.text) {
      const meta = safeText(msg.text || '');
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
        log('appendRow (reply flow) failed:', e && e.message ? e.message : e);
        return bot.sendMessage(chatId, `Failed to save: ${e && e.message ? e.message : 'unknown error'}`);
      }
    }

    // ignore commands here
    if (msg.text && msg.text.startsWith('/')) return;

    // treat text as search query
    if (msg.text) {
      const query = safeText(msg.text.trim());
      if (!query) return;
      const results = fuse.search(query);
      if (!results || results.length === 0) {
        // no match: inform user and notify admins
        const userMsg = isAdmin(fromId)
          ? `No match found for "${query}". The librarian has been notified. You can add the file by sending it with caption: id|title|author.`
          : `Sorry — I couldn't find "${query}" in the library. The librarian has been notified and will add it if available.`;
        await bot.sendMessage(chatId, userMsg);

        // notify admins
        const request = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`).trim(),
          query,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(request);
        return;
      }

      // found : best match
      const best = results[0].item;
      // admin sees metadata message
      if (isAdmin(fromId)) {
        const meta = `📗 Found: ${best.title}\nID: ${best.id || '-'}\nAuthor: ${best.author || '-'}\n\nSending file now...`;
        await bot.sendMessage(chatId, meta);
      } else {
        await bot.sendMessage(chatId, `Found "${best.title}" — sending file now...`);
      }

      try {
        await trySendDocument(chatId, fromId, best);
      } catch (err) {
        // send failure message + notify admins safely
        log('Failed to send document to user, notifying admins...');
        await bot.sendMessage(chatId, `Found "${best.title}" but failed to send it: ${err && err.message ? err.message : 'unknown'}. The librarian has been notified.`);
        const failureNotice = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`).trim(),
          query: `Attempt to send "${best.title}" failed: ${err && err.message ? err.message : 'unknown'}`,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(failureNotice);
      }
    }

  } catch (err) {
    log('message handler error:', err && err.message ? err.message : err);
  }
});
