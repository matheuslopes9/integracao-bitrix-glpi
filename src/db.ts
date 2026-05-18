import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config';
import { logger } from './logger';

const dbDir = path.dirname(config.DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_task_link (
    glpi_ticket_id     INTEGER PRIMARY KEY,
    bitrix_task_id     INTEGER NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_link_bitrix_task ON ticket_task_link(bitrix_task_id);

  CREATE TABLE IF NOT EXISTS user_link (
    glpi_user_id   INTEGER PRIMARY KEY,
    bitrix_user_id INTEGER NOT NULL,
    glpi_email     TEXT,
    notes          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_bitrix ON user_link(bitrix_user_id);

  CREATE TABLE IF NOT EXISTS followup_link (
    glpi_followup_id  INTEGER NOT NULL,
    bitrix_comment_id INTEGER,
    glpi_ticket_id    INTEGER NOT NULL,
    direction         TEXT    NOT NULL CHECK (direction IN ('glpi->bitrix','bitrix->glpi')),
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (glpi_followup_id, direction)
  );

  CREATE TABLE IF NOT EXISTS echo_guard (
    key        TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT    NOT NULL,
    event      TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    status     TEXT    NOT NULL,
    error      TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_log_created ON webhook_log(created_at);
`);

logger.info({ path: config.DATABASE_PATH }, 'sqlite ready');

const stmtSetLink = db.prepare(`
  INSERT INTO ticket_task_link (glpi_ticket_id, bitrix_task_id, updated_at)
  VALUES (@glpi_ticket_id, @bitrix_task_id, datetime('now'))
  ON CONFLICT(glpi_ticket_id) DO UPDATE SET
    bitrix_task_id = excluded.bitrix_task_id,
    updated_at     = datetime('now')
`);
const stmtGetByGlpi = db.prepare('SELECT * FROM ticket_task_link WHERE glpi_ticket_id = ?');
const stmtGetByBitrix = db.prepare('SELECT * FROM ticket_task_link WHERE bitrix_task_id = ?');

export const linkRepo = {
  upsert(glpiTicketId: number, bitrixTaskId: number) {
    stmtSetLink.run({ glpi_ticket_id: glpiTicketId, bitrix_task_id: bitrixTaskId });
  },
  findByGlpiTicket(glpiTicketId: number): { glpi_ticket_id: number; bitrix_task_id: number } | undefined {
    return stmtGetByGlpi.get(glpiTicketId) as
      | { glpi_ticket_id: number; bitrix_task_id: number }
      | undefined;
  },
  findByBitrixTask(bitrixTaskId: number): { glpi_ticket_id: number; bitrix_task_id: number } | undefined {
    return stmtGetByBitrix.get(bitrixTaskId) as
      | { glpi_ticket_id: number; bitrix_task_id: number }
      | undefined;
  }
};

const stmtGetUser = db.prepare('SELECT bitrix_user_id FROM user_link WHERE glpi_user_id = ?');
const stmtGetGlpiUser = db.prepare('SELECT glpi_user_id FROM user_link WHERE bitrix_user_id = ?');
const stmtUpsertUser = db.prepare(`
  INSERT INTO user_link (glpi_user_id, bitrix_user_id, glpi_email, notes)
  VALUES (@glpi, @bitrix, @email, @notes)
  ON CONFLICT(glpi_user_id) DO UPDATE SET
    bitrix_user_id = excluded.bitrix_user_id,
    glpi_email     = COALESCE(excluded.glpi_email, glpi_email),
    notes          = COALESCE(excluded.notes, notes)
`);

export const userRepo = {
  glpiToBitrix(glpiUserId: number): number | undefined {
    const row = stmtGetUser.get(glpiUserId) as { bitrix_user_id: number } | undefined;
    return row?.bitrix_user_id;
  },
  bitrixToGlpi(bitrixUserId: number): number | undefined {
    const row = stmtGetGlpiUser.get(bitrixUserId) as { glpi_user_id: number } | undefined;
    return row?.glpi_user_id;
  },
  upsert(glpiUserId: number, bitrixUserId: number, email?: string, notes?: string) {
    stmtUpsertUser.run({
      glpi: glpiUserId,
      bitrix: bitrixUserId,
      email: email ?? null,
      notes: notes ?? null
    });
  }
};

const stmtEchoSet = db.prepare(
  'INSERT OR REPLACE INTO echo_guard (key, expires_at) VALUES (?, ?)'
);
const stmtEchoGet = db.prepare('SELECT expires_at FROM echo_guard WHERE key = ?');
const stmtEchoDel = db.prepare('DELETE FROM echo_guard WHERE expires_at < ?');

export const echoGuard = {
  arm(key: string, ttlMs = 10_000) {
    stmtEchoSet.run(key, Date.now() + ttlMs);
  },
  isArmed(key: string): boolean {
    stmtEchoDel.run(Date.now());
    const row = stmtEchoGet.get(key) as { expires_at: number } | undefined;
    return !!row && row.expires_at > Date.now();
  }
};

const stmtLogInsert = db.prepare(
  'INSERT INTO webhook_log (source, event, payload, status, error) VALUES (?, ?, ?, ?, ?)'
);
export const auditLog = {
  record(source: 'glpi' | 'bitrix', event: string, payload: unknown, status: 'ok' | 'error', error?: string) {
    stmtLogInsert.run(source, event, JSON.stringify(payload), status, error ?? null);
  }
};

const stmtFollowupSet = db.prepare(
  `INSERT OR IGNORE INTO followup_link (glpi_followup_id, bitrix_comment_id, glpi_ticket_id, direction)
   VALUES (?, ?, ?, ?)`
);
const stmtFollowupGet = db.prepare(
  'SELECT 1 FROM followup_link WHERE glpi_followup_id = ? AND direction = ?'
);
export const followupRepo = {
  mark(glpiFollowupId: number, glpiTicketId: number, direction: 'glpi->bitrix' | 'bitrix->glpi', bitrixCommentId?: number) {
    stmtFollowupSet.run(glpiFollowupId, bitrixCommentId ?? null, glpiTicketId, direction);
  },
  alreadyHandled(glpiFollowupId: number, direction: 'glpi->bitrix' | 'bitrix->glpi'): boolean {
    return !!stmtFollowupGet.get(glpiFollowupId, direction);
  }
};
