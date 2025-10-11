# DLCF Library Bot

A Telegram bot for managing and searching a digital library, integrated with Google Sheets.

## Features

### For Users
- **Search Library**: Type any title, author, or book ID to search
- **Auto-Request**: If a book isn't found, librarians are automatically notified
- **Instant Delivery**: Books are sent directly via Telegram

### For Admins
- **Easy Upload**: Send documents with captions `id|title|author` to add books
- **Comprehensive Statistics**: `/stats` command shows library health
- **Export Library**: `/export` generates CSV backup
- **Advanced Search**: `/search query` shows detailed results with scores
- **Validation**: `/validate` checks all stored file IDs
- **Duplicate Detection**: `/cleanup` finds duplicate entries
- **File Type Validation**: Only accepts PDFs, Word docs, EPUB, MOBI, etc.

## Quick Start

### Prerequisites
- Node.js 18+ (tested on Node.js 24)
- Telegram Bot Token
- Google Service Account with Sheets API access
- Google Sheet with format: `id | title | author | file_id`

### Installation

```bash
# Install dependencies
pnpm install

# Configure environment variables (see .env.example below)
cp .env.example .env
# Edit .env with your credentials

# Start in production mode
pnpm start

# Or start in development mode (with polling instead of webhooks)
pnpm dev
```

### Environment Variables

Create a `.env` file:

```env
# Telegram Bot Token from @BotFather
BOT_TOKEN=your_bot_token_here

# Comma-separated list of admin Telegram user IDs
ADMIN_IDS=123456789,987654321

# Google Sheet ID (from the sheet URL)
SHEET_ID=your_sheet_id_here

# Base64-encoded Google Service Account JSON
GOOGLE_SERVICE_ACCOUNT_BASE64=your_base64_encoded_json_here

# Public URL for webhooks (production only)
BASE_URL=https://your-app.onrender.com

# Optional: Development mode (uses polling instead of webhooks)
DEV_MODE=false

# Optional: Polling interval in milliseconds (dev mode only)
POLLING_INTERVAL=1000

# Optional: Port for Express server
PORT=3000
```

### Google Sheets Setup

1. Create a Google Sheet with columns: `id`, `title`, `author`, `file_id`
2. Share the sheet with your service account email (found in your service account JSON)
3. Grant "Editor" permissions

## Admin Commands

### Library Management
- `/start` - Welcome message and bot status
- `/reload` - Reload library from Google Sheets
- `/add id|title|author|file_id` - Quick add a book
- `/bulk-add` - Instructions for bulk CSV upload

### Information & Analytics
- `/stats` - Show comprehensive library statistics
- `/export` - Export library as CSV file
- `/search query` - Detailed search with match scores
- `/list` - Show first 50 books

### Maintenance
- `/validate` - Validate all file_ids (generates CSV report for invalid ones)
- `/cleanup` - Find duplicate entries by file_id or title
- `/help` - Show all available commands

### Adding Books

**Method 1**: Upload document with caption
```
Upload a PDF/EPUB/etc with caption: 001|My Book Title|Author Name
```

**Method 2**: Upload then reply with metadata
```
1. Upload document (no caption)
2. Bot asks for metadata
3. Reply with: 001|My Book Title|Author Name
```

**Method 3**: Command line
```
/add 001|My Book Title|Author Name|TELEGRAM_FILE_ID
```

## Development

### Project Structure
```
dlcf-library-bot/
├── index.js           # Main bot application
├── package.json       # Dependencies and scripts
├── db.json           # Local database for user requests
├── .env              # Environment variables (create this)
└── README.md         # This file
```

### Key Features Implemented
- ✅ Fuzzy search using Fuse.js
- ✅ File type validation
- ✅ Duplicate detection
- ✅ Rate limiting (1 request/second per user)
- ✅ Admin-only commands
- ✅ Request tracking and notifications
- ✅ Health check endpoint
- ✅ Graceful error handling
- ✅ Development mode with polling
- ✅ Production mode with webhooks
- ✅ Google Sheets integration
- ✅ CSV export/import framework

### API Endpoints
- `GET /health` - Health check (returns `{ok: true, uptime: seconds, books: count}`)
- `POST /webhook/{BOT_TOKEN}` - Telegram webhook receiver

## Deployment

### Render.com
1. Connect your GitHub repository
2. Set environment variables in Render dashboard
3. Deploy as a Web Service
4. Bot will automatically set webhook on startup

### Other Platforms
- Ensure `BASE_URL` points to your public domain
- Set all environment variables
- The bot will handle webhook setup automatically

## Troubleshooting

### Bot doesn't start
- Check all environment variables are set correctly
- Verify Google Service Account has access to the sheet
- Check logs for specific error messages

### Webhook issues on Node.js 24
- Use development mode (`DEV_MODE=true`) locally
- Or manually set webhook:
  ```bash
  curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
    -d "url=https://your-app.com/webhook/<TOKEN>"
  ```

### Books not loading
- Verify service account email has Editor access to the sheet
- Check sheet format: Column A=id, B=title, C=author, D=file_id
- Use `/reload` command to retry loading

### File IDs invalid
- Run `/validate` to check all file IDs
- File IDs can expire if the bot was removed and re-added
- Re-upload invalid files

## License

MIT License - Feel free to use and modify!

## Support

For issues or questions, contact your system administrator.
