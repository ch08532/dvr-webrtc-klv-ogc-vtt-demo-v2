/** Persists decoded KLV records and supplies time-window queries via SQLite. */
import sqlite3 from "sqlite3";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("sqlite_klv_store");
const SQLITE_BUSY_TIMEOUT_MS = Math.max(1000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 15000));
const SQLITE_BUSY_RETRIES = Math.max(0, Number(process.env.SQLITE_BUSY_RETRIES || 5));

/** Returns true for SQLite's transient inter-process writer-contention errors. */
function isSqliteBusy(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error || "");
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database is locked|database table is locked/i.test(message);
}

/** Delays an operation with a small amount of jitter to avoid lockstep retries. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries a complete write operation when another process temporarily owns SQLite's writer lock. */
async function retryBusyWrite(label, operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= SQLITE_BUSY_RETRIES) throw error;
      const delayMs = Math.min(2000, 75 * (2 ** attempt)) + Math.floor(Math.random() * 75);
      log.warn("sqlite_write_busy_retry", { label, attempt: attempt + 1, retries: SQLITE_BUSY_RETRIES, delayMs });
      await wait(delayMs);
    }
  }
}

/** Opens a SQLite database as a promise. */
function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve(db));
  });
}
/** Executes a write statement and resolves its SQLite execution details. */
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}
/** Executes a query that returns every matching row. */
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
/** Executes a query that returns at most one row. */
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
/** Closes a SQLite connection as a promise. */
function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => err ? reject(err) : resolve());
  });
}

/** Owns the telemetry schema, writes, retention policy, and query operations. */
export class SqliteKlvStore {
  /** Prepares the store; call init before issuing database operations. */
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    this.db = null;
    this._retentionTimer = null;
  }

  /** Opens the database and creates the telemetry table and index. */
  async init() {
    log.info("init_start", { dbPath: this.dbPath });
    this.db = await openDb(this.dbPath);
    await run(this.db, `PRAGMA journal_mode=WAL;`);
    await run(this.db, `PRAGMA synchronous=NORMAL;`);
    await run(this.db, `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`);
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS klv_events (
        stream_id TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        json TEXT NOT NULL,
        is_ephemeral INTEGER NOT NULL DEFAULT 1
      );
    `);
    const columns = await all(this.db, `PRAGMA table_info(klv_events)`);
    if (!columns.some((column) => column.name === "is_ephemeral")) {
      await run(this.db, `ALTER TABLE klv_events ADD COLUMN is_ephemeral INTEGER NOT NULL DEFAULT 1;`);
    }
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_klv_stream_time ON klv_events(stream_id, t_ms);`);
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_klv_retention ON klv_events(is_ephemeral, t_ms);`);
    log.info("init_complete", { dbPath: this.dbPath });
  }

  /** Stores one decoded telemetry event using its source timestamp when present. */
  async add(streamId, decoded) {
    const tMs = decoded.timestampUnixMicros
      ? Number(BigInt(decoded.timestampUnixMicros) / 1000n)
      : Date.now();
    await retryBusyWrite("add", () => run(this.db, `INSERT INTO klv_events(stream_id, t_ms, json, is_ephemeral) VALUES(?,?,?,1)`, [
      streamId, tMs, JSON.stringify(decoded)
    ]));
  }

  /** Stores a group of decoded events in one transaction, preserving file telemetry from live retention. */
  async addMany(streamId, decodedItems, { isEphemeral = true } = {}) {
    if (!Array.isArray(decodedItems) || !decodedItems.length) return 0;
    const rows = decodedItems.map((decoded) => {
      const tMs = decoded.timestampUnixMicros
        ? Number(BigInt(decoded.timestampUnixMicros) / 1000n)
        : Date.now();
      return [streamId, tMs, JSON.stringify(decoded), isEphemeral ? 1 : 0];
    });
    // SQLite commonly permits 999 bind variables, so keep each statement well
    // under that ceiling (four variables per telemetry event).
    const rowsPerStatement = 200;

    return retryBusyWrite("add_many", async () => {
      let transactionOpen = false;
      try {
        await run(this.db, "BEGIN IMMEDIATE");
        transactionOpen = true;
        for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
          const chunk = rows.slice(offset, offset + rowsPerStatement);
          const placeholders = chunk.map(() => "(?,?,?,?)").join(",");
          await run(
            this.db,
            `INSERT INTO klv_events(stream_id, t_ms, json, is_ephemeral) VALUES ${placeholders}`,
            chunk.flat()
          );
        }
        await run(this.db, "COMMIT");
        transactionOpen = false;
        return rows.length;
      } catch (error) {
        if (transactionOpen) {
          try { await run(this.db, "ROLLBACK"); } catch {}
        }
        throw error;
      }
    });
  }

  /** Returns decoded telemetry for one source over an inclusive time window. */
  async query(streamId, fromMs, toMs) {
    const rows = await all(this.db,
      `SELECT t_ms, json FROM klv_events WHERE stream_id=? AND t_ms BETWEEN ? AND ? ORDER BY t_ms ASC`,
      [streamId, fromMs, toMs]
    );
    return rows.map(r => ({ tMs: r.t_ms, data: JSON.parse(r.json) }));
  }

  /** Returns the most recently stored telemetry event for a source. */
  async latest(streamId) {
    const row = await get(this.db,
      `SELECT t_ms, json FROM klv_events WHERE stream_id=? ORDER BY t_ms DESC LIMIT 1`,
      [streamId]
    );
    if (!row) return null;
    return { tMs: row.t_ms, data: JSON.parse(row.json) };
  }

  /** Deletes all persisted telemetry associated with a source. */
  async purgeStream(streamId) {
    const result = await retryBusyWrite("purge_stream", () => run(this.db, `DELETE FROM klv_events WHERE stream_id=?`, [streamId]));
    const deleted = result?.changes ?? 0;
    log.info("purge_stream", { streamId, deleted });
    return deleted;
  }

  /** Starts periodic removal of telemetry older than the DVR retention window. */
  startRetentionJob({ maxAgeMs }) {
    if (this._retentionTimer) clearInterval(this._retentionTimer);
    log.info("retention_started", { maxAgeMs, intervalMs: 30000 });

    this._retentionTimer = setInterval(async () => {
      const cutoff = Date.now() - maxAgeMs;
      try {
        const result = await retryBusyWrite("retention_delete", () => run(this.db, `DELETE FROM klv_events WHERE is_ephemeral=1 AND t_ms < ?`, [cutoff]));
        if ((result?.changes ?? 0) > 0) {
          log.debug("retention_deleted", { deleted: result.changes, cutoff });
        }
      } catch (error) {
        log.error("retention_error", { error: serializeError(error) });
      }
    }, 30_000);
  }

  /** Stops retention and closes the database connection. */
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
