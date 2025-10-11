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
const { stringify } = require('csv-stringify/sync');

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
const DEV_MODE = process.env.DEV_MODE === 'true';
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL) || 1000;

if (!BOT_TOKEN || ADMIN_IDS.length === 0 || !SHEET_ID || !SA_BASE64) {
  console.error('FATAL: Missing env vars. Required: BOT_TOKEN, ADMIN_IDS (or ADMIN_ID), SHEET_ID, GOOGLE_SERVICE_ACCOUNT_BASE64');
  process.exit(1);
}

if (!DEV_MODE && !BASE_URL) {
  console.error('FATAL: BASE_URL is required in production mode. Set DEV_MODE=true for local development.');
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

// Clean file_ids by removing all whitespace and control characters
// Telegram file_ids should be continuous alphanumeric + a few special chars
const safeFileId = (v) => {
  if (v === undefined || v === null) return '';
  // Remove ALL whitespace characters (spaces, tabs, newlines, etc.) and control chars
  // Telegram file_ids are base64-like strings that should have NO whitespace
  return String(v).replace(/\s/g, '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

///////////////////////
// Local DB (for requests and user stats)
///////////////////////
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const init = { requests: [], userStats: {} };
      fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // Ensure userStats exists
    if (!data.userStats) data.userStats = {};
    return data;
  } catch (e) {
    log('Failed reading DB, recreating:', e.message || e);
    const init = { requests: [], userStats: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

// Track user book downloads for gamification
function trackUserDownload(userId) {
  if (!db.userStats) db.userStats = {};
  if (!db.userStats[userId]) {
    db.userStats[userId] = { downloads: 0, lastDownload: null };
  }
  db.userStats[userId].downloads += 1;
  db.userStats[userId].lastDownload = new Date().toISOString();
  saveDB(db);
  return db.userStats[userId].downloads;
}

function getUserMilestoneMessage(downloadCount) {
  const milestones = {
    1: `🎉 *First book downloaded!* You've taken the first step on an incredible journey!`,
    5: `🌟 *5 books downloaded!* You're building a great reading habit!`,
    10: `🔥 *10 books milestone!* You're on fire! Keep that momentum going!`,
    25: `⭐ *25 books!* You're officially a dedicated reader! Impressive!`,
    50: `💎 *50 books!* You're a reading champion! Knowledge is your superpower!`,
    100: `👑 *100 books!* You're a reading LEGEND! Absolutely phenomenal!`
  };
  return milestones[downloadCount] || null;
}

///////////////////////
// Google Sheets setup
///////////////////////
let sheetsClient, svcJson, jwt;
try {
  log('Parsing Google Service Account credentials...');
  svcJson = JSON.parse(Buffer.from(SA_BASE64, 'base64').toString('utf8'));
  log('Creating JWT client for:', svcJson.client_email);
  jwt = new google.auth.JWT(
  svcJson.client_email,
  null,
  svcJson.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
sheetsClient = google.sheets({ version: 'v4', auth: jwt });
  log('✅ Google Sheets client initialized');
} catch (e) {
  console.error('FATAL: Could not initialize Google Sheets client:', e.message || e);
  console.error('Stack:', e.stack);
  process.exit(1);
}

///////////////////////
// Telegram + Express
///////////////////////
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: DEV_MODE ? {
    interval: POLLING_INTERVAL,
    autoStart: true
  } : false
});
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
const waitingForMeta = {}; // For tracking admin metadata replies

///////////////////////
// Helper functions
///////////////////////
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function isValidDocumentType(mimeType) {
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'application/rtf',
    'application/epub+zip',
    'application/x-mobipocket-ebook'
  ];
  return allowedTypes.includes(mimeType);
}

function getLibraryStats() {
  const totalBooks = books.length;
  const withAuthors = books.filter(b => b.author && b.author.trim()).length;
  const withIds = books.filter(b => b.id && b.id.trim()).length;
  const uniqueAuthors = new Set(books.filter(b => b.author && b.author.trim()).map(b => b.author.toLowerCase())).size;
  return {
    totalBooks,
    withAuthors,
    withIds,
    uniqueAuthors,
    totalRequests: db.requests ? db.requests.length : 0
  };
}

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
      const rawFileId = r[3] || '';
      const file_id = safeFileId(rawFileId); // Use safeFileId for file_ids
      
      // Log warnings for potentially corrupted file_ids
      if (rawFileId !== file_id) {
        log(`⚠️ CLEANED file_id for "${title}": removed ${rawFileId.length - file_id.length} chars (newlines/spaces/control chars)`);
        log(`   Raw: "${rawFileId.substring(0, 50)}..." (length: ${rawFileId.length})`);
        log(`   Clean: "${file_id.substring(0, 50)}..." (length: ${file_id.length})`);
      }
      
      if (title && file_id) {
        parsed.push({ id, title, author, file_id });
        log(`✓ Loaded: ${title} | file_id length: ${file_id.length}`);
      } else if (title && !file_id) {
        log(`⚠️ Skipped "${title}": missing or invalid file_id`);
      }
    }
    books = parsed;
    fuse = new Fuse(books, { keys: ['title', 'author', 'id'], threshold: 0.35, includeScore: true });
    log('Loaded books from sheet:', books.length);
    return books.length;
  } catch (err) {
    log('loadSheet error:', err && err.message ? err.message : err);
    if (err.code === 403) {
      log('PERMISSION ERROR: Service account', svcJson.client_email, 'needs access to sheet', SHEET_ID);
      log('Share the Google Sheet with this email address and grant Editor permissions.');
    }
    throw err;
  }
}

