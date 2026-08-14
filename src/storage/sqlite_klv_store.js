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
  const hasStoredPosition = row.position_lat != null && row.position_lon != null
    && String(row.position_lat).trim() !== '' && String(row.position_lon).trim() !== ''
    && Number.isFinite(Number(row.position_lat)) && Number.isFinite(Number(row.position_lon));
  const position = hasStoredPosition
    ? { lat: Number(row.position_lat), lon: Number(row.position_lon) }
    : null;
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
    position,
    positionSource: position ? (row.position_source || 'UNAVAILABLE') : 'UNAVAILABLE',
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

/**
 * Validates one compact platform-history point derived from a completed HLS
 * segment. `sequence` is the browser HLS ordering key; `tMs` is retained
 * separately for mission-time windowing and client-side playback trimming.
 */
function normalizePlatformTrackPoint(point) {
  const sequence = Math.trunc(Number(point?.sequence));
  const tMs = Math.round(Number(point?.tMs));
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(tMs)
    || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { sequence, tMs, lat, lon };
}

/** Keeps first/last points while reducing a long route to a deterministic maximum. */
function reduceTrackPoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];
  const lastIndex = points.length - 1;
  const reduced = [points[0]];
  let previousIndex = 0;
  for (let index = 1; index < maxPoints - 1; index += 1) {
    const candidate = Math.round((index * lastIndex) / (maxPoints - 1));
    if (candidate > previousIndex && candidate < lastIndex) {
      reduced.push(points[candidate]);
      previousIndex = candidate;
    }
  }
  reduced.push(points[lastIndex]);
  return reduced;
}

