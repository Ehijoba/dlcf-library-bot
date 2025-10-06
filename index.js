// index.js
// Robust Telegram Library Bot (Render-ready)
// Sheet format expected: Sheet1!A:D -> id | title | author | file_id

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const Fuse = require('fuse.js');
const stringify = require('csv-stringify/lib/sync');

///////////////////////
// Configuration & Env
///////////////////////
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS_RAW = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
const ADMIN_IDS = ADMIN_IDS_RAW.split(',').map(s => s.trim()).filter(Boolean);
const SHEET_ID = process.env.SHEET_ID;
const SA_BASE64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
const BASE_URL = process.env.BASE_URL;
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !SHEET_ID || !SA_BASE64 || !BASE_URL) {
  console.error('FATAL: Missing env vars. Required: BOT_TOKEN, ADMIN_IDS (or ADMIN_ID), SHEET_ID, GOOGLE_SERVICE_ACCOUNT_BASE64, BASE_URL');
  process.exit(1);
}

///////////////////////
// Small helpers
///////////////////////
const log = (...args) => console.log(new Date().toISOString(), '-', ...args);
const safeText = (v) => {
  if (v === undefined || v === null) return '';
  // remove ASCII control chars that may break things
  return String(v).replace(/[\u0000-\u001F\u007F]/g, '').trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

///////////////////////
// Local DB (for requests)
///////////////////////
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const init = { requests: [] };
      fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    log('Failed reading DB, recreating:', e.message || e);
    const init = { requests: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

///////////////////////
// Google Sheets setup
///////////////////////
let sheetsClient, svcJson;
try {
  svcJson = JSON.parse(Buffer.from(SA_BASE64, 'base64').toString('utf8'));
} catch (e) {
  console.error('FATAL: Could not parse GOOGLE_SERVICE_ACCOUNT_BASE64:', e.message || e);
  process.exit(1);
}
const jwt = new google.auth.JWT(
  svcJson.client_email,
  null,
  svcJson.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
sheetsClient = google.sheets({ version: 'v4', auth: jwt });

///////////////////////
// Telegram + Express
///////////////////////
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json({ limit: '16mb' }));

// webhook receiver
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// health endpoint
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), books: books.length }));

///////////////////////
// In-memory index
///////////////////////
let books = []; // array of {id, title, author, file_id}
let fuse = new Fuse([], { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });

// Load sheet into memory
async function loadSheet() {
  try {
    log('Attempting to load sheet:', SHEET_ID, 'as', svcJson.client_email);
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D'
    });
    const rows = resp.data.values || [];
    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const id = safeText(r[0] || '');
      const title = safeText(r[1] || '');
      const author = safeText(r[2] || '');
      const file_id = safeText(r[3] || '');
      if (title && file_id) parsed.push({ id, title, author, file_id });
    }
    books = parsed;
    fuse = new Fuse(books, { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });
    log('Loaded books from sheet:', books.length);
    return books.length;
  } catch (err) {
    log('loadSheet error:', err && err.message ? err.message : err);
    throw err;
  }
}

async function appendRowToSheet(id, title, author, file_id) {
  try {
    const values = [[safeText(id || ''), safeText(title || ''), safeText(author || ''), safeText(file_id || '')]];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      resource: { values }
    });
    log('appendRow success', id, title);
    // small sleep to avoid quota bursts
    await sleep(200);
    return true;
  } catch (err) {
    log('appendRowToSheet error:', err && err.message ? err.message : err);
    throw err;
  }
}

///////////////////////
// Utility: validate file_id by calling bot.getFile
///////////////////////
async function validateFileId(file_id) {
  try {
    const info = await bot.getFile(file_id);
    return { ok: true, file_path: info.file_path || '' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

///////////////////////
// Admin notify (plain text)
///////////////////////
async function notifyAdminsAboutRequest(request) {
  const text =
    '📚 New book request\n' +
    `User: ${request.userName || '(unknown)'} (id: ${request.userId || '(unknown)'})\n` +
    `Query: "${request.query || ''}"\n` +
    `Time: ${request.time || new Date().toISOString()}\n\n` +
    'If you have this book, send it to the bot with caption: id|title|author';
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId, text, {
        reply_markup: {
          inline_keyboard: [[{ text: 'Mark handled', callback_data: `handled:${request.time}:${request.userId}` }]]
        }
      });
    } catch (e) {
      log('notify admin failed for', adminId, e && e.message ? e.message : e);
    }
  }
}

///////////////////////
// Rate limiter (per-user)
///////////////////////
const RATE_WINDOW_MS = 1000; // 1 request per second
const lastRequestAt = new Map();
function rateLimit(userId) {
  const now = Date.now();
  const last = lastRequestAt.get(userId) || 0;
  if (now - last < RATE_WINDOW_MS) return false;
  lastRequestAt.set(userId, now);
  return true;
}

