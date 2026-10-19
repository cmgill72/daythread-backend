import pg from 'pg';
const { Pool } = pg;

export function createDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 15000 });
  return {
    async initialize() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS daythread_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider_sid TEXT NOT NULL UNIQUE,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          peer TEXT NOT NULL,
          from_number TEXT NOT NULL,
          to_number TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          media_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS daythread_messages_time_idx ON daythread_messages(created_at)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS daythread_messages_peer_idx ON daythread_messages(peer, created_at)`);
    },
    async listMessages(start, end) {
      const { rows } = await pool.query(`
        SELECT id, provider_sid, direction, peer, from_number, to_number,
          body, status, media_count, created_at
        FROM daythread_messages
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at ASC LIMIT 501
      `, [start, end]);
      return { messages: rows.slice(0, 500), hasMore: rows.length > 500 };
    },
    async insertMessage(message) {
      const { rows } = await pool.query(`
        INSERT INTO daythread_messages
          (provider_sid, direction, peer, from_number, to_number, body, status, media_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (provider_sid) DO UPDATE SET provider_sid = EXCLUDED.provider_sid
        RETURNING id, provider_sid, direction, peer, from_number, to_number,
          body, status, media_count, created_at
      `, [message.provider_sid, message.direction, message.peer, message.from_number,
        message.to_number, message.body, message.status, message.media_count || 0]);
      return rows[0];
    },
    async updateStatus(sid, status) {
      await pool.query(`UPDATE daythread_messages SET status=$2 WHERE provider_sid=$1 AND direction='outbound'`, [sid, status]);
    },
    async close() { await pool.end(); }
  };
}
