import pg from 'pg';
const { Pool } = pg;

// Guard against Twilio callbacks arriving out of order (e.g. delivered before sent).
function statusPrioritySQL(column) {
  return `CASE ${column}
    WHEN 'read' THEN 7 WHEN 'delivered' THEN 6
    WHEN 'undelivered' THEN 5 WHEN 'failed' THEN 5 WHEN 'canceled' THEN 5
    WHEN 'sent' THEN 4 WHEN 'sending' THEN 3
    WHEN 'queued' THEN 2 WHEN 'accepted' THEN 1 WHEN 'scheduled' THEN 1
    ELSE 0 END`;
}


export function createDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 15000 });
  return {
    async initialize() {
      // Additive migration: do not rename or delete the working v0.1.1 messages table.
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
      await pool.query('ALTER TABLE daythread_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ');
      await pool.query('CREATE INDEX IF NOT EXISTS daythread_messages_time_idx ON daythread_messages(created_at)');
      await pool.query('CREATE INDEX IF NOT EXISTS daythread_messages_peer_idx ON daythread_messages(peer, created_at)');
      await pool.query(`CREATE INDEX IF NOT EXISTS daythread_unread_idx
        ON daythread_messages(created_at) WHERE direction = 'inbound' AND read_at IS NULL`);
      await pool.query(`CREATE TABLE IF NOT EXISTS daythread_push_devices (
        token TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // Status callbacks can precede a successful sender-side INSERT; keep the latest event.
      await pool.query(`CREATE TABLE IF NOT EXISTS daythread_status_events (
        provider_sid TEXT PRIMARY KEY, status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    },
    async listMessages(start, end) {
      const { rows } = await pool.query(`
        SELECT id, provider_sid, direction, peer, from_number, to_number,
          body, status, media_count, created_at, read_at
        FROM daythread_messages
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ORDER BY created_at ASC, id ASC LIMIT 501
      `, [start, end]);
      return { messages: rows.slice(0, 500), hasMore: rows.length > 500 };
    },
    async unreadCount() {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM daythread_messages
        WHERE direction='inbound' AND read_at IS NULL`);
      return rows[0].count;
    },
    async insertMessage(message) {
      const { rows } = await pool.query(`
        INSERT INTO daythread_messages
          (provider_sid, direction, peer, from_number, to_number, body, status, media_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (provider_sid) DO NOTHING
        RETURNING id, provider_sid, direction, peer, from_number, to_number,
          body, status, media_count, created_at, read_at
      `, [message.provider_sid, message.direction, message.peer, message.from_number,
        message.to_number, message.body, message.status, message.media_count || 0]);
      if (message.direction === 'outbound') {
        // If a status webhook raced the outgoing INSERT, apply it now.
        await pool.query(`UPDATE daythread_messages m SET status = s.status
          FROM daythread_status_events s
          WHERE m.provider_sid = $1 AND s.provider_sid = m.provider_sid
            AND m.direction = 'outbound'`, [message.provider_sid]);
      }
      return rows[0] || null; // null means duplicate Twilio retry; don't notify twice.
    },
    async getMessageBySID(sid) {
      const { rows } = await pool.query(`SELECT id, provider_sid, direction, peer,
        from_number, to_number, body, status, media_count, created_at, read_at
        FROM daythread_messages WHERE provider_sid=$1`, [sid]);
      return rows[0] || null;
    },
    async markRead(ids) {
      const { rows } = await pool.query(`UPDATE daythread_messages
        SET read_at=NOW() WHERE id=ANY($1::uuid[]) AND direction='inbound' AND read_at IS NULL
        RETURNING id`, [ids]);
      return rows.length;
    },
    async recordStatus(sid, status) {
      await pool.query(`INSERT INTO daythread_status_events(provider_sid, status)
        VALUES ($1,$2) ON CONFLICT(provider_sid) DO UPDATE
        SET status = EXCLUDED.status, updated_at = NOW()
        WHERE ${statusPrioritySQL('EXCLUDED.status')} >= ${statusPrioritySQL('daythread_status_events.status')}`, [sid, status]);
      await pool.query(`UPDATE daythread_messages m SET status=s.status
        FROM daythread_status_events s
        WHERE m.provider_sid=$1 AND m.direction='outbound' AND s.provider_sid=m.provider_sid
          AND ${statusPrioritySQL('s.status')} >= ${statusPrioritySQL('m.status')}`, [sid]);
    },
    async registerPushToken(token, environment) {
      await pool.query(`INSERT INTO daythread_push_devices(token, environment) VALUES ($1,$2)
        ON CONFLICT(token) DO UPDATE SET environment=EXCLUDED.environment, updated_at=NOW()`, [token, environment]);
    },
    async listPushTokens() {
      const { rows } = await pool.query(`SELECT token, environment FROM daythread_push_devices
        ORDER BY updated_at DESC LIMIT 10`);
      return rows;
    },
    async deletePushToken(token) {
      await pool.query('DELETE FROM daythread_push_devices WHERE token=$1', [token]);
    },
    async close() { await pool.end(); }
  };
}