///////////////////////
// Helper: find duplicate by file_id or title
///////////////////////
function findByFileId(file_id) {
  return books.find(b => b.file_id === file_id);
}
function findByTitleOrAuthor(title, author) {
  const t = safeText(title).toLowerCase();
  const a = safeText(author).toLowerCase();
  return books.find(b => (b.title && b.title.toLowerCase() === t) || (b.author && b.author.toLowerCase() === a));
}

///////////////////////
// Expose /validate-fileids job (admin only, via Telegram command, not HTTP)
///////////////////////
async function validateAllFileIdsAndReport(adminChatId) {
  try {
    log('Starting validateAllFileIds job (admin requested)');
    const report = [];
    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      const rowNum = i + 2; // approximate (skip header)
      const res = await validateFileId(b.file_id);
      if (!res.ok) {
        report.push({ row: rowNum, id: b.id, title: b.title, author: b.author, file_id: b.file_id, error: res.error });
      }
      // small throttle
      await sleep(250);
    }
    if (report.length === 0) {
      await bot.sendMessage(adminChatId, `✅ Validation complete: all ${books.length} file_id(s) are valid.`);
      return;
    }
    // create CSV and send back to admin
    const csv = stringify(report, { header: true });
    const tmp = path.join(__dirname, `invalid-fileids-${Date.now()}.csv`);
    fs.writeFileSync(tmp, csv);
    await bot.sendMessage(adminChatId, `Validation complete: ${report.length} invalid file_id(s). Sending CSV report...`);
    await bot.sendDocument(adminChatId, fs.createReadStream(tmp));
    fs.unlinkSync(tmp);
  } catch (err) {
    log('validateAllFileIds job error:', err && err.message ? err.message : err);
    await bot.sendMessage(adminChatId, `Validation job failed: ${err && err.message ? err.message : err}`);
  }
}

///////////////////////
// Bot command handlers + message handler
///////////////////////

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isAdm = ADMIN_IDS.includes(String(msg.from.id));
  if (isAdm) {
    bot.sendMessage(chatId, `👋 Librarian — bot is online. Use /reload to refresh index, /validate to validate file_ids, or send a document with caption id|title|author to add a book.`);
  } else {
    bot.sendMessage(chatId, `📚 Welcome to the library bot!\nType title, author or id to search.\nIf not found your request will be sent to the librarian.`);
  }
});

// /list (first N)
bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const sample = books.slice(0, 50).map(b => `${b.id || '-'} | ${b.title} — ${b.author || '-'}`).join('\n') || 'No books yet';
  bot.sendMessage(chatId, `Books (first 50):\n${sample}`);
});

// /reload (admin only)
bot.onText(/\/reload/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /reload.');
  bot.sendMessage(chatId, '🔄 Reloading sheet...');
  try {
    const cnt = await loadSheet();
    bot.sendMessage(chatId, `✅ Reloaded ${cnt} books.`);
  } catch (e) {
    bot.sendMessage(chatId, `Reload failed: ${e && e.message ? e.message : e}`);
  }
});

// /add id|title|author|file_id  (admin quick add)
bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /add.');
  const raw = match[1].trim();
  const parts = raw.split('|').map(s => s.trim());
  const id = parts[0] || '';
  const title = parts[1] || '';
  const author = parts[2] || '';
  const file_id = parts[3] || '';
  if (!title || !file_id) return bot.sendMessage(chatId, 'Usage: /add id|title|author|file_id (title and file_id required)');
  // dedupe by file_id
  if (findByFileId(file_id)) return bot.sendMessage(chatId, 'This file_id already exists in the library.');
  try {
    await appendRowToSheet(id, title, author, file_id);
    await loadSheet();
    bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
  } catch (e) {
    bot.sendMessage(chatId, `Failed to add: ${e && e.message ? e.message : e}`);
  }
});

// /validate (admin only) - kick off validation job
bot.onText(/\/validate/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /validate.');
  bot.sendMessage(chatId, 'Starting validation of all file_ids. This may take a while...');
  // run async, don't block
  validateAllFileIdsAndReport(chatId);
});

// callback query handler (inline button)
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
    log('callback_query error:', err && err.message ? err.message : err);
  }
});