async function appendRowToSheet(id, title, author, file_id) {
  try {
    const values = [[safeText(id || ''), safeText(title || ''), safeText(author || ''), safeFileId(file_id || '')]];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      resource: { values }
    });
    log('appendRow success:', title, '| file_id:', file_id, '| length:', file_id.length);
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
  const userName = msg.from.first_name || 'Reader';
  
  if (isAdm) {
    bot.sendMessage(chatId, `👋 Librarian — bot is online. Use /reload to refresh index, /validate to validate file_ids, or send a document with caption id|title|author to add a book.`);
  } else {
    bot.sendMessage(chatId, `📚 Welcome to DLCF Library, ${userName}!

🌟 *Your reading journey starts here*

"The more that you read, the more things you will know. The more that you learn, the more places you'll go." – Dr. Seuss

🔍 *Quick Start:*
• Simply type any book title or author name
• Or try these commands:
  /browse - Discover books by author
  /recent - See what's new
  /popular - Trending searches

💡 *Pro tip:* The best readers read daily. Even 10 pages a day adds up to 3,650 pages a year!

Don't just wish to be a reader – BE ONE! Type a book title now and start your transformation! 🚀`, { parse_mode: 'Markdown' });
  }
});

// /browse - Browse books with pagination
bot.onText(/\/browse/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (books.length === 0) {
    return bot.sendMessage(chatId, '📚 Library is empty. Check back later!');
  }
  
  // Get unique authors
  const authors = [...new Set(books.filter(b => b.author && b.author.trim()).map(b => b.author))].sort();
  
  if (authors.length === 0) {
    return bot.sendMessage(chatId, '📚 No authors available for browsing yet.');
  }
  
  // Show first 20 authors with inline keyboard
  const authorsToShow = authors.slice(0, 20);
  const keyboard = authorsToShow.map(author => [{
    text: `${author} (${books.filter(b => b.author === author).length} books)`,
    callback_data: `author:${author}`
  }]);
  
  bot.sendMessage(chatId, `📚 Browse by Author (showing ${authorsToShow.length} of ${authors.length}):\n\nClick an author to see their books:`, {
    reply_markup: { inline_keyboard: keyboard }
  });
});

