import { Router } from "express";

/**
 * Source inventory, runtime state, and manual no-KLV time anchors.
 *
 * The router receives service-owned state and helpers rather than importing
 * server globals, which makes the HTTP boundary explicit and testable.
 */
export function createSourcesRouter({
  sources, sourceStates, getSourceRuntime, currentSourceState, store,
  setSourceState, resolveStreamRecordingDir
}) {
  const router = Router();
  const validateStreamId = (streamId) => {
    // Use the recording-root guard before any storage operation.
    resolveStreamRecordingDir(streamId);
    return streamId;
  };
// Includes transient start/stop entries that have not yet created a source.
router.get("/sources", (req, res) => {
  const list = [...sources.values()].map((s) => ({
    streamId: s.streamId,
    inputUrl: s.inputUrl,
    sourceType: s.sourceType,
    webRtcAvailable: s.sourceType !== "file",
    hlsMode: s.hlsMode,
    hlsEffectiveMode: s.hlsEffectiveMode,
    hlsFallbackReason: s.hlsFallbackReason,
    webRtcMode: s.webRtcMode,
    hlsEncoderMode: s.hlsEncoderMode,
    webRtcEncoderMode: s.webRtcEncoderMode,
    mode: s.mode,
    hlsSegmentSeconds: s.hlsSegmentSeconds,
    vttSegmentSeconds: s.vttSegmentSeconds,
    hlsMasterUrl: `/hls/${s.streamId}/master.m3u8`,
    posterUrl: s.poster?.state === "ready" ? `/hls/${encodeURIComponent(s.streamId)}/poster.jpg?v=${encodeURIComponent(s.poster.updatedAt)}` : null,
    posterState: s.poster?.state || "pending",
    webrtcReady: !!s.webrtc?.producerId,
    ...getSourceRuntime(s.streamId)
  }));

  for (const [streamId, tracked] of sourceStates.entries()) {
    if (sources.has(streamId)) continue;
    if (tracked?.state !== "starting" && tracked?.state !== "stopping") continue;
    list.push({
      streamId,
      inputUrl: tracked?.inputUrl || null,
      sourceType: tracked?.sourceType || "stream",
      webRtcAvailable: tracked?.webRtcAvailable !== false,
      hlsMode: tracked?.hlsMode || null,
      hlsEffectiveMode: tracked?.hlsEffectiveMode || null,
      hlsFallbackReason: tracked?.hlsFallbackReason || null,
      webRtcMode: tracked?.webRtcMode || null,
      hlsEncoderMode: tracked?.hlsEncoderMode || null,
      webRtcEncoderMode: tracked?.webRtcEncoderMode || null,
      mode: tracked?.mode || null,
      hlsSegmentSeconds: tracked?.hlsSegmentSeconds || null,
      vttSegmentSeconds: tracked?.vttSegmentSeconds || null,
      hlsMasterUrl: `/hls/${streamId}/master.m3u8`,
      webrtcReady: false,
      ...getSourceRuntime(streamId)
    });
  }
  res.json(list);
});

// Lightweight polling endpoint used while a source is changing state.
router.get("/sources/:streamId/state", (req, res) => {
  res.json(getSourceRuntime(req.params.streamId));
});

/** Saves a UTC anchor for the first presentation frame of a no-KLV file source. */
router.put("/sources/:streamId/manual-video-time-anchor", async (req, res) => {
  try {
    const streamId = validateStreamId(req.params.streamId);
    const source = sources.get(streamId);
    const state = currentSourceState(streamId);
    if (!source || source.sourceType !== "file" || source.klvProcessingRequired !== false) {
      return res.status(409).json({ ok: false, error: "mission timestamp is available only for file sources with confirmed no KLV" });
    }
    if (!["running", "finalizing", "ready"].includes(state)) {
      return res.status(409).json({ ok: false, error: "mission timestamp is available once the file is playable" });
    }
    const anchor = await store.setManualVideoTimeAnchor(streamId, req.body?.firstFrameUtcMs);
    setSourceState(streamId, { manualVideoStartUtcMs: anchor.firstFrameUtcMs });
    res.json({ ok: true, streamId, manualVideoStartUtcMs: anchor.firstFrameUtcMs, updatedAt: anchor.updatedAt, state: getSourceRuntime(streamId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

/** Clears an operator-supplied no-KLV first-frame UTC anchor. */
router.delete("/sources/:streamId/manual-video-time-anchor", async (req, res) => {
  try {
    const streamId = validateStreamId(req.params.streamId);
    const source = sources.get(streamId);
    if (!source || source.sourceType !== "file" || source.klvProcessingRequired !== false) {
      return res.status(409).json({ ok: false, error: "mission timestamp is available only for file sources with confirmed no KLV" });
    }
    await store.clearManualVideoTimeAnchor(streamId);
    setSourceState(streamId, { manualVideoStartUtcMs: null });
    res.json({ ok: true, streamId, manualVideoStartUtcMs: null, state: getSourceRuntime(streamId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});


  return router;
}
