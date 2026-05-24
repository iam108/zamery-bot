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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_deadline  ON orders(deadline);
      CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_order       ON logs(order_id);
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

migrate().catch(() => process.exit(1));
