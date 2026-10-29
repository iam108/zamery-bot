require('dotenv').config();
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id          SERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        
        -- Объект
        address         TEXT NOT NULL,
        owner_name      TEXT NOT NULL,
        object_type     TEXT NOT NULL,
        object_name     TEXT,
        
        -- Детали
        has_video       BOOLEAN DEFAULT false,
        zones_info      TEXT,
        deadline        DATE,
        
        -- Контакты
        contacts        TEXT,
        
        -- Служебное
        status          TEXT DEFAULT 'new',   -- new | in_progress | done | cancelled
        assigned_to     TEXT,
        notes           TEXT,
        telegram_msg_id BIGINT,
        submitted_by    BIGINT  -- telegram user id кто подал
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id         SERIAL PRIMARY KEY,
        order_id   INT REFERENCES orders(id) ON DELETE CASCADE,
        action     TEXT NOT NULL,
        actor      TEXT,
        details    TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(require('../web/order-materials').DDL);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_deadline  ON orders(deadline);
      CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_order       ON logs(order_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        sid VARCHAR PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_sessions_expire ON web_sessions (expire);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audits (
        id SERIAL PRIMARY KEY,
        order_id INT,
        text TEXT,
        chat_id BIGINT,
        msg_ids BIGINT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        report_data JSONB
      );
      ALTER TABLE audits ADD COLUMN IF NOT EXISTS report_data JSONB;
      ALTER TABLE audits ADD COLUMN IF NOT EXISTS draft_id UUID;
      CREATE UNIQUE INDEX IF NOT EXISTS audits_draft_id ON audits(draft_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_drafts (
        id UUID PRIMARY KEY,
        author_tg_id BIGINT NOT NULL,
        order_id INT,
        revision INT NOT NULL DEFAULT 1,
        data JSONB NOT NULL DEFAULT '{}',
        delivery JSONB NOT NULL DEFAULT '{}',
        submitting_revision INT,
        submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE audit_drafts ADD COLUMN IF NOT EXISTS delivery JSONB NOT NULL DEFAULT '{}';
      CREATE UNIQUE INDEX IF NOT EXISTS audit_drafts_current
        ON audit_drafts (author_tg_id, COALESCE(order_id, 0)) WHERE submitted_at IS NULL;
      CREATE TABLE IF NOT EXISTS audit_evidence (
        draft_id UUID NOT NULL REFERENCES audit_drafts(id),
        id UUID NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        role TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        bytes INT NOT NULL,
        sha256 TEXT NOT NULL,
        content BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        PRIMARY KEY (draft_id, id)
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Миграции выполнены успешно');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Ошибка миграции:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