// /recent - Show recently added books
bot.onText(/\/recent/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (books.length === 0) {
    return bot.sendMessage(chatId, '📚 Library is empty. Check back later!');
  }
  
  // Show last 15 books (assuming they're in order added)
  const recentBooks = books.slice(-15).reverse();
  const message = `🆕 **Recently Added Books:**\n\n${recentBooks.map((b, i) => 
    `${i + 1}. **${b.title}**\n   ${b.author ? `by ${b.author}` : 'Author unknown'}\n   ${b.id ? `ID: ${b.id}` : ''}`
  ).join('\n\n')}\n\n💡 Type any title to get the book!`;
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /popular - Show most requested books
bot.onText(/\/popular/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!db.requests || db.requests.length === 0) {
    return bot.sendMessage(chatId, '📊 No request data yet. Start searching for books!');
  }
  
  // Count request frequencies
  const queryCounts = {};
  db.requests.forEach(req => {
    const query = req.query.toLowerCase().trim();
    queryCounts[query] = (queryCounts[query] || 0) + 1;
  });
  
  // Get top 10 most requested
  const topRequests = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  if (topRequests.length === 0) {
    return bot.sendMessage(chatId, '📊 No popular searches yet.');
  }
  
  const message = `🔥 **Most Popular Searches:**\n\n${topRequests.map((([query, count], i) => 
    `${i + 1}. "${query}" - ${count} request${count > 1 ? 's' : ''}`
  )).join('\n')}\n\n💡 Try searching for any of these!`;
  
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /help - User help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const isAdm = isAdmin(msg.from.id);
  
  if (isAdm) {
    // Admin help (existing)
    const message = `🔧 Admin Commands:

📚 Library Management:
/start - Welcome message
/reload - Reload library from Google Sheets
/add id|title|author|file_id - Quick add book
/bulk-add - Instructions for bulk CSV upload

📊 Information:
/stats - Library statistics
/export - Export library as CSV
/search query - Detailed search with scores
/list - Show first 50 books

🔧 Maintenance:
/validate - Validate all file_ids
/cleanup - Find duplicate entries

📝 Adding Books:
1. Upload document with caption: id|title|author
2. Or upload document and reply with metadata
3. Use /add for quick command-line addition

💡 Tips:
• Use /stats to monitor library health
• /validate to check for broken file_ids
• /export to backup your library
• /cleanup to find duplicates`;

    bot.sendMessage(chatId, message);
  } else {
    // User help
    const message = `❓ **How to Use DLCF Library Bot**

🔍 **Search for Books:**
Just type the book title, author name, or book ID. Example:
• "Pride and Prejudice"
• "Jane Austen"
• "001"

📚 **Browse & Explore:**
/browse - Browse books by author
/recent - See recently added books
/popular - See what others are searching

📖 **Request Books:**
If a book isn't found, librarians are automatically notified and will add it if available!

💡 **Tips:**
• You can search partial titles or authors
• Search is fuzzy - typos are okay!
• Books are sent directly to you

Need more help? Contact the librarian!`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
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

// /stats (admin only) - show library statistics
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /stats.');
  
  const stats = getLibraryStats();
  const message = `📊 Library Statistics:
📚 Total Books: ${stats.totalBooks}
👤 Books with Authors: ${stats.withAuthors}
🏷️ Books with IDs: ${stats.withIds}
✍️ Unique Authors: ${stats.uniqueAuthors}
📝 Total Requests: ${stats.totalRequests}

📈 Coverage:
• Authors: ${((stats.withAuthors / stats.totalBooks) * 100).toFixed(1)}%
• IDs: ${((stats.withIds / stats.totalBooks) * 100).toFixed(1)}%`;

  bot.sendMessage(chatId, message);
});

