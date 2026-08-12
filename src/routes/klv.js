import { Router } from "express";

/**
 * KLV telemetry query and export endpoints.
 *
 * CSV/KML are exports of the canonical SQLite dataset, while GeoJSON is a
 * deliberately reduced platform path for map rendering.
 */
export function createKlvRouter({
  store, resolveStreamRecordingDir, KLV_CSV_COLUMNS, klvCsvRow, buildKlvKml,
  PLATFORM_HISTORY_MAX_POINTS, log, serializeError
}) {
  const router = Router();
  const validateStreamId = (streamId) => {
    resolveStreamRecordingDir(streamId);
    return streamId;
  };
// Excel-compatible telemetry export; the UTF-8 BOM is intentional.
router.get("/streams/:streamId/klv/export.csv", async (req, res) => {
  try {
    const streamId = validateStreamId(req.params.streamId);
    const [events, timeline, missionData] = await Promise.all([
      store.listForExport(streamId),
      store.getMissionTimeline(streamId),
      store.getMissionDataSummary(streamId)
    ]);
    if (missionData.klvEventCount <= 0) {
      return res.status(409).json({ ok: false, error: "No KLV telemetry available for this source" });
    }
    log.info("klv_export_sqlite_mission_data", {
      streamId,
      exportFormat: "csv",
      kmlTelemetryEventCount: missionData.klvEventCount,
      firstMissionTimeMs: missionData.firstMissionTimeMs,
      lastMissionTimeMs: missionData.lastMissionTimeMs,
      targetLogEntryCount: missionData.targetLogEntryCount,
      activeTargetLogFieldCount: missionData.activeTargetLogFieldCount,
      exportedEventCount: events.length
    });
    const safeStreamId = streamId.replace(/[^a-z0-9_-]+/gi, "_");
    const csv = `\uFEFF${KLV_CSV_COLUMNS.join(",")}\r\n${events.map((event) => klvCsvRow(streamId, event, timeline)).join("\r\n")}${events.length ? "\r\n" : ""}`;
    res.status(200)
      .type("text/csv; charset=utf-8")
      .attachment(`${safeStreamId}-klv-telemetry.csv`)
      .send(csv);
  } catch (error) {
    log.warn("klv_csv_export_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// KML preserves timestamped platform, frame-center, and target tracks.
router.get("/streams/:streamId/klv/export.kml", async (req, res) => {
  try {
    const streamId = validateStreamId(req.params.streamId);
    const [events, missionData] = await Promise.all([
      store.listForKmlExport(streamId),
      store.getMissionDataSummary(streamId)
    ]);
    if (missionData.klvEventCount <= 0) {
      return res.status(409).json({ ok: false, error: "No KLV telemetry available for this source" });
    }
    const safeStreamId = streamId.replace(/[^a-z0-9_-]+/gi, "_");
    log.info("klv_export_sqlite_mission_data", {
      streamId,
      exportFormat: "kml",
      kmlTelemetryEventCount: missionData.klvEventCount,
      firstMissionTimeMs: missionData.firstMissionTimeMs,
      lastMissionTimeMs: missionData.lastMissionTimeMs,
      targetLogEntryCount: missionData.targetLogEntryCount,
      activeTargetLogFieldCount: missionData.activeTargetLogFieldCount,
      positionCandidateEventCount: events.length
    });
    res.status(200)
      .type("application/vnd.google-earth.kml+xml; charset=utf-8")
      .attachment(`${safeStreamId}-klv-telemetry.kml`)
      .send(buildKlvKml(streamId, events));
  } catch (error) {
    log.warn("klv_kml_export_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

/**
 * Returns one lightweight GeoJSON platform path built from completed
 * HLS-segment samples. `properties.timesMs[index]` belongs to
 * `geometry.coordinates[index]`, allowing the browser to trim a file route
 * to its active WebVTT mission time without requesting full KLV JSON.
 */
router.get("/streams/:streamId/klv/platform-history.geojson", async (req, res) => {
  try {
    const streamId = validateStreamId(req.params.streamId);
    const parseOptionalTime = (value, name) => {
      if (value == null || String(value).trim() === "") return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${name} must be milliseconds since epoch`);
      return Math.round(parsed);
    };
    const fromMs = parseOptionalTime(req.query.fromMs, "fromMs");
    const toMs = parseOptionalTime(req.query.toMs, "toMs");
    if (fromMs != null && toMs != null && fromMs > toMs) {
      throw new Error("fromMs must be less than or equal to toMs");
    }
    const rawMaxPoints = req.query.maxPoints == null ? PLATFORM_HISTORY_MAX_POINTS : Number(req.query.maxPoints);
    if (!Number.isFinite(rawMaxPoints) || rawMaxPoints < 2) {
      throw new Error("maxPoints must be at least 2");
    }
    const maxPoints = Math.min(PLATFORM_HISTORY_MAX_POINTS, Math.floor(rawMaxPoints));
    const history = await store.listPlatformTrackPoints(streamId, { fromMs, toMs, maxPoints });
    const points = history.points;
    const geometry = points.length >= 2
      ? { type: "LineString", coordinates: points.map((point) => [point.lon, point.lat]) }
      : null;
    res.set("Cache-Control", "no-store");
    res.type("application/geo+json").json({
      type: "Feature",
      properties: {
        streamId,
        sampleSource: "last-platform-position-per-completed-hls-segment",
        fromMs,
        toMs,
        pointCount: points.length,
        sourcePointCount: history.sourcePointCount,
        deduplicatedPointCount: history.deduplicatedPointCount,
        reduced: history.reduced,
        timesMs: points.map((point) => point.tMs)
      },
      geometry
    });
  } catch (error) {
    log.warn("platform_history_geojson_error", { streamId: req.params.streamId, error: serializeError(error) });
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// Raw interval query for clients that need individual telemetry events.
router.get("/streams/:streamId/klv", async (req, res) => {
  const streamId = req.params.streamId;
  const fromMs = Number(req.query.fromMs);
  const toMs = Number(req.query.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return res.status(400).json({ error: "fromMs and toMs required (ms since epoch)" });
  }
  const events = await store.query(streamId, fromMs, toMs);
  res.json({ streamId, fromMs, toMs, events });
});


  return router;
}
