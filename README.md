# Telegram Bot v2 — Teaching Channel Companion

Production-ready Node.js / Express Telegram webhook bot with:

- **Supabase PostgreSQL** for users, referrals, feedback, and resources
- **Telegram `file_id` delivery** (no local disk reads at runtime)
- **Invisible referral competition** (admin-only stats)
- **Reply keyboard UX** with legacy slash-command support
- **Koyeb-ready** deployment

---

## Folder structure

```text
TelegramBot/
├── Documents/                  # Local PDFs — seed only (not used at runtime)
├── Images/                     # Local image — seed only
├── migrations/
│   └── 001_initial_schema.sql
├── scripts/
│   └── seed-resources.js       # One-time upload → store file_ids
├── src/
│   ├── bot/
│   │   ├── commands/
│   │   ├── handlers/
│   │   └── keyboards/
│   ├── config/
│   │   └── env.js
│   ├── database/
│   │   └── supabase.js
│   ├── services/
│   │   ├── admin.js
│   │   ├── feedback.js
│   │   ├── referrals.js
│   │   ├── resources.js
│   │   ├── telegram.js
│   │   └── users.js
│   ├── utils/
│   │   ├── errors.js
│   │   ├── logger.js
│   │   └── session.js
│   └── server.js
├── .env.example
├── index.js                    # Thin re-export of src/server.js
├── package.json
└── README.md
```

---

## What changed (major upgrades)

| Area | Before | After |
|------|--------|-------|
| Structure | Single `index.js` | Layered `src/` architecture |
| Storage | Local disk + in-memory file_id cache | Supabase `resources.telegram_file_id` |
| Feedback | `/feedback text` only | Button flow + legacy command + DB + admin notify |
| UX | Commands only | Reply keyboard + commands |
| Referrals | None | Deep-link + channel verify + admin stats |
| Reliability | Minimal | Retries, logging, env validation, graceful shutdown |
| Database | None | Supabase Postgres |

---

## Environment variables

Copy `.env.example` → `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `TOKEN` | ✅ | Bot token from @BotFather |
| `SERVER_URL` | ✅ | Public HTTPS URL (Koyeb), no trailing slash |
| `ADMIN_CHAT_ID` | ✅ | Your Telegram numeric ID |
| `PORT` | ✅* | HTTP port (`5000` local; Koyeb injects `PORT`) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (server only) |
| `CHANNEL_ID` | ✅ | Channel ID (`-100…`) or `@username` — bot must be admin |
| `BOT_USERNAME` | ✅ | Bot username without `@` |
| `CHANNEL_INVITE_LINK` | ⬜ | Public invite URL shown on join button |
| `NODE_ENV` | ⬜ | `production` / `development` |
| `LOG_LEVEL` | ⬜ | `error` / `warn` / `info` / `debug` |

---

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with real values

# 3. Create tables in Supabase
# Open Supabase → SQL Editor → paste migrations/001_initial_schema.sql → Run

# 4. Seed Telegram file_ids (uploads local files once to your ADMIN chat)
npm run seed

# 5. Run locally
npm run dev
# or
npm start
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
📚 Soft Copies     📅 Ders Program
🔗 Competition Link   💬 Feedback
```

### Competition link message

Users see **only** their invitation link — never points, ranks, or counts.

### Referral flow

1. User A shares `https://t.me/BOT_USERNAME?start=USER_A_ID`
2. User B opens the link → bot records **unverified** referral
3. Bot asks B to join the channel → **✅ I Joined**
4. Bot calls `getChatMember` → if member, marks referral **verified**
5. Self-referrals and duplicate referred users are rejected

### Admin commands (only `ADMIN_CHAT_ID`)

| Command | Purpose |
|---------|---------|
| `/admin_stats` | Total users, referrals, verified, feedbacks |
| `/admin_top` | Top referrers by verified count |
| `/admin_user <telegram_id>` | Single user report |
| `/admin_broadcast <message>` | Message all known users |

Legacy commands still work: `/start`, `/ders_program`, `/soft_copies`, `/feedback`, `/competition`.

---

## Deployment on Koyeb

### 1. Prepare Supabase

1. Create a Supabase project
2. Run `migrations/001_initial_schema.sql` in the SQL Editor
3. Copy **Project URL** and **service_role** key

### 2. Prepare Telegram

1. Create bot via @BotFather → copy token
2. Add bot as **administrator** of the teaching channel
3. Get channel ID (forward a channel post to `@userinfobot` or use API)
4. Note your personal chat ID for `ADMIN_CHAT_ID`

### 3. Deploy on Koyeb

1. Push this repo to GitHub
2. Koyeb → **Create App** → import the repo
3. Build/run settings:
   - **Build command:** `npm install`
   - **Run command:** `npm start`
   - **Instance:** Web service, port from `PORT` env
4. Set all environment variables from the table above  
   `SERVER_URL` = your Koyeb public HTTPS URL (e.g. `https://xxx.koyeb.app`)
5. Deploy

### 4. Seed resources

After the first successful deploy (or from a machine with the files + env):

```bash
npm run seed
```

The seed script uploads files to Telegram and writes `file_id`s into Supabase.  
You can run it from your local machine against production Supabase — files do **not** need to be on Koyeb after seeding.

### 5. Verify

- Open `https://your-app.koyeb.app/health` → `{ "status": "healthy" }`
- Message the bot `/start` → main keyboard appears
- Test Soft Copies / Ders Program
- Test Competition Link + referral deep link
- Run `/admin_stats` from the admin account

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

No `fs.createReadStream` on the hot path.

### Telegram retries

`src/services/telegram.js` retries on `429`, `5xx`, and network errors with exponential backoff / `retry_after`.

### Sessions

Feedback multi-step flow uses an in-memory session map (`src/utils/session.js`).  
Fine for a single Koyeb instance. For multi-instance, swap to Redis.

### Graceful shutdown

`SIGTERM` / `SIGINT` close the HTTP server and clear sessions so Koyeb deploys do not drop mid-request sockets abruptly.

---

## SQL schema (summary)

- `users` — telegram identity + channel flag  
- `referrals` — referrer/referred, unique referred, verified flag  
- `feedbacks` — stored messages  
- `resources` — name, type (`pdf`|`image`), `telegram_file_id`  
- `referral_leaderboard` — admin convenience view  

---

## Security notes

- Never commit `.env`
- Use **service_role** only on the server
- Webhook path includes the bot token (Telegram standard); keep `SERVER_URL` HTTPS
- Admin commands are chat-ID gated and omitted from the public command menu

---

## Scripts

| Script | Command |
|--------|---------|
| Start | `npm start` |
| Dev (nodemon) | `npm run dev` |
| Seed file_ids | `npm run seed` |