// /export (admin only) - export library as CSV
bot.onText(/\/export/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /export.');
  
  if (books.length === 0) {
    return bot.sendMessage(chatId, 'No books to export.');
  }
  
  try {
    const csv = stringify(books, { header: true });
    const tmp = path.join(__dirname, `library-export-${Date.now()}.csv`);
    fs.writeFileSync(tmp, csv);
    
    await bot.sendMessage(chatId, `📁 Exporting ${books.length} books...`);
    await bot.sendDocument(chatId, fs.createReadStream(tmp));
    fs.unlinkSync(tmp);
  } catch (e) {
    log('export error:', e && e.message ? e.message : e);
    bot.sendMessage(chatId, `Export failed: ${e && e.message ? e.message : e}`);
  }
});

// /search query (admin only) - detailed search with results count
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /search.');
  
  const query = safeText(match[1].trim());
  const results = fuse.search(query);
  
  if (!results || results.length === 0) {
    return bot.sendMessage(chatId, `No results found for "${query}"`);
  }
  
  const topResults = results.slice(0, 10).map((r, i) => {
    const book = r.item;
    const score = r.score ? ` (${(r.score * 100).toFixed(1)}%)` : '';
    return `${i + 1}. ${book.title} — ${book.author || 'Unknown'}${score}`;
  }).join('\n');
  
  const message = `🔍 Search results for "${query}" (${results.length} found):
${topResults}${results.length > 10 ? `\n... and ${results.length - 10} more` : ''}`;
  
  bot.sendMessage(chatId, message);
});

// /bulk-add (admin only) - bulk add from CSV
bot.onText(/\/bulk-add/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /bulk-add.');
  
  bot.sendMessage(chatId, `📥 Bulk Add Instructions:
1. Send a CSV file with columns: id,title,author,file_id
2. First row should be headers
3. Use empty values for missing fields
4. Maximum 100 rows per upload

Example:
id,title,author,file_id
001,My Book,Author Name,BQADBAAD...
002,Another Book,,BQADBAAD...

⚠️ This will add ALL rows from the CSV to the library.`);
});

// /cleanup (admin only) - remove duplicate file_ids
bot.onText(/\/cleanup/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, 'Only admin can use /cleanup.');
  
  const duplicates = [];
  const seenFileIds = new Set();
  const seenTitles = new Set();
  
  books.forEach((book, index) => {
    if (seenFileIds.has(book.file_id)) {
      duplicates.push({ type: 'file_id', book, index });
    } else {
      seenFileIds.add(book.file_id);
    }
    
    const titleKey = book.title ? book.title.toLowerCase().trim() : '';
    if (titleKey && seenTitles.has(titleKey)) {
      duplicates.push({ type: 'title', book, index });
    } else if (titleKey) {
      seenTitles.add(titleKey);
    }
  });
  
  if (duplicates.length === 0) {
    return bot.sendMessage(chatId, '✅ No duplicates found!');
  }
  
  const message = `🔍 Found ${duplicates.length} potential duplicates:
${duplicates.slice(0, 10).map((dup, i) => {
  return `${i + 1}. [${dup.type}] ${dup.book.title} — ${dup.book.author || 'Unknown'}`;
}).join('\n')}${duplicates.length > 10 ? `\n... and ${duplicates.length - 10} more` : ''}

⚠️ Manual cleanup required. Use /export to get full list.`;
  
  bot.sendMessage(chatId, message);
});