/** Owns the telemetry schema, writes, and query operations. */
export class SqliteKlvStore {
  /** Prepares the store; call init before issuing database operations. */
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    this.db = null;
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
        json TEXT NOT NULL
      );
    `);
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_klv_stream_time ON klv_events(stream_id, t_ms);`);
    // This small index is intentionally separate from full-rate `klv_events`:
    // it holds only the final valid platform location from each completed
    // browser HLS segment for map history requests.
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS platform_track_points (
        stream_id TEXT NOT NULL,
        video_sequence INTEGER NOT NULL,
        t_ms INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        PRIMARY KEY(stream_id, video_sequence)
      );
    `);
    await run(this.db, `CREATE INDEX IF NOT EXISTS idx_platform_track_stream_time ON platform_track_points(stream_id, t_ms);`);
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
    await run(this.db, `
      CREATE TABLE IF NOT EXISTS stream_manual_video_time_anchor (
        stream_id TEXT PRIMARY KEY,
        first_frame_utc_ms INTEGER NOT NULL,
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
    await retryBusyWrite("add", () => run(this.db, `INSERT INTO klv_events(stream_id, t_ms, json) VALUES(?,?,?)`, [
      streamId, tMs, JSON.stringify(decoded)
    ]));
  }

  /** Stores a group of decoded events in one transaction. */
  async addMany(streamId, decodedItems) {
    if (!Array.isArray(decodedItems) || !decodedItems.length) return 0;
    const rows = decodedItems.map((decoded) => {
      const tMs = decoded.timestampUnixMicros
        ? Number(BigInt(decoded.timestampUnixMicros) / 1000n)
        : Date.now();
      return [streamId, tMs, JSON.stringify(decoded)];
    });
    // SQLite commonly permits 999 bind variables, so keep each statement well
    // under that ceiling (three variables per telemetry event).
    const rowsPerStatement = 300;

    return retryBusyWrite("add_many", async () => {
      let transactionOpen = false;
      try {
        await run(this.db, "BEGIN IMMEDIATE");
        transactionOpen = true;
        for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
          const chunk = rows.slice(offset, offset + rowsPerStatement);
          const placeholders = chunk.map(() => "(?,?,?)").join(",");
          await run(
            this.db,
            `INSERT INTO klv_events(stream_id, t_ms, json) VALUES ${placeholders}`,
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

  /**
   * Stores the last valid platform position for each processed browser HLS
   * segment. The stream/sequence key makes repeated playlist scans idempotent.
   */
  async upsertPlatformTrackSamples(streamId, samples) {
    const rows = (Array.isArray(samples) ? samples : [])
      .map(normalizePlatformTrackPoint)
      .filter(Boolean);
    if (!rows.length) return 0;

    // Five bound variables per row; remain well below SQLite's common 999 limit.
    const rowsPerStatement = 150;
    return retryBusyWrite("upsert_platform_track_samples", async () => {
      let transactionOpen = false;
      try {
        await run(this.db, "BEGIN IMMEDIATE");
        transactionOpen = true;
        for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
          const chunk = rows.slice(offset, offset + rowsPerStatement);
          const placeholders = chunk.map(() => "(?,?,?,?,?)").join(",");
          await run(this.db, `
            INSERT INTO platform_track_points(stream_id, video_sequence, t_ms, lat, lon)
            VALUES ${placeholders}
            ON CONFLICT(stream_id, video_sequence) DO UPDATE SET
              t_ms=excluded.t_ms,
              lat=excluded.lat,
              lon=excluded.lon
          `, chunk.flatMap((sample) => [streamId, sample.sequence, sample.tMs, sample.lat, sample.lon]));
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

  /**
   * Returns a deduplicated, bounded platform path without loading full KLV
   * JSON. Results stay in HLS sequence order even when source mission times
   * repeat; callers receive the parallel timestamps to apply a time window.
   */
  async listPlatformTrackPoints(streamId, { fromMs = null, toMs = null, maxPoints = 5000 } = {}) {
    const conditions = ["stream_id=?"];
    const values = [streamId];
    if (Number.isFinite(fromMs)) {
      conditions.push("t_ms>=?");
      values.push(Math.round(fromMs));
    }
    if (Number.isFinite(toMs)) {
      conditions.push("t_ms<=?");
      values.push(Math.round(toMs));
    }
    const rows = await all(this.db, `
      SELECT video_sequence, t_ms, lat, lon
      FROM platform_track_points
      WHERE ${conditions.join(" AND ")}
      ORDER BY video_sequence ASC
    `, values);
    const sourcePointCount = rows.length;
    const deduplicated = [];
    for (const row of rows) {
      const point = {
        sequence: Number(row.video_sequence),
        tMs: Number(row.t_ms),
        lat: Number(row.lat),
        lon: Number(row.lon)
      };
      const previous = deduplicated[deduplicated.length - 1];
      // A stationary platform needs only its newest position until it moves.
      if (previous && previous.lat === point.lat && previous.lon === point.lon) {
        deduplicated[deduplicated.length - 1] = point;
      } else {
        deduplicated.push(point);
      }
    }
    const safeMaxPoints = Math.max(2, Math.floor(Number(maxPoints) || 5000));
    const points = reduceTrackPoints(deduplicated, safeMaxPoints);
    return {
      points,
      sourcePointCount,
      deduplicatedPointCount: deduplicated.length,
      reduced: points.length < deduplicated.length
    };
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

  /**
   * Returns only the timestamped positions required for the compact KML export.
   * Keeping this projection in SQLite avoids loading and parsing every full KLV
   * JSON document when the export only needs platform, SPI, and target tracks.
   */
  async listForKmlExport(streamId) {
    const rows = await all(this.db, `
      SELECT
        t_ms,
        json_extract(json, '$.timestampIso') AS timestamp_iso,
        json_extract(json, '$.sensorLat') AS sensor_lat,
        json_extract(json, '$.sensorLon') AS sensor_lon,
        json_extract(json, '$.sensorAltMslM') AS sensor_alt_msl_m,
        json_extract(json, '$.frameCenterLat') AS frame_center_lat,
        json_extract(json, '$.frameCenterLon') AS frame_center_lon,
        json_extract(json, '$.frameCenterElevationMslM') AS frame_center_elevation_msl_m,
        json_extract(json, '$.sensorRelAzDeg') AS sensor_rel_az_deg,
        json_extract(json, '$.sensorRelElDeg') AS sensor_rel_el_deg,
        json_extract(json, '$.sensorRelRollDeg') AS sensor_rel_roll_deg,
        json_extract(json, '$.sensorHfovDeg') AS sensor_hfov_deg,
        json_extract(json, '$.sensorVfovDeg') AS sensor_vfov_deg,
        json_extract(json, '$.slantRangeM') AS slant_range_m,
        json_extract(json, '$.targetWidthM') AS target_width_m,
        json_extract(json, '$.targetLat') AS target_lat,
        json_extract(json, '$.targetLon') AS target_lon,
        json_extract(json, '$.targetElevationMslM') AS target_elevation_msl_m,
        json_extract(json, '$.targetTrackGateWidthPx') AS target_track_gate_width_px,
        json_extract(json, '$.targetTrackGateHeightPx') AS target_track_gate_height_px,
        json_extract(json, '$.targetLocationCe90M') AS target_location_ce90_m,
        json_extract(json, '$.targetLocationLe90M') AS target_location_le90_m
      FROM klv_events
      WHERE stream_id=?
        AND (
          (json_extract(json, '$.sensorLat') IS NOT NULL AND json_extract(json, '$.sensorLon') IS NOT NULL)
          OR (json_extract(json, '$.frameCenterLat') IS NOT NULL AND json_extract(json, '$.frameCenterLon') IS NOT NULL)
          OR (json_extract(json, '$.targetLat') IS NOT NULL AND json_extract(json, '$.targetLon') IS NOT NULL)
        )
      ORDER BY t_ms ASC
    `, [streamId]);
    return rows.map((row) => ({
      tMs: Number(row.t_ms),
      timestampIso: row.timestamp_iso,
      sensorLat: row.sensor_lat,
      sensorLon: row.sensor_lon,
      sensorAltMslM: row.sensor_alt_msl_m,
      frameCenterLat: row.frame_center_lat,
      frameCenterLon: row.frame_center_lon,
      frameCenterElevationMslM: row.frame_center_elevation_msl_m,
      sensorRelAzDeg: row.sensor_rel_az_deg,
      sensorRelElDeg: row.sensor_rel_el_deg,
      sensorRelRollDeg: row.sensor_rel_roll_deg,
      sensorHfovDeg: row.sensor_hfov_deg,
      sensorVfovDeg: row.sensor_vfov_deg,
      slantRangeM: row.slant_range_m,
      targetWidthM: row.target_width_m,
      targetLat: row.target_lat,
      targetLon: row.target_lon,
      targetElevationMslM: row.target_elevation_msl_m,
      targetTrackGateWidthPx: row.target_track_gate_width_px,
      targetTrackGateHeightPx: row.target_track_gate_height_px,
      targetLocationCe90M: row.target_location_ce90_m,
      targetLocationLe90M: row.target_location_le90_m
    }));
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
        await run(this.db, `DELETE FROM platform_track_points WHERE stream_id=?`, [streamId]);
        await run(this.db, `DELETE FROM stream_mission_timeline WHERE stream_id=?`, [streamId]);
        await run(this.db, `DELETE FROM stream_manual_video_time_anchor WHERE stream_id=?`, [streamId]);
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

  /** Returns the optional operator-supplied UTC time for the first video frame. */
  async getManualVideoTimeAnchor(streamId) {
    const row = await get(this.db, `SELECT first_frame_utc_ms, updated_at FROM stream_manual_video_time_anchor WHERE stream_id=?`, [streamId]);
    return row ? { firstFrameUtcMs: Number(row.first_frame_utc_ms), updatedAt: row.updated_at } : null;
  }

  /** Saves an operator-supplied UTC anchor for a no-KLV file source. */
  async setManualVideoTimeAnchor(streamId, firstFrameUtcMs) {
    const value = Math.round(Number(firstFrameUtcMs));
    if (!Number.isFinite(value) || value < 0) throw new Error("firstFrameUtcMs must be a non-negative Unix timestamp in milliseconds");
    const updatedAt = new Date().toISOString();
    await retryBusyWrite("set_manual_video_time_anchor", () => run(this.db, `
      INSERT INTO stream_manual_video_time_anchor(stream_id, first_frame_utc_ms, updated_at)
      VALUES(?,?,?)
      ON CONFLICT(stream_id) DO UPDATE SET first_frame_utc_ms=excluded.first_frame_utc_ms, updated_at=excluded.updated_at
    `, [streamId, value, updatedAt]));
    return { firstFrameUtcMs: value, updatedAt };
  }

  /** Removes a manual video UTC anchor without affecting the source media. */
  async clearManualVideoTimeAnchor(streamId) {
    const result = await retryBusyWrite("clear_manual_video_time_anchor", () => run(this.db,
      `DELETE FROM stream_manual_video_time_anchor WHERE stream_id=?`, [streamId]
    ));
    return (result?.changes ?? 0) > 0;
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

  /** Summarizes the SQLite-backed mission records used by KML and target-log workflows. */
  async getMissionDataSummary(streamId) {
    const [telemetry, targetEntries, targetFields] = await Promise.all([
      get(this.db, `
        SELECT COUNT(*) AS event_count, MIN(t_ms) AS first_mission_time_ms, MAX(t_ms) AS last_mission_time_ms
        FROM klv_events
        WHERE stream_id=?
      `, [streamId]),
      get(this.db, `SELECT COUNT(*) AS entry_count FROM target_log_entries WHERE stream_id=?`, [streamId]),
      get(this.db, `SELECT COUNT(*) AS field_count FROM target_log_fields WHERE stream_id=? AND active=1`, [streamId])
    ]);
    return {
      klvEventCount: Number(telemetry?.event_count || 0),
      firstMissionTimeMs: telemetry?.first_mission_time_ms == null ? null : Number(telemetry.first_mission_time_ms),
      lastMissionTimeMs: telemetry?.last_mission_time_ms == null ? null : Number(telemetry.last_mission_time_ms),
      targetLogEntryCount: Number(targetEntries?.entry_count || 0),
      activeTargetLogFieldCount: Number(targetFields?.field_count || 0)
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
    log.warn("purge_all_mission_data_start", { dbPath: this.dbPath });
    const result = await retryBusyWrite("startup_purge_all_mission_data", async () => {
      await run(this.db, "BEGIN IMMEDIATE");
      try {
        const telemetry = await run(this.db, `DELETE FROM klv_events`);
        await run(this.db, `DELETE FROM platform_track_points`);
        await run(this.db, `DELETE FROM stream_mission_timeline`);
        await run(this.db, `DELETE FROM stream_manual_video_time_anchor`);
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
    log.warn("purge_all_mission_data_complete", { dbPath: this.dbPath, ...result });
    return result;
  }

  /** Closes the database connection. */
  async close() {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await closeDb(db);
  }
}
