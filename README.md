# Telegram Bot — Teaching Channel Companion

Production-ready Node.js / Express Telegram webhook bot deployed on **Render**.

Features:
- **Supabase PostgreSQL** for users, referrals, feedback, and resources
- **Telegram `file_id` delivery** (no local disk reads at runtime)
- **Invisible referral competition** with hybrid automatic verification
- **Admin inline panel** (`/admin`) for full bot management from Telegram
- **Reply keyboard UX** with legacy slash-command support
- **Background cron** for automatic referral verification every 20 minutes

---

## Folder structure

```text
TelegramBot/
├── Documents/                  # Local PDFs — seed only, NOT used at runtime
├── Images/                     # Local image — seed only, NOT used at runtime
├── migrations/
│   ├── 001_initial_schema.sql  # Core tables — REQUIRED
│   ├── 002_admin_panel.sql     # Adds is_active + updated_at to resources
│   ├── 003_referral_tracking.sql  # Adds last_checked_at + check_attempts
│   └── 004_leaderboard.sql     # Upgrades referral_leaderboard view
├── scripts/
│   └── seed-resources.js       # One-time upload → stores file_ids in Supabase
├── src/
│   ├── bot/
│   │   ├── commands/index.js   # Public command definitions
│   │   ├── handlers/
│   │   │   ├── index.js        # Main router
│   │   │   ├── start.js
│   │   │   ├── resources.js
│   │   │   ├── competition.js
│   │   │   ├── feedback.js
│   │   │   ├── referral.js
│   │   │   ├── admin.js        # Legacy /admin_* commands
│   │   │   └── adminPanel.js   # Inline /admin panel
│   │   └── keyboards/
│   │       ├── mainMenu.js
│   │       ├── channelJoin.js
│   │       └── adminPanel.js
│   ├── config/env.js
│   ├── database/supabase.js
│   ├── services/
│   │   ├── admin.js
│   │   ├── adminPanel.js
│   │   ├── feedback.js
│   │   ├── referrals.js
│   │   ├── referralCron.js     # Background verification scheduler
│   │   ├── resources.js
│   │   ├── telegram.js
│   │   └── users.js
│   ├── utils/
│   │   ├── adminSession.js
│   │   ├── errors.js
│   │   ├── logger.js
│   │   ├── session.js
│   │   ├── userFeedback.js     # Loading UX helper
│   │   └── userOperationLock.js # Duplicate-click protection
│   └── server.js
├── .env.example
├── index.js                    # Thin re-export of src/server.js
└── package.json
```

---

## Environment variables

Copy `.env.example` → `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `TOKEN` | ✅ | Bot token from @BotFather |
| `SERVER_URL` | ✅ | Public HTTPS Render URL, no trailing slash |
| `ADMIN_CHAT_ID` | ✅ | Your Telegram numeric ID (bot admin) |
| `PORT` | ✅* | HTTP port (Render injects `PORT`; default `5000` locally) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (server only — never expose) |
| `CHANNEL_ID` | ✅ | Channel numeric ID (`-100…`) — bot must be admin |
| `BOT_USERNAME` | ✅ | Bot username without `@` |
| `CHANNEL_INVITE_LINK` | ⬜ | Public invite URL shown on join button |
| `NODE_ENV` | ⬜ | `production` / `development` |
| `LOG_LEVEL` | ⬜ | `error` / `warn` / `info` / `debug` (default: `info`) |

---

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with real values

# 3. Apply migrations in Supabase
# Open Supabase → SQL Editor → run each migration in order:
#   migrations/001_initial_schema.sql   ← required before first run
#   migrations/002_admin_panel.sql      ← required for admin resource CRUD
#   migrations/003_referral_tracking.sql  ← optional tracking columns
#   migrations/004_leaderboard.sql      ← required for enhanced leaderboard

# 4. Seed Telegram file_ids (uploads local files once to your admin chat)
npm run seed

# 5. Run locally
npm run dev   # nodemon (auto-restart)
# or
npm start     # production
```

### Force re-upload of all resources

```bash
# Windows PowerShell
$env:FORCE_RESEED="1"; node scripts/seed-resources.js

# Linux / macOS
FORCE_RESEED=1 node scripts/seed-resources.js
```

---

## User interface

### Main menu (reply keyboard)

```text
📚 Soft Copies (PDFs)     📅 Ders Program
🔗 Competition Link        💬 Feedback
```

### Referral flow

