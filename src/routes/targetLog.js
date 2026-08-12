import { Router } from "express";
import { randomUUID } from "node:crypto";

/**
 * Stream-scoped mission target-log API.
 *
 * Dependencies remain explicit so route behavior is owned by the service, not
 * module globals. Entries retain a mission timestamp and, when known, its
 * matching playable video offset.
 */
export function createTargetLogRouter({ store, log, serializeError, resolveStreamRecordingDir }) {
  const router = Router();
  const validateStreamId = (streamId) => {
    resolveStreamRecordingDir(streamId);
    return streamId;
  };
  const hasValue = (value) => value !== undefined && value !== null && value !== "";

  /** Validates active values while retaining historic values from inactive fields. */
  async function normalizeCustomFields(streamId, suppliedFields, existingFields = {}) {
    if (suppliedFields != null && (typeof suppliedFields !== "object" || Array.isArray(suppliedFields))) {
      throw new Error("customFields must be an object");
    }
    const { fields } = await store.getTargetLog(streamId);
    const result = { ...(existingFields || {}) };
    const supplied = suppliedFields || {};
    for (const field of fields) {
      if (field.active && Object.prototype.hasOwnProperty.call(supplied, field.key)) {
        const raw = supplied[field.key];
        if (!hasValue(raw)) delete result[field.key];
        else if (field.dataType === "number") {
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) throw new Error(`${field.label} must be a number`);
          result[field.key] = numeric;
        } else if (field.dataType === "boolean") {
          if (raw !== true && raw !== false) throw new Error(`${field.label} must be true or false`);
          result[field.key] = raw;
        } else result[field.key] = String(raw);
      }
      if (field.required && !hasValue(result[field.key])) throw new Error(`${field.label} is required`);
    }
    return result;
  }

  /** Resolves a video offset only within known KLV/manual-anchor coverage. */
  async function videoTimeForMissionTime(streamId, missionTimeMs) {
    const timeline = await store.getMissionTimeline(streamId);
    if (timeline && missionTimeMs >= timeline.missionMinMs && missionTimeMs <= timeline.missionMaxMs) {
      const videoTimeMs = Math.round(timeline.videoBaseMs + (missionTimeMs - timeline.missionBaseMs));
      return Number.isFinite(videoTimeMs) && videoTimeMs >= 0 ? videoTimeMs : null;
    }
    const manualAnchor = await store.getManualVideoTimeAnchor(streamId);
    if (!manualAnchor || missionTimeMs < manualAnchor.firstFrameUtcMs) return null;
    const videoTimeMs = Math.round(missionTimeMs - manualAnchor.firstFrameUtcMs);
    return Number.isFinite(videoTimeMs) && videoTimeMs >= 0 ? videoTimeMs : null;
  }

  // Returns the active field schema and entries together to keep the UI synced.
  router.get("/streams/:streamId/target-log", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      res.json({ ok: true, streamId, ...(await store.getTargetLog(streamId)) });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });

  router.post("/streams/:streamId/target-log/entries", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      const missionTimeMs = Math.round(Number(req.body?.missionTimeMs));
      if (!Number.isFinite(missionTimeMs) || missionTimeMs < 0) throw new Error("missionTimeMs must be a non-negative number");
      const videoTimeMs = await videoTimeForMissionTime(streamId, missionTimeMs);
      const customFields = await normalizeCustomFields(streamId, req.body?.customFields);
      const entry = await store.createTargetLogEntry({
        id: randomUUID(), streamId,
        missionId: req.body?.missionId == null ? null : String(req.body.missionId),
        videoProductId: req.body?.videoProductId == null ? null : String(req.body.videoProductId),
        missionTimeMs, videoTimeMs,
        observation: req.body?.observation == null ? "" : String(req.body.observation),
        position: req.body?.position, positionSource: req.body?.positionSource,
        customFields, createdBy: req.body?.createdBy == null ? null : String(req.body.createdBy)
      });
      log.info("target_log_entry_created", { streamId, entryId: entry.id, missionTimeMs: entry.missionTimeMs, videoTimeMs: entry.videoTimeMs });
      res.status(201).json({ ok: true, entry });
    } catch (error) {
      log.warn("target_log_entry_create_error", { streamId: req.params.streamId, error: serializeError(error) });
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // Omitted custom fields retain their prior value; supplied active fields validate.
  router.patch("/streams/:streamId/target-log/entries/:entryId", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      const existing = await store.getTargetLogEntry(streamId, req.params.entryId);
      if (!existing) return res.status(404).json({ ok: false, error: "target-log entry not found" });
      const customFields = await normalizeCustomFields(streamId, req.body?.customFields, existing.customFields);
      const missionTimeMs = req.body?.missionTimeMs == null ? undefined : Math.round(Number(req.body.missionTimeMs));
      if (missionTimeMs !== undefined && (!Number.isFinite(missionTimeMs) || missionTimeMs < 0)) throw new Error("missionTimeMs must be a non-negative number");
      const entry = await store.updateTargetLogEntry(streamId, req.params.entryId, {
        observation: req.body?.observation, customFields, position: req.body?.position, positionSource: req.body?.positionSource,
        missionTimeMs, videoTimeMs: missionTimeMs === undefined ? undefined : await videoTimeForMissionTime(streamId, missionTimeMs)
      });
      res.json({ ok: true, entry });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });

  router.delete("/streams/:streamId/target-log/entries/:entryId", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      const deleted = await store.deleteTargetLogEntry(streamId, req.params.entryId);
      if (!deleted) return res.status(404).json({ ok: false, error: "target-log entry not found" });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });

  // Schema fields are soft-deactivated later, preserving old-entry metadata.
  router.post("/streams/:streamId/target-log/fields", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      const field = await store.createTargetLogField({ id: randomUUID(), streamId, key: req.body?.key, label: req.body?.label, dataType: req.body?.dataType, required: !!req.body?.required });
      res.status(201).json({ ok: true, field });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });

  router.delete("/streams/:streamId/target-log/fields/:fieldId", async (req, res) => {
    try {
      const streamId = validateStreamId(req.params.streamId);
      const deactivated = await store.deactivateTargetLogField(streamId, req.params.fieldId);
      if (!deactivated) return res.status(404).json({ ok: false, error: "target-log field not found" });
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  return router;
}
