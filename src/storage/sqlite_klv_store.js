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

const TARGET_POSITION_SOURCES = new Set(["FRAME_CENTER", "PLATFORM", "UNAVAILABLE"]);
const TARGET_FIELD_TYPES = new Set(["text", "number", "boolean"]);

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function targetEntryFromRow(row) {
  return {
    id: row.id,
    streamId: row.stream_id,
    missionId: row.mission_id || null,
    videoProductId: row.video_product_id || null,
    missionTimeMs: Number(row.mission_time_ms),
    videoTimeMs: row.video_time_ms != null && Number.isFinite(Number(row.video_time_ms)) ? Number(row.video_time_ms) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    observation: row.observation || "",
    position: Number.isFinite(Number(row.position_lat)) && Number.isFinite(Number(row.position_lon))
      ? { lat: Number(row.position_lat), lon: Number(row.position_lon) }
      : null,
    positionSource: row.position_source,
    customFields: parseJsonObject(row.custom_fields_json),
    createdBy: row.created_by || null
  };
}

function targetFieldFromRow(row) {
  return {
    id: row.id,
    streamId: row.stream_id,
    key: row.field_key,
    label: row.label,
    dataType: row.data_type,
    required: !!row.required,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeTargetPosition(position) {
  if (position == null) return null;
  const lat = Number(position.lat);
  const lon = Number(position.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("position must contain valid decimal-degree latitude (-90 to 90) and longitude (-180 to 180)");
  }
  return { lat, lon };
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
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS target_log_entries (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        mission_id TEXT,
        video_product_id TEXT,
        mission_time_ms INTEGER NOT NULL,
        video_time_ms INTEGER,
        observation TEXT NOT NULL DEFAULT '',
        position_lat REAL,
        position_lon REAL,
        position_source TEXT NOT NULL CHECK(position_source IN ('FRAME_CENTER','PLATFORM','UNAVAILABLE')),
        custom_fields_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const targetLogColumns = await all(this.db, `PRAGMA table_info(target_log_entries)`);
    if (!targetLogColumns.some((column) => column.name === "video_time_ms")) {
      await run(this.db, `ALTER TABLE target_log_entries ADD COLUMN video_time_ms INTEGER;`);
    }
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_target_log_stream_time ON target_log_entries(stream_id, mission_time_ms, created_at);`);
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS target_log_fields (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        field_key TEXT NOT NULL,
        label TEXT NOT NULL,
        data_type TEXT NOT NULL CHECK(data_type IN ('text','number','boolean')),
        required INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(stream_id, field_key)
      );
    `);
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_target_log_fields_stream_active ON target_log_fields(stream_id, active, created_at);`);
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS stream_mission_timeline (
        stream_id TEXT PRIMARY KEY,
        mission_base_ms INTEGER NOT NULL,
        video_base_ms INTEGER NOT NULL,
        mission_min_ms INTEGER NOT NULL,
        mission_max_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
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

  /** Returns every decoded event for a stream in mission-time order for export. */
  async listForExport(streamId) {
    const rows = await all(this.db,
      `SELECT t_ms, json FROM klv_events WHERE stream_id=? ORDER BY t_ms ASC`,
      [streamId]
    );
    return rows.map((row) => ({ tMs: Number(row.t_ms), data: JSON.parse(row.json) }));
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
    const result = await retryBusyWrite("purge_stream", async () => {
      await run(this.db, "BEGIN IMMEDIATE");
      try {
        const events = await run(this.db, `DELETE FROM klv_events WHERE stream_id=?`, [streamId]);
        await run(this.db, `DELETE FROM stream_mission_timeline WHERE stream_id=?`, [streamId]);
        await run(this.db, "COMMIT");
        return events;
      } catch (error) {
        try { await run(this.db, "ROLLBACK"); } catch {}
        throw error;
      }
    });
    const deleted = result?.changes ?? 0;
    log.info("purge_stream", { streamId, deleted });
    return deleted;
  }

  /** Updates the KLV mission-time to video-time alignment for a stream. */
  async updateMissionTimeline(streamId, { missionBaseMs, videoBaseMs, missionMinMs, missionMaxMs }) {
    const values = [missionBaseMs, videoBaseMs, missionMinMs, missionMaxMs].map((value) => Math.round(Number(value)));
    if (!streamId || !values.every(Number.isFinite) || values[2] > values[3]) return;
    const now = new Date().toISOString();
    await retryBusyWrite("update_mission_timeline", () => run(this.db, `
      INSERT INTO stream_mission_timeline(stream_id, mission_base_ms, video_base_ms, mission_min_ms, mission_max_ms, updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(stream_id) DO UPDATE SET
        mission_min_ms=MIN(stream_mission_timeline.mission_min_ms, excluded.mission_min_ms),
        mission_max_ms=MAX(stream_mission_timeline.mission_max_ms, excluded.mission_max_ms),
        updated_at=excluded.updated_at
    `, [streamId, values[0], values[1], values[2], values[3], now]));
  }

  async getMissionTimeline(streamId) {
    const row = await get(this.db, `SELECT * FROM stream_mission_timeline WHERE stream_id=?`, [streamId]);
    if (!row) return null;
    return {
      missionBaseMs: Number(row.mission_base_ms),
      videoBaseMs: Number(row.video_base_ms),
      missionMinMs: Number(row.mission_min_ms),
      missionMaxMs: Number(row.mission_max_ms)
    };
  }

  /** Returns the persisted target-log schema and entries for one stream. */
  async getTargetLog(streamId) {
    const [entryRows, fieldRows] = await Promise.all([
      all(this.db, `SELECT * FROM target_log_entries WHERE stream_id=? ORDER BY mission_time_ms ASC, created_at ASC`, [streamId]),
      all(this.db, `SELECT * FROM target_log_fields WHERE stream_id=? ORDER BY active DESC, created_at ASC`, [streamId])
    ]);
    return { entries: entryRows.map(targetEntryFromRow), fields: fieldRows.map(targetFieldFromRow) };
  }

  /** Adds a stream target mark with KLV mission time, video alignment time, and editable position. */
  async createTargetLogEntry(entry) {
    const missionTimeMs = Math.round(Number(entry.missionTimeMs));
    const videoTimeMs = entry.videoTimeMs == null ? null : Math.round(Number(entry.videoTimeMs));
    if (!entry?.id || !entry?.streamId || !Number.isFinite(missionTimeMs) || missionTimeMs < 0 || (videoTimeMs != null && (!Number.isFinite(videoTimeMs) || videoTimeMs < 0))) {
      throw new Error("id, streamId, and a non-negative missionTimeMs are required");
    }
    const positionSource = String(entry.positionSource || "UNAVAILABLE").toUpperCase();
    if (!TARGET_POSITION_SOURCES.has(positionSource)) throw new Error("invalid positionSource");
    const position = normalizeTargetPosition(entry.position);
    const hasPosition = !!position;
    if (positionSource !== "UNAVAILABLE" && !hasPosition) throw new Error("a captured position is required for the selected positionSource");
    const now = new Date().toISOString();
    await retryBusyWrite("target_log_create_entry", () => run(this.db, `
      INSERT INTO target_log_entries(
        id, stream_id, mission_id, video_product_id, mission_time_ms, video_time_ms, observation,
        position_lat, position_lon, position_source, custom_fields_json, created_by, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      entry.id, entry.streamId, entry.missionId || null, entry.videoProductId || null,
      missionTimeMs, videoTimeMs, String(entry.observation || ""), position?.lat ?? null, position?.lon ?? null,
      positionSource, JSON.stringify(entry.customFields && typeof entry.customFields === "object" ? entry.customFields : {}),
      entry.createdBy || null, now, now
    ]));
    return this.getTargetLogEntry(entry.streamId, entry.id);
  }

  async getTargetLogEntry(streamId, entryId) {
    const row = await get(this.db, `SELECT * FROM target_log_entries WHERE stream_id=? AND id=?`, [streamId, entryId]);
    return row ? targetEntryFromRow(row) : null;
  }

  /** Updates user-editable target-log data while retaining the captured mission time. */
  async updateTargetLogEntry(streamId, entryId, { observation, customFields, position, positionSource, missionTimeMs, videoTimeMs }) {
    const current = await this.getTargetLogEntry(streamId, entryId);
    if (!current) return null;
    const nextObservation = observation == null ? current.observation : String(observation);
    const nextMissionTimeMs = missionTimeMs == null ? current.missionTimeMs : Math.round(Number(missionTimeMs));
    if (!Number.isFinite(nextMissionTimeMs) || nextMissionTimeMs < 0) throw new Error("missionTimeMs must be a non-negative number");
    const nextVideoTimeMs = videoTimeMs === undefined
      ? current.videoTimeMs
      : videoTimeMs == null ? null : Math.round(Number(videoTimeMs));
    if (nextVideoTimeMs != null && (!Number.isFinite(nextVideoTimeMs) || nextVideoTimeMs < 0)) {
      throw new Error("videoTimeMs must be a non-negative number when provided");
    }
    const nextCustomFields = customFields && typeof customFields === "object" && !Array.isArray(customFields)
      ? customFields
      : current.customFields;
    const hasPositionUpdate = position !== undefined;
    const nextPosition = hasPositionUpdate ? normalizeTargetPosition(position) : current.position;
    const nextPositionSource = hasPositionUpdate
      ? String(positionSource || current.positionSource || "UNAVAILABLE").toUpperCase()
      : current.positionSource;
    if (!TARGET_POSITION_SOURCES.has(nextPositionSource)) throw new Error("invalid positionSource");
    if (nextPositionSource !== "UNAVAILABLE" && !nextPosition) {
      throw new Error("a captured position is required for the selected positionSource");
    }
    const now = new Date().toISOString();
    await retryBusyWrite("target_log_update_entry", () => run(this.db,
      `UPDATE target_log_entries SET mission_time_ms=?, video_time_ms=?, observation=?, custom_fields_json=?, position_lat=?, position_lon=?, position_source=?, updated_at=? WHERE stream_id=? AND id=?`,
      [nextMissionTimeMs, nextVideoTimeMs, nextObservation, JSON.stringify(nextCustomFields), nextPosition?.lat ?? null, nextPosition?.lon ?? null, nextPositionSource, now, streamId, entryId]
    ));
    return this.getTargetLogEntry(streamId, entryId);
  }

  async deleteTargetLogEntry(streamId, entryId) {
    const result = await retryBusyWrite("target_log_delete_entry", () => run(this.db,
      `DELETE FROM target_log_entries WHERE stream_id=? AND id=?`, [streamId, entryId]
    ));
    return (result?.changes ?? 0) > 0;
  }

  async createTargetLogField(field) {
    const key = String(field?.key || "").trim();
    const label = String(field?.label || "").trim();
    const dataType = String(field?.dataType || "text").toLowerCase();
    if (!field?.id || !field?.streamId || !/^[a-z][a-z0-9_]{0,63}$/i.test(key)) {
      throw new Error("field key must start with a letter and contain only letters, numbers, and underscores");
    }
    if (!label) throw new Error("field label is required");
    if (!TARGET_FIELD_TYPES.has(dataType)) throw new Error("invalid field dataType");
    const now = new Date().toISOString();
    try {
      await retryBusyWrite("target_log_create_field", () => run(this.db, `
        INSERT INTO target_log_fields(id, stream_id, field_key, label, data_type, required, active, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
      `, [field.id, field.streamId, key, label, dataType, field.required ? 1 : 0, 1, now, now]));
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE constraint failed")) {
        throw new Error(`a field with key "${key}" already exists for this stream`);
      }
      throw error;
    }
    const row = await get(this.db, `SELECT * FROM target_log_fields WHERE stream_id=? AND id=?`, [field.streamId, field.id]);
    return targetFieldFromRow(row);
  }

  /** Soft-removes a schema field so historic entry values are never discarded. */
  async deactivateTargetLogField(streamId, fieldId) {
    const now = new Date().toISOString();
    const result = await retryBusyWrite("target_log_deactivate_field", () => run(this.db,
      `UPDATE target_log_fields SET active=0, updated_at=? WHERE stream_id=? AND id=?`, [now, streamId, fieldId]
    ));
    return (result?.changes ?? 0) > 0;
  }

  /** Removes all target-log data when a stream is explicitly reset for a new source. */
  async purgeTargetLog(streamId) {
    return retryBusyWrite("target_log_purge_stream", async () => {
      await run(this.db, "BEGIN IMMEDIATE");
      try {
        const entries = await run(this.db, `DELETE FROM target_log_entries WHERE stream_id=?`, [streamId]);
        const fields = await run(this.db, `DELETE FROM target_log_fields WHERE stream_id=?`, [streamId]);
        await run(this.db, "COMMIT");
        return { entries: entries?.changes ?? 0, fields: fields?.changes ?? 0 };
      } catch (error) {
        try { await run(this.db, "ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  /** Clears telemetry and target-log data for every stream in one startup transaction. */
  async purgeAllMissionData() {
    return retryBusyWrite("startup_purge_all_mission_data", async () => {
      await run(this.db, "BEGIN IMMEDIATE");
      try {
        const telemetry = await run(this.db, `DELETE FROM klv_events`);
        await run(this.db, `DELETE FROM stream_mission_timeline`);
        const entries = await run(this.db, `DELETE FROM target_log_entries`);
        const fields = await run(this.db, `DELETE FROM target_log_fields`);
        await run(this.db, "COMMIT");
        const deleted = {
          telemetry: telemetry?.changes ?? 0,
          targetLog: { entries: entries?.changes ?? 0, fields: fields?.changes ?? 0 }
        };
        log.info("startup_purge_all_mission_data", deleted);
        return deleted;
      } catch (error) {
        try { await run(this.db, "ROLLBACK"); } catch {}
        throw error;
      }
    });
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