// main message handler
bot.on('message', async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (msg.chat.type !== 'private') return; // only private chats

    const chatId = msg.chat.id;
    const fromId = String(msg.from.id);

    // rate-limit
    if (!rateLimit(fromId)) {
      return bot.sendMessage(chatId, 'Slow down — please wait a second between requests.');
    }

    // admin uploaded a document
    if (msg.document && isAdmin(fromId)) {
      const file_id = safeText(msg.document.file_id);
      const caption = safeText(msg.caption || '');
      if (caption) {
        // caption is id|title|author
        const parts = caption.split('|').map(s => s.trim());
        const id = parts[0] || '';
        const title = parts[1] || '';
        const author = parts[2] || '';
        if (!title || !file_id) {
          return bot.sendMessage(chatId, 'Caption format: id|title|author (title required). Example: 0005|My Book|Author Name');
        }
        // prevent duplicates
        if (findByFileId(file_id)) {
          return bot.sendMessage(chatId, `This file is already in the library as "${findByFileId(file_id).title}".`);
        }
        try {
          await appendRowToSheet(id, title, author, file_id);
          await loadSheet();
          return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
        } catch (e) {
          log('appendRow error for admin upload:', e && e.message ? e.message : e);
          return bot.sendMessage(chatId, `Failed to save "${title}": ${e && e.message ? e.message : 'unknown error'}`);
        }
      } else {
        // ask for metadata
        waitingForMeta[chatId] = { file_id };
        return bot.sendMessage(chatId, 'Please reply with metadata in this format: id|title|author', { reply_markup: { force_reply: true } });
      }
    }

    // admin replied with metadata after upload
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
        await appendRowToSheet(id, title, author, file_id);
        delete waitingForMeta[chatId];
        await loadSheet();
        return bot.sendMessage(chatId, `Saved "${title}" to sheet.`);
      } catch (e) {
        log('appendRow reply flow error:', e && e.message ? e.message : e);
        return bot.sendMessage(chatId, `Failed to save: ${e && e.message ? e.message : 'unknown error'}`);
      }
    }

    // ignore commands here
    if (msg.text && msg.text.startsWith('/')) return;

    // plain text -> search query
    if (msg.text) {
      const query = safeText(msg.text.trim());
      if (!query) return;
      const results = fuse.search(query);
      if (!results || results.length === 0) {
        // record request and notify admins
        const req = {
          id: `${Date.now()}_${fromId}`,
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`).trim(),
          query,
          createdAt: new Date().toISOString()
        };
        db.requests = db.requests || [];
        db.requests.push(req);
        saveDB(db);
        // tell user
        const userMsg = isAdmin(fromId)
          ? `No match found for "${query}". Librarian notified — send the file to add it.`
          : `Sorry — I couldn't find "${query}". The librarian has been notified and will add it if available.`;
        await bot.sendMessage(chatId, userMsg);
        // notify admins
        await notifyAdminsAboutRequest(req).catch(e => log('notifyAdminsAboutRequest error:', e && e.message ? e.message : e));
        return;
      }

      // we have results
      const best = results[0].item;
      // admin gets more detail
      if (isAdmin(fromId)) {
        await bot.sendMessage(chatId, `📗 Found: ${best.title}\nID: ${best.id || '-'}\nAuthor: ${best.author || '-'}\nSending file now...`);
      } else {
        await bot.sendMessage(chatId, `Found "${best.title}" — sending file now...`);
      }

      // attempt to send, but first validate file_id to provide clearer errors
      const v = await validateFileId(best.file_id);
      if (!v.ok) {
        log('Invalid file_id for', best.title, best.file_id, v.error);
        // notify user and admins
        await bot.sendMessage(chatId, `Found "${best.title}" but the stored file_id appears invalid: ${v.error}. The librarian has been notified.`);
        const failureNotice = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''}`).trim(),
          query: `Invalid file_id for "${best.title}": ${v.error}`,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(failureNotice);
        return;
      }

      // send the document
      try {
        await bot.sendDocument(chatId, best.file_id);
      } catch (err) {
        log('sendDocument error:', err && err.message ? err.message : err);
        const errmsg = (err && err.message) ? err.message : 'unknown';
        await bot.sendMessage(chatId, `Found "${best.title}" but failed to send the file: ${errmsg}. The librarian has been notified.`);
        const failureNotice = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''}`).trim(),
          query: `Attempt to send "${best.title}" failed: ${errmsg}`,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(failureNotice);
      }
    }

  } catch (err) {
    log('message handler unexpected error:', err && err.message ? err.message : err);
  }
});

///////////////////////
// Server start
///////////////////////
app.listen(PORT, async () => {
  log('Server listening on port', PORT);
  try {
    const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
    await bot.setWebHook(webhookUrl);
    log('Webhook set to', webhookUrl);
  } catch (e) {
    log('Failed to set webhook:', e && e.message ? e.message : e);
  }
  // initial sheet load
  try {
    await loadSheet();
  } catch (e) {
    log('Initial loadSheet error (safe to continue):', e && e.message ? e.message : e);
  }
});

// graceful shutdown
process.on('SIGINT', async () => {
  log('SIGINT received — shutting down');
  try { await bot.closeWebHook(); } catch(e) {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log('SIGTERM received — shutting down');
  try { await bot.closeWebHook(); } catch(e) {}
  process.exit(0);
});