// Handle CSV uploads for bulk operations
bot.on('document', async (msg) => {
  if (!msg.document || !isAdmin(String(msg.from.id))) return;
  
  const chatId = msg.chat.id;
  const mimeType = msg.document.mime_type || '';
  
  // Check if it's a CSV file
  if (mimeType === 'text/csv' || msg.document.file_name?.toLowerCase().endsWith('.csv')) {
    try {
      await bot.sendMessage(chatId, '📥 CSV file detected. Processing bulk add...');
      
      // Get file info and download
      const fileInfo = await bot.getFile(msg.document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      
      // In a real implementation, you'd download and parse the CSV here
      // For now, just acknowledge the upload
      bot.sendMessage(chatId, `📊 CSV file received (${msg.document.file_name})
      
⚠️ CSV processing not fully implemented yet.
Please use individual /add commands or upload documents with captions.

File info:
• Size: ${msg.document.file_size} bytes
• Type: ${mimeType}
• Name: ${msg.document.file_name}`);
      
    } catch (e) {
      log('CSV processing error:', e && e.message ? e.message : e);
      bot.sendMessage(chatId, `CSV processing failed: ${e && e.message ? e.message : e}`);
    }
  }
});

// callback query handler (inline button)
bot.on('callback_query', async (cq) => {
  try {
    const fromId = String(cq.from && cq.from.id);
    const data = cq.data || '';
    
    // Handle author browsing (available to all users)
    if (data.startsWith('author:')) {
      const author = data.substring(7);
      const authorBooks = books.filter(b => b.author === author);
      
      if (authorBooks.length === 0) {
        return bot.answerCallbackQuery(cq.id, { text: 'No books found for this author.' });
      }
      
      const message = `📚 **Books by ${author}:**\n\n${authorBooks.slice(0, 20).map((b, i) => 
        `${i + 1}. ${b.title}${b.id ? ` (ID: ${b.id})` : ''}`
      ).join('\n')}${authorBooks.length > 20 ? `\n\n... and ${authorBooks.length - 20} more` : ''}\n\n💡 Type any title to get the book!`;
      
      try {
        await bot.sendMessage(cq.message.chat.id, message, { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(cq.id, { text: `Found ${authorBooks.length} books` });
      } catch (e) {
        return bot.answerCallbackQuery(cq.id, { text: 'Failed to load books' });
      }
    }
    
    // Admin-only actions
    if (!isAdmin(fromId)) {
      return bot.answerCallbackQuery(cq.id, { text: 'Only admins can use this.' });
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
      const rawFileId = msg.document.file_id;
      const file_id = safeFileId(rawFileId); // Use safeFileId
      const mimeType = msg.document.mime_type || '';
      const caption = safeText(msg.caption || '');
      
      log('📤 Admin uploaded document:', msg.document.file_name);
      log('   Raw file_id length:', rawFileId ? rawFileId.length : 0);
      log('   Clean file_id length:', file_id.length);
      if (rawFileId !== file_id) {
        log('   ⚠️ file_id was cleaned (removed', (rawFileId ? rawFileId.length : 0) - file_id.length, 'chars)');
      }
      log('   Clean file_id:', file_id);
      
      // validate file type
      if (!isValidDocumentType(mimeType)) {
        return bot.sendMessage(chatId, `❌ Unsupported file type: ${mimeType}\n\nAllowed types: PDF, Word docs, Excel, PowerPoint, text files, EPUB, MOBI`);
      }
      
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
          return bot.sendMessage(chatId, `✅ Saved "${title}" to library.`);
        } catch (e) {
          log('appendRow error for admin upload:', e && e.message ? e.message : e);
          return bot.sendMessage(chatId, `Failed to save "${title}": ${e && e.message ? e.message : 'unknown error'}`);
        }
      } else {
        // ask for metadata
        waitingForMeta[chatId] = { file_id, mimeType };
        return bot.sendMessage(chatId, `📄 File type: ${mimeType}\nPlease reply with metadata in this format: id|title|author`, { reply_markup: { force_reply: true } });
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
        
        // tell user with motivating message
        if (isAdmin(fromId)) {
          await bot.sendMessage(chatId, `No match found for "${query}". Librarian notified — send the file to add it.`);
        } else {
          await bot.sendMessage(chatId, `📖 Great question! I couldn't find "${query}" in our library *yet*.

🔔 Good news! The librarians have been notified and will add it soon if available.

💡 *Meanwhile:*
Try /browse to discover other amazing books
Try /recent to see newly added titles
Try /popular to see what others are reading

Remember: "A reader lives a thousand lives before he dies. The man who never reads lives only one." – George R.R. Martin

Keep that reading spirit alive! 🔥`, { parse_mode: 'Markdown' });
        }
        
        // notify admins
        await notifyAdminsAboutRequest(req).catch(e => log('notifyAdminsAboutRequest error:', e && e.message ? e.message : e));
        return;
      }

      // we have results
      const best = results[0].item;
      
      log('🔍 Book found:', best.title, '| file_id:', best.file_id, '| length:', best.file_id.length, '| requesting user:', fromId);
      
      // Validate file_id format before sending (basic sanity check)
      if (!best.file_id || best.file_id.length < 10) {
        log('❌ Invalid file_id detected:', best.file_id);
        await bot.sendMessage(chatId, `📚 Found "${best.title}" but the file reference is invalid. Librarian has been notified.`);
        const failureNotice = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''}`).trim(),
          query: `❌ INVALID file_id: "${best.title}" (ID: ${best.id || 'N/A'})\nfile_id: "${best.file_id}"\nfile_id length: ${best.file_id.length}`,
          time: new Date().toISOString()
        };
        await notifyAdminsAboutRequest(failureNotice);
        return;
      }
      
      // Check for any remaining whitespace that shouldn't be there
      if (/\s/.test(best.file_id)) {
        log('⚠️ WARNING: file_id contains whitespace! This will likely fail:', best.file_id);
      }
      
      // send the document
      try {
        // Motivating messages for users
        if (isAdmin(fromId)) {
          await bot.sendMessage(chatId, `📗 Found: ${best.title}\nID: ${best.id || '-'}\nAuthor: ${best.author || '-'}\nSending file...`);
        } else {
          // Engaging, motivating message for regular users
          const motivationalMessages = [
            `🌟 Excellent choice! "${best.title}" by ${best.author || 'a great author'} is on its way!`,
            `📚 Great taste! Sending "${best.title}" right now. Happy reading!`,
            `✨ Found it! "${best.title}" is yours. Time to dive into a new world!`,
            `🎯 Perfect! "${best.title}" by ${best.author || 'an amazing author'}. Your reading journey begins now!`,
            `📖 Wonderful! "${best.title}" awaits. Let knowledge illuminate your path!`,
          ];
          const randomMsg = motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];
          await bot.sendMessage(chatId, randomMsg);
        }
        
        log('📤 Attempting to send document with file_id:', best.file_id);
        await bot.sendDocument(chatId, best.file_id);
        log('✅ Successfully sent:', best.title, 'to user', fromId);
        
        // Track download and check for milestones (gamification)
        if (!isAdmin(fromId)) {
          const downloadCount = trackUserDownload(fromId);
          const milestoneMsg = getUserMilestoneMessage(downloadCount);
          
          // Send milestone achievement
          if (milestoneMsg) {
            setTimeout(async () => {
              try {
                await bot.sendMessage(chatId, milestoneMsg, { parse_mode: 'Markdown' });
              } catch (e) {
                // Silent fail
              }
            }, 1500);
          } else {
            // Send regular motivational follow-up
            setTimeout(async () => {
              const followUps = [
                `💭 "A room without books is like a body without a soul." - Cicero\n\n📚 Books downloaded: ${downloadCount}`,
                `🌱 Every page you read plants a seed of knowledge. Keep growing!\n\n📊 Your progress: ${downloadCount} books`,
                `⏰ Remember: The best time to read was yesterday. The second best time is now!\n\n🎯 Books so far: ${downloadCount}`,
                `🔥 You're building your reading habit! Keep it up!\n\n📈 Total downloads: ${downloadCount}`,
                `💡 Knowledge is power. You've just powered up!\n\n⚡ Power level: ${downloadCount} books`
              ];
              try {
                await bot.sendMessage(chatId, followUps[Math.floor(Math.random() * followUps.length)]);
              } catch (e) {
                // Silent fail for follow-up
              }
            }, 2000);
          }
        }
      } catch (err) {
        log('❌ sendDocument FAILED for', best.title);
        log('   file_id:', best.file_id);
        log('   file_id length:', best.file_id.length);
        log('   error:', err);
        log('   error message:', err && err.message ? err.message : 'unknown');
        log('   error code:', err && err.code ? err.code : 'no code');
        log('   error response:', err && err.response ? err.response : 'no response');
        
        const errmsg = (err && err.message) ? err.message : 'unknown';
        
        // User-friendly, encouraging error message
        await bot.sendMessage(chatId, `📚 Found "${best.title}" but there's a temporary issue sending it.\n\n😊 Don't worry! The librarian has been notified and will fix this quickly.\n\n💪 Your thirst for knowledge is admirable! Try another book while we sort this out.`);
        
        // Notify admins with comprehensive details
        const failureNotice = {
          userId: fromId,
          userName: (msg.from.username || `${msg.from.first_name || ''}`).trim(),
          query: `❌ SEND FAILED: "${best.title}" (ID: ${best.id || 'N/A'})\nfile_id: ${best.file_id}\nfile_id length: ${best.file_id.length}\nError: ${errmsg}`,
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
  
  // Setup webhook or polling
  if (DEV_MODE) {
    log('✅ Development mode: Using polling instead of webhooks');
  } else {
    const webhookUrl = `${BASE_URL.replace(/\/$/, '')}/webhook/${BOT_TOKEN}`;
    log('⚠️ Webhook URL:', webhookUrl);
    log('⚠️ Note: Due to Node.js 24 compatibility issues, you may need to set the webhook manually:');
    log(`   curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" -d "url=${webhookUrl}"`);
    log('⚠️ Or use Telegram Bot API directly or downgrade to Node.js 18 LTS');
  }
  
  // Set bot commands for auto-suggestions
  try {
    await bot.setMyCommands([
      { command: 'start', description: '🏠 Start the bot and see welcome message' },
      { command: 'browse', description: '📚 Browse books by category' },
      { command: 'recent', description: '🆕 Show recently added books' },
      { command: 'popular', description: '🔥 Show most requested books' },
      { command: 'help', description: '❓ Get help and usage tips' }
    ]);
    log('✅ Bot commands menu set successfully');
  } catch (e) {
    log('⚠️ Failed to set bot commands:', e && e.message ? e.message : e);
  }
  
  // Initial sheet load (non-fatal)
  log('Loading library from Google Sheets...');
  try {
    const count = await loadSheet();
    log('✅ Bot ready! Loaded', count, 'books from library.');
  } catch (e) {
    log('⚠️ Initial loadSheet error (bot will continue but library is empty):', e && e.message ? e.message : e);
    if (e.code === 403) {
      log('⚠️ PERMISSION ERROR: Share the Google Sheet with:', svcJson.client_email);
    }
    log('⚠️ Use /reload command to retry loading the sheet after fixing permissions.');
  }
  
  log('='.repeat(60));
  log('🚀 DLCF Library Bot is running!');
  log('   Mode:', DEV_MODE ? 'Development (Polling)' : 'Production (Webhook)');
  log('   Port:', PORT);
  log('   Books loaded:', books.length);
  log('='.repeat(60));
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  log('❌ UNCAUGHT EXCEPTION:', err && err.message ? err.message : err);
  log('Stack:', err && err.stack ? err.stack : 'No stack trace');
  log('⚠️ Bot will continue running...');
});

process.on('unhandledRejection', (reason, promise) => {
  log('❌ UNHANDLED REJECTION:', reason);
  log('⚠️ Bot will continue running...');
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

