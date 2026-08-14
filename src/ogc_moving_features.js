/** Registers the small OGC API Moving Features subset backed by KLV storage. */

/** Parses an ISO date/time string into milliseconds, if valid. */
function parseTime(x) {
  if (x == null) return NaN;
  const s = String(x).trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** Parses an OGC datetime instant or interval query parameter. */
function parseDatetimeParam(datetime) {
  const DEFAULT_WINDOW_MS = 60_000;
  if (!datetime) {
    const now = Date.now();
    return { fromMs: now - DEFAULT_WINDOW_MS, toMs: now };
  }
  const parts = String(datetime).split("/");
  if (parts.length === 1) {
    const t = parseTime(parts[0]);
    if (!Number.isFinite(t)) return null;
    return { fromMs: t - DEFAULT_WINDOW_MS / 2, toMs: t + DEFAULT_WINDOW_MS / 2 };
  }
  const a = parseTime(parts[0]);
  const b = parseTime(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { fromMs: Math.min(a, b), toMs: Math.max(a, b) };
}

/** Converts a stored millisecond timestamp to an OGC-compatible ISO timestamp. */
function toIso(ms) { return new Date(ms).toISOString(); }

/** Selects the requested KLV-derived geometry for an OGC moving feature. */
function pickGeometry(mFeatureId, decoded) {
  if (mFeatureId === "platform") {
    const lat = decoded.sensorLat;
    const lon = decoded.sensorLon;
    if (lat == null || lon == null) return null;
    return { type: "Point", coordinates: [lon, lat] };
  }
  if (mFeatureId === "frameCenter") {
    const lat = decoded.frameCenterLat;
    const lon = decoded.frameCenterLon;
    if (lat == null || lon == null) return null;
    return { type: "Point", coordinates: [lon, lat] };
  }
  return null;
}

/** Creates the OGC collection metadata for one supported moving-feature track. */
function featureItem(collectionId, mFeatureId) {
  return {
    type: "Feature",
    id: mFeatureId,
    geometry: null,
    properties: {
      collectionId,
      mFeatureId,
      title: mFeatureId === "platform"
        ? "Platform position (sensor lat/lon)"
        : "Frame center position"
    },
    links: [
      { rel: "tgsequence", href: `/ogc/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(mFeatureId)}/tgsequence` },
      { rel: "tproperties", href: `/ogc/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(mFeatureId)}/tproperties` }
    ]
  };
}

/** Adds discovery, collection, feature, and trajectory routes to Express. */
export function registerOgcMovingFeaturesRoutes(app, { sources, store }) {
  app.get("/ogc", (req, res) => {
    res.json({
      title: "OGC API – Moving Features and Processes (demo subset)",
      links: [
        { rel: "collections", href: "/ogc/collections" },
        { rel: "processes", href: "/ogc/processes", type: "application/json" },
        { rel: "conformance", href: "/ogc/conformance", type: "application/json" }
      ]
    });
  });

  app.get("/ogc/collections", (req, res) => {
    const collections = [...sources.values()].map(s => ({
      id: s.streamId,
      title: `Moving Features for ${s.streamId}`,
      description: "Derived from MISB ST0601 decoded telemetry stored in SQLite.",
      links: [{ rel: "items", href: `/ogc/collections/${encodeURIComponent(s.streamId)}/items` }]
    }));
    res.json({ collections, links: [{ rel: "self", href: "/ogc/collections" }] });
  });

  app.get("/ogc/collections/:collectionId/items", (req, res) => {
    const collectionId = req.params.collectionId;
    if (!sources.has(collectionId)) {
      return res.status(404).json({ error: "collection not found (streamId not running)" });
    }
    res.json({
      type: "FeatureCollection",
      features: [
        featureItem(collectionId, "platform"),
        featureItem(collectionId, "frameCenter")
      ],
      links: [{ rel: "self", href: `/ogc/collections/${encodeURIComponent(collectionId)}/items` }]
    });
  });

  app.get("/ogc/collections/:collectionId/items/:mFeatureId/tgsequence", async (req, res) => {
    const { collectionId, mFeatureId } = req.params;
    if (!sources.has(collectionId)) return res.status(404).json({ error: "collection not found (streamId not running)" });
    if (!["platform", "frameCenter"].includes(mFeatureId)) return res.status(404).json({ error: "unknown mFeatureId" });

    const dt = parseDatetimeParam(req.query.datetime);
    if (!dt) return res.status(400).json({ error: "invalid datetime (use ISO or ms, optionally start/end)" });

    const rows = await store.query(collectionId, dt.fromMs, dt.toMs);

    const samples = [];
    for (const r of rows) {
      const geom = pickGeometry(mFeatureId, r.data);
      if (!geom) continue;
      samples.push({ tMs: r.tMs, time: toIso(r.tMs), geometry: geom });
    }

    res.json({
      type: "TemporalGeometrySequence",
      id: mFeatureId,
      collectionId,
      datetime: { from: toIso(dt.fromMs), to: toIso(dt.toMs) },
      geometryType: "Point",
      positions: samples.map(s => s.geometry.coordinates),
      times: samples.map(s => s.time),
      features: samples.map(s => ({
        type: "Feature",
        geometry: s.geometry,
        properties: { time: s.time, tMs: s.tMs }
      })),
      links: [{ rel: "self", href: req.originalUrl }]
    });
  });

  app.get("/ogc/collections/:collectionId/items/:mFeatureId/tproperties", async (req, res) => {
    const { collectionId, mFeatureId } = req.params;
    if (!sources.has(collectionId)) return res.status(404).json({ error: "collection not found (streamId not running)" });
    if (!["platform", "frameCenter"].includes(mFeatureId)) return res.status(404).json({ error: "unknown mFeatureId" });

    const dt = parseDatetimeParam(req.query.datetime);
    if (!dt) return res.status(400).json({ error: "invalid datetime (use ISO or ms, optionally start/end)" });

    const rows = await store.query(collectionId, dt.fromMs, dt.toMs);

    const selectors = (mFeatureId === "platform")
      ? [
          ["platformHeadingDeg", "platformHeadingDeg"],
          ["platformPitchDeg", "platformPitchDeg"],
          ["platformRollDeg", "platformRollDeg"],
          ["sensorAltMslM", "sensorAltMslM"],
          ["sensorRelAzDeg", "sensorRelAzDeg"],
          ["sensorRelElDeg", "sensorRelElDeg"]
        ]
      : [
          ["sensorHfovDeg", "sensorHfovDeg"],
          ["sensorVfovDeg", "sensorVfovDeg"],
          ["slantRangeM", "slantRangeM"],
          ["sensorRelAzDeg", "sensorRelAzDeg"],
          ["sensorRelElDeg", "sensorRelElDeg"]
        ];

    const times = [];
    const series = {};
    for (const [key] of selectors) series[key] = [];

    for (const r of rows) {
      const geom = pickGeometry(mFeatureId, r.data);
      if (!geom) continue;
      times.push(toIso(r.tMs));
      for (const [key, src] of selectors) series[key].push(r.data[src] ?? null);
    }

    res.json({
      type: "TemporalProperties",
      id: mFeatureId,
      collectionId,
      datetime: { from: toIso(dt.fromMs), to: toIso(dt.toMs) },
      times,
      properties: series,
      links: [{ rel: "self", href: req.originalUrl }]
    });
  });
}
