import sqlite3 from "sqlite3";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("sqlite_klv_store");

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve(db));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => err ? reject(err) : resolve());
  });
}

export class SqliteKlvStore {
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    this.db = null;
    this._retentionTimer = null;
  }

  async init() {
    log.info("init_start", { dbPath: this.dbPath });
    this.db = await openDb(this.dbPath);
    await run(this.db, `PRAGMA journal_mode=WAL;`);
    await run(this.db, `PRAGMA synchronous=NORMAL;`);
    await run(this.db, `PRAGMA busy_timeout=5000;`);
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS klv_events (
        stream_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `);
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_klv_stream_time ON klv_events(stream_id, t_ms);`);
    log.info("init_complete", { dbPath: this.dbPath });
  }

  async add(streamId, decoded) {
    const tMs = decoded.timestampUnixMicros
      ? Number(BigInt(decoded.timestampUnixMicros) / 1000n)
      : Date.now();
    await run(this.db, `INSERT INTO klv_events(stream_id, t_ms, json) VALUES(?,?,?)`, [
      streamId, tMs, JSON.stringify(decoded)
    ]);
  }

  async query(streamId, fromMs, toMs) {
    const rows = await all(this.db,
      `SELECT t_ms, json FROM klv_events WHERE stream_id=? AND t_ms BETWEEN ? AND ? ORDER BY t_ms ASC`,
      [streamId, fromMs, toMs]
    );
    return rows.map(r => ({ tMs: r.t_ms, data: JSON.parse(r.json) }));
  }

  async latest(streamId) {
    const row = await get(this.db,
      `SELECT t_ms, json FROM klv_events WHERE stream_id=? ORDER BY t_ms DESC LIMIT 1`,
      [streamId]
    );
    if (!row) return null;
    return { tMs: row.t_ms, data: JSON.parse(row.json) };
  }

  async purgeStream(streamId) {
    const result = await run(this.db, `DELETE FROM klv_events WHERE stream_id=?`, [streamId]);
    const deleted = result?.changes ?? 0;
    log.info("purge_stream", { streamId, deleted });
    return deleted;
  }

  startRetentionJob({ maxAgeMs }) {
    if (this._retentionTimer) clearInterval(this._retentionTimer);
    log.info("retention_started", { maxAgeMs, intervalMs: 30000 });

    this._retentionTimer = setInterval(async () => {
      const cutoff = Date.now() - maxAgeMs;
      try {
        const result = await run(this.db, `DELETE FROM klv_events WHERE t_ms < ?`, [cutoff]);
        if ((result?.changes ?? 0) > 0) {
          log.debug("retention_deleted", { deleted: result.changes, cutoff });
        }
      } catch (error) {
        log.error("retention_error", { error: serializeError(error) });
      }
    }, 30_000);
  }

  async close() {
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = null;
    }
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await closeDb(db);
  }
}
