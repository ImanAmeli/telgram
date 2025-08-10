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

// Helpers
async function findUserByUsername(username) {
  if (!username) return null;
  const clean = username.replace(/^@/, '').trim();
  const q = await pg.query('SELECT * FROM people WHERE username=$1', [clean]);
  return q.rows[0] || null;
}

// Create task
app.post("/api/task", async (req, res) => {
  try {
    const { title, due, assignee_username, description, instructions, refs, prereq_ids } = req.body || {};
    if (!title) return res.status(400).json({ error: "title_required" });

    let assignee_id = null;
    if (assignee_username) {
      const u = await findUserByUsername(assignee_username);
      if (u) assignee_id = u.id;
    }

    const ins = await pg.query(
      `INSERT INTO tasks(title, due, assignee_id, description, instructions)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [title, due || null, assignee_id, description || null, instructions || null]
    );
    const taskId = ins.rows[0].id;

    if (Array.isArray(refs)) {
      for (const r of refs) {
        if (r?.url) {
          await pg.query(`INSERT INTO task_refs(task_id, url, caption) VALUES ($1,$2,$3)`, [taskId, r.url, r.caption || null]);
        }
      }
    }
    if (Array.isArray(prereq_ids)) {
      for (const pid of prereq_ids) {
        if (pid && Number.isInteger(pid)) {
          await pg.query(`INSERT INTO task_deps(task_id, requires_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [taskId, pid]);
        }
      }
    }

    res.json({ ok: true, id: taskId });
  } catch (e) { console.error(e); res.status(500).json({ error: "create_failed" }); }
});

// Update task (partial)
app.patch("/api/task/:id", async (req, res) => {
  try {
    const id = +req.params.id;
    const { title, due, assignee_username, status, description, instructions } = req.body || {};

    let assignee_id = undefined;
    if (assignee_username !== undefined) {
      const u = await findUserByUsername(assignee_username);
      assignee_id = u ? u.id : null;
    }

    const sets = [];
    const vals = [];
    const push = (k, v) => { sets.push(k); vals.push(v); };

    if (title !== undefined) push(`title=$${vals.length+1}`, title);
    if (due !== undefined) push(`due=$${vals.length+1}`, due || null);
    if (assignee_username !== undefined) push(`assignee_id=$${vals.length+1}`, assignee_id);
    if (status !== undefined) push(`status=$${vals.length+1}`, status);
    if (description !== undefined) push(`description=$${vals.length+1}`, description);
    if (instructions !== undefined) push(`instructions=$${vals.length+1}`, instructions);

    if (!sets.length) return res.json({ ok: true, id });

    vals.push(id);
    await pg.query(`UPDATE tasks SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true, id });
  } catch (e) { console.error(e); res.status(500).json({ error: "update_failed" }); }
});

// Add reference
app.post("/api/task/:id/ref", async (req, res) => {
  try {
    const id = +req.params.id;
    const { url, caption } = req.body || {};
    if (!url) return res.status(400).json({ error: "url_required" });
    await pg.query(`INSERT INTO task_refs(task_id, url, caption) VALUES ($1,$2,$3)`, [id, url, caption || null]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "ref_failed" }); }
});

// Add prerequisite
app.post("/api/task/:id/prereq", async (req, res) => {
  try {
    const id = +req.params.id;
    const { requires_task_id } = req.body || {};
    if (!requires_task_id) return res.status(400).json({ error: "requires_task_id_required" });
    await pg.query(`INSERT INTO task_deps(task_id, requires_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, requires_task_id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "prereq_failed" }); }
});

// Get task (with refs + prereqs)
app.get("/api/task/:id", async (req, res) => {
  try {
    const id = +req.params.id;
    const t = await pg.query(`
      SELECT t.*, COALESCE(p.username,'') assignee_username
      FROM tasks t LEFT JOIN people p ON p.id=t.assignee_id
      WHERE t.id=$1
    `, [id]);
    if (!t.rows[0]) return res.status(404).json({ error: "not_found" });

    const refs = await pg.query(`SELECT id, url, caption FROM task_refs WHERE task_id=$1 ORDER BY id`, [id]);
    const deps = await pg.query(`
      SELECT d.requires_task_id AS id, tt.title
      FROM task_deps d JOIN tasks tt ON tt.id=d.requires_task_id
      WHERE d.task_id=$1 ORDER BY 1
    `, [id]);

    res.json({ ...t.rows[0], refs: refs.rows, prereqs: deps.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: "get_failed" }); }
});

// List tasks with filters
app.get("/api/tasks", async (req, res) => {
  try {
    const { status, due, assignee } = req.query;
    const wh = [];
    const vals = [];

    if (status) { vals.push(String(status)); wh.push(`t.status=$${vals.length}`); }
    if (due) { vals.push(String(due)); wh.push(`t.due=$${vals.length}`); }
    if (assignee) { vals.push(String(assignee).replace(/^@/,'')); wh.push(`p.username=$${vals.length}`); }

    const sql = `
      SELECT t.id, t.title, t.due, t.status, COALESCE(p.username,'') assignee
      FROM tasks t LEFT JOIN people p ON p.id=t.assignee_id
      ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
      ORDER BY t.due NULLS LAST, t.id DESC
    `;
    const { rows } = await pg.query(sql, vals);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "list_failed" }); }
});

app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`App listening on :${PORT} — ${PUBLIC_APP_URL || "no-domain"}`);
});