1. User A presses **Competition Link** → gets `https://t.me/BOT?start=USER_A_ID`
2. User B opens link → bot records **unverified** referral
3. Bot shows channel join button → B joins channel
4. Verification happens automatically via:
   - **Layer 1** — B presses **✅ I Joined** button
   - **Layer 2** — B sends any message → transparent background check
   - **Layer 3** — Background cron runs every 20 minutes
5. Once verified, referrer A gets exactly one verified count (idempotent)
6. Self-referrals and duplicate referred users are rejected by the database

### Admin panel (`/admin`)

Full inline panel for the configured `ADMIN_CHAT_ID`. Features:
- **Resource management** — add / rename / remove PDFs, update Ders Program image
- **Broadcast** — text, photo, or document to all users
- **Competition** — top referrers (paginated), participant search, CSV export
- **Statistics** — users, referrals, feedback, leader
- **Settings** (expandable)

### Legacy admin commands (still work)

| Command | Purpose |
|---------|---------|
| `/admin_stats` | Total users, referrals, verified, feedbacks |
| `/admin_top` | Top referrers by verified count |
| `/admin_user <id>` | Single user report |
| `/admin_broadcast <msg>` | Broadcast to all users |

Public slash commands: `/start`, `/ders_program`, `/soft_copies`, `/feedback`, `/competition`

---

## Deployment on Render

### 1. Prepare Supabase

1. Create a Supabase project
2. Run migrations 001–004 in the SQL Editor (001 is required; 002–004 add features)
3. Copy **Project URL** and **service_role** key

### 2. Prepare Telegram

1. Create bot via @BotFather → copy token
2. Add bot as **administrator** of the teaching channel
3. Get channel numeric ID (forward a channel post to `@userinfobot` or use the API)
4. Note your personal Telegram chat ID for `ADMIN_CHAT_ID`

### 3. Deploy on Render

1. Push this repo to GitHub
2. Render → **New Web Service** → connect the repo
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node
4. Set all environment variables from the table above
   `SERVER_URL` = your Render public HTTPS URL (e.g. `https://your-app.onrender.com`)
5. Deploy

### 4. Seed resources

After first successful deploy (or from a local machine with `.env` and the files):

```bash
npm run seed
```

The seed script uploads files to Telegram and stores `file_id`s in Supabase.
Files do **not** need to be present on the Render server after seeding.

### 5. Verify

- Open `https://your-app.onrender.com/health` → `{ "status": "healthy" }`
- Message the bot `/start` → main keyboard appears
- Test Soft Copies, Ders Program, Competition Link
- Send `/admin` from the admin account → inline panel opens
- Check Render logs for: `Referral verification scheduler started`

---

## Architecture notes

### Resource delivery

```text
[User taps Soft Copies]
        ↓
 resources service → SELECT * FROM resources WHERE type='pdf'
        ↓
 telegram.sendDocument(chat_id, telegram_file_id)
```

No `fs.createReadStream` on the hot path. All runtime delivery uses stored `file_id`s.

### Referral verification (hybrid)

```text
Layer 1: User presses "✅ I Joined"  ─┐
Layer 2: Any incoming message        ─┼─→ autoVerifyReferral() → Supabase
Layer 3: Cron every 20 minutes       ─┘
```

All three paths share the same idempotent verification function with a
`.eq('verified', false)` database guard — no double-counting is possible.

### Telegram retries

`src/services/telegram.js` retries on `429`, `5xx`, and network errors with
exponential backoff / `retry_after`.

### Sessions (in-memory)

Feedback multi-step flow uses an in-memory session map (`src/utils/session.js`).
Fine for a single Render instance. For multi-instance, replace with Redis.

### Duplicate-click protection

`src/utils/userOperationLock.js` provides per-user, per-operation locks.
Locks are always released in `finally` blocks and cannot get permanently stuck.

### Graceful shutdown

`SIGTERM` / `SIGINT` close the HTTP server, clear sessions, and stop the cron job
so Render deploys do not drop mid-request connections abruptly.

---

## SQL schema (summary)

| Table | Purpose |
|-------|---------|
| `users` | Telegram identity + channel membership flag |
| `referrals` | Referrer/referred pairs, unique constraint, verified flag |
| `feedbacks` | User feedback messages |
| `resources` | `telegram_file_id` registry for PDFs and images |

View: `referral_leaderboard` — aggregated competition stats (updated by migration 004)

---

## Security notes

- Never commit `.env`
- Use **service_role key** only server-side — never expose to users
- Webhook path includes the bot token (Telegram standard); keep `SERVER_URL` HTTPS
- Admin panel is gated by `ADMIN_CHAT_ID` — a normal user constructing an `ap:*`
  callback manually receives a silent "Not authorized" response
- User scores and referral ranks are never shown to regular users
