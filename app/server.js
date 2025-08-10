import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import { Client as PG } from "pg";
import Redis from "ioredis";

const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_APP_URL,
  DAILY_DIGEST_CHAT_ID,
  DATABASE_URL,
  VALKEY_URL,
  OPENAI_API_KEY
} = process.env;

const app = express();
app.use(bodyParser.json());

// DB & cache
const pg = new PG({ connectionString: DATABASE_URL });
pg.connect().catch(console.error);
const redis = new Redis(VALKEY_URL);

// تلگرام
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// وبهوک تلگرام
app.post("/api/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg) return res.status(200).end();

    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    if (text.startsWith("/newcontent")) {
      // ورودی ساده: /newcontent تیتر محتوا...
      const title = text.replace("/newcontent", "").trim() || "بدون عنوان";
      await pg.query(
        "INSERT INTO content_items (title) VALUES ($1)",
        [title]
      );
      await bot.sendMessage(chatId, `✅ محتوا ثبت شد: ${title}`);
    } else if (text === "/id") {
      await bot.sendMessage(chatId, `Chat ID: ${chatId}`);
    } else {
      await bot.sendMessage(chatId, "دستور دریافت شد ✅ ( /newcontent یا /id )");
    }

    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(200).end();
  }
});

// دایجست روزانه
app.get("/api/digest", async (req, res) => {
  try {
    const { rows } = await pg.query(
      `SELECT t.id, t.title, t.due, COALESCE(p.name,'Unassigned') assignee
       FROM tasks t
       LEFT JOIN people p ON p.id = t.assignee_id
       WHERE t.status IN ('todo','in_progress') AND t.due = CURRENT_DATE
       ORDER BY assignee, t.id`
    );

    const lines = rows.length
      ? rows.map(r => `• [${r.assignee}] ${r.title} — ${r.due}`).join("\n")
      : "امروز تسکی ثبت نشده.";

    const to = DAILY_DIGEST_CHAT_ID;
    if (to) await bot.sendMessage(to, `🗓 گزارش امروز:\n${lines}`);

    res.json({ sent: Boolean(to), count: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "digest_failed" });
  }
});

// --- جایگزین ensureSchema قبلی کن ---
async function ensureSchema() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS people (
      id serial PRIMARY KEY,
      name text NOT NULL,
      role text,
      telegram_id bigint,
      username text UNIQUE,
      created_at timestamptz DEFAULT NOW()
    );
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='task_status') THEN
        CREATE TYPE task_status AS ENUM ('todo','in_progress','done','blocked');
      END IF;
    END$$;
    CREATE TABLE IF NOT EXISTS content_items (
      id serial PRIMARY KEY,
      title text NOT NULL,
      created_at timestamptz DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id serial PRIMARY KEY,
      title text NOT NULL,
      content_id int REFERENCES content_items(id) ON DELETE SET NULL,
      assignee_id int REFERENCES people(id) ON DELETE SET NULL,
      due date,
      status task_status DEFAULT 'todo',
      description text,
      instructions text,
      created_at timestamptz DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS task_refs (
      id serial PRIMARY KEY,
      task_id int NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      url text NOT NULL,
      caption text,
      created_at timestamptz DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id int NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      requires_task_id int NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at timestamptz DEFAULT NOW(),
      PRIMARY KEY(task_id, requires_task_id),
      CHECK (task_id <> requires_task_id)
    );
  `);
}


app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`App listening on :${PORT} — ${PUBLIC_APP_URL || "no-domain"}`);
});
