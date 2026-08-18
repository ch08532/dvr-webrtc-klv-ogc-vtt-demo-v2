import { Router } from "express";

/**
 * Browser uploads, server-local video import, and input probing.
 *
 * Filesystem, streaming, and source-lifecycle primitives are injected by the
 * service so this HTTP layer does not own deployment-specific source roots.
 */
export function createUploadsRouter(deps) {
  const {
    path, fs, Transform, pipeline, randomUUID, VIDEO_UPLOAD_EXTENSIONS,
    MAX_UPLOAD_BYTES, activeResumableUploads, resumableUploadPaths,
    listLocalServerVideos, copyLocalServerVideo, currentSourceState, sources,
    getSourceRuntime, assertStreamIdAvailable, allocateStreamId, allocateSourcePreparation, loadResumableUpload,
    sendUploadOffset, resolveSourceAssetDir, probeInputWithFfprobe, log,
    serializeError
  } = deps;
  const router = Router();

// Backing stream IDs are service-owned. The UI requests one only when it is
// about to provision a product or upload its authoritative source file.
router.post("/sources/allocate", async (req, res) => {
  try {
    const preparation = allocateSourcePreparation
      ? await allocateSourcePreparation({ missionId: req.body?.missionId, sourceType: req.body?.sourceType })
      : { streamId: await allocateStreamId(), productId: null };
    log.info("source_workspace_allocated", { requestId: req.requestId, streamId: preparation.streamId, productId: preparation.productId });
    return res.status(201).json({ ok: true, streamId: preparation.streamId, productId: preparation.productId });
  } catch (error) {
    log.warn("source_stream_allocate_error", { requestId: req.requestId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Creates a resumable session; bytes are appended by PATCH below.
// Resumable uploads are persisted below each stream's source/ directory so the
// browser can continue a large upload after a network interruption or reload.
router.post("/uploads/video/resumable", async (req, res) => {
  const streamId = String(req.body?.streamId || "").trim();
  const uploadName = String(req.body?.filename || "").trim();
  const extension = path.extname(uploadName).toLowerCase();
  const sizeBytes = Number(req.body?.sizeBytes);
  if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) {
    return res.status(400).json({ ok: false, error: "supported video extensions: .ts, .m2ts, .mp4, .mov, .mkv" });
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: `video must be between 1 byte and ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB` });
  }

  const uploadId = randomUUID();
  const assetId = `${randomUUID()}${extension}`;
  let paths;
  try {
    await assertStreamIdAvailable(streamId, { allowPreparation: true });
    paths = resumableUploadPaths(streamId, uploadId);
    await fs.promises.mkdir(paths.uploadDir, { recursive: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const session = {
    uploadId,
    streamId,
    assetId,
    uploadName: path.basename(uploadName),
    sizeBytes,
    createdAt: new Date().toISOString()
  };
  try {
    await fs.promises.writeFile(paths.metaPath, JSON.stringify(session), { encoding: "utf8", flag: "wx" });
    log.info("resumable_upload_created", { requestId: req.requestId, streamId, uploadId, assetId, sizeBytes });
    return res.status(201).json({
      ok: true,
      uploadId,
      offset: 0,
      uploadUrl: `/uploads/video/resumable/${encodeURIComponent(streamId)}/${uploadId}`
    });
  } catch (error) {
    log.warn("resumable_upload_create_error", { requestId: req.requestId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Drives the Local server file picker. Only configured-root contents are sent
// to the browser; the copy endpoint independently validates each selection.
router.get("/uploads/video/local-files", async (req, res) => {
  try {
    const files = await listLocalServerVideos();
    return res.json({ ok: true, files });
  } catch (error) {
    log.warn("local_video_list_error", { requestId: req.requestId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Copies a server-local video into the same authoritative source location used
// by browser uploads, avoiding an HTTP transfer through the browser.
router.post("/uploads/video/local-copy", async (req, res) => {
  const streamId = String(req.body?.streamId || "").trim();
  const inputPath = typeof req.body?.inputPath === "string" ? req.body.inputPath : "";
  try {
    await assertStreamIdAvailable(streamId, { allowPreparation: true });
    const copied = await copyLocalServerVideo(streamId, inputPath);
    log.info("local_video_copy_complete", {
      requestId: req.requestId,
      streamId,
      assetId: copied.assetId,
      sourceFilename: copied.sourceFilename,
      sizeBytes: copied.sizeBytes
    });
    return res.status(201).json({ ok: true, ...copied });
  } catch (error) {
    log.warn("local_video_copy_error", { requestId: req.requestId, streamId, error: serializeError(error) });
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

// The browser calls this first on every Start Source action. It is a
// non-destructive preflight: retained stream data is deleted only with its
// mission product, never to make room for another source.
router.post("/sources/:streamId/reset", async (req, res) => {
  const streamId = req.params.streamId;
  const state = currentSourceState(streamId);
  if (sources.has(streamId) || ["starting", "running", "degraded", "stopping", "finalizing", "ready"].includes(state)) {
    return res.status(409).json({
      ok: false,
      error: `source ${streamId} is currently ${state}; stop it before starting again`,
      state: getSourceRuntime(streamId)
    });
  }
  try {
    await assertStreamIdAvailable(streamId, { allowPreparation: true });
    log.info("source_start_preflight_complete", { streamId });
    return res.json({ ok: true, retainedData: true });
  } catch (error) {
    log.warn("source_start_preflight_error", { streamId, error: serializeError(error) });
    return res.status(error?.statusCode || 400).json({ ok: false, error: String(error?.message || error) });
  }
});

router.head("/uploads/video/resumable/:streamId/:uploadId", async (req, res) => {
  try {
    const { offset } = await loadResumableUpload(req.params.streamId, req.params.uploadId);
    return sendUploadOffset(res, offset);
  } catch (error) {
    return res.status(404).end();
  }
});

// The in-memory set blocks concurrent writes; the persisted offset remains
// the source of truth for retries and browser reconnects.
router.patch("/uploads/video/resumable/:streamId/:uploadId", async (req, res) => {
  const uploadId = req.params.uploadId;
  let loaded;
  try {
    loaded = await loadResumableUpload(req.params.streamId, uploadId);
  } catch (error) {
    return res.status(404).json({ ok: false, error: String(error?.message || error) });
  }

  const expectedOffset = Number(req.headers["upload-offset"]);
  if (!Number.isSafeInteger(expectedOffset) || expectedOffset < 0) {
    return res.status(400).json({ ok: false, error: "Upload-Offset must be a non-negative integer" });
  }
  if (expectedOffset !== loaded.offset) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload offset does not match server state" });
  }
  if (activeResumableUploads.has(uploadId)) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload is already writing" });
  }

  const remainingBytes = loaded.session.sizeBytes - loaded.offset;
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && (declaredLength < 0 || declaredLength > remainingBytes)) {
    return res.status(413).json({ ok: false, error: "upload chunk exceeds the remaining file size" });
  }

  activeResumableUploads.add(uploadId);
  let receivedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk, _encoding, callback) {
      if (receivedBytes + chunk.length > remainingBytes) {
        const error = new Error("upload chunk exceeds the remaining file size");
        error.code = "UPLOAD_SIZE_LIMIT";
        callback(error);
        return;
      }
      receivedBytes += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, byteLimit, fs.createWriteStream(loaded.partPath, { flags: "a" }));
    const nextOffset = loaded.offset + receivedBytes;
    log.debug("resumable_upload_chunk_complete", { requestId: req.requestId, uploadId, receivedBytes, nextOffset });
    return sendUploadOffset(res, nextOffset);
  } catch (error) {
    const current = await loadResumableUpload(req.params.streamId, uploadId).catch(() => ({ offset: loaded.offset }));
    res.set("Upload-Offset", String(current.offset));
    const status = error?.code === "UPLOAD_SIZE_LIMIT" ? 413 : 500;
    log.warn("resumable_upload_chunk_error", { requestId: req.requestId, uploadId, error: serializeError(error) });
    return res.status(status).json({ ok: false, error: String(error?.message || error) });
  } finally {
    activeResumableUploads.delete(uploadId);
  }
});

router.post("/uploads/video/resumable/:streamId/:uploadId/complete", async (req, res) => {
  const uploadId = req.params.uploadId;
  if (activeResumableUploads.has(uploadId)) {
    return res.status(409).json({ ok: false, error: "upload is still writing" });
  }
  let loaded;
  try {
    loaded = await loadResumableUpload(req.params.streamId, uploadId);
  } catch (error) {
    return res.status(404).json({ ok: false, error: String(error?.message || error) });
  }
  if (loaded.offset !== loaded.session.sizeBytes) {
    res.set("Upload-Offset", String(loaded.offset));
    return res.status(409).json({ ok: false, error: "upload is incomplete" });
  }

  const destinationPath = path.join(loaded.sourceDir, loaded.session.assetId);
  try {
    await fs.promises.rename(loaded.partPath, destinationPath);
    await fs.promises.rm(loaded.metaPath, { force: true });
    log.info("resumable_upload_complete", {
      requestId: req.requestId,
      uploadId,
      assetId: loaded.session.assetId,
      receivedBytes: loaded.offset
    });
    return res.status(201).json({ ok: true, assetId: loaded.session.assetId, sizeBytes: loaded.offset });
  } catch (error) {
    log.warn("resumable_upload_complete_error", { requestId: req.requestId, uploadId, error: serializeError(error) });
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Backward-compatible single-request upload for non-resumable clients.
router.post("/uploads/video", async (req, res) => {
  const streamId = String(req.headers["x-upload-stream-id"] || "").trim();
  const uploadName = decodeURIComponent(String(req.headers["x-upload-filename"] || ""));
  const extension = path.extname(uploadName).toLowerCase();
  const contentLength = Number(req.headers["content-length"]);

  if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) {
    return res.status(400).json({ ok: false, error: "supported video extensions: .ts, .m2ts, .mp4, .mov, .mkv" });
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ ok: false, error: `video exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit` });
  }

  const assetId = `${randomUUID()}${extension}`;
  let sourceDir;
  try {
    sourceDir = resolveSourceAssetDir(streamId);
    await fs.promises.mkdir(sourceDir, { recursive: true });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
  const temporaryPath = path.join(sourceDir, `${assetId}.upload`);
  const destinationPath = path.join(sourceDir, assetId);
  let receivedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_UPLOAD_BYTES) {
        callback(new Error(`video exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit`));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, byteLimit, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    if (!receivedBytes) throw new Error("uploaded video file is empty");
    await fs.promises.rename(temporaryPath, destinationPath);
    log.info("video_upload_complete", { requestId: req.requestId, streamId, assetId, receivedBytes });
    res.status(201).json({ ok: true, assetId, sizeBytes: receivedBytes });
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    const message = String(error?.message || error);
    const status = message.includes("upload limit") ? 413 : 400;
    log.warn("video_upload_error", { requestId: req.requestId, error: serializeError(error) });
    res.status(status).json({ ok: false, error: message });
  }
});

router.post("/probe/input", async (req, res) => {
  const inputUrl = typeof req.body?.inputUrl === "string" ? req.body.inputUrl.trim() : "";
  if (!inputUrl) {
    return res.status(400).json({ ok: false, error: "inputUrl required" });
  }

  try {
    const probe = await probeInputWithFfprobe(inputUrl);
    const available = probe.hasVideo;
    log.info("input_probe_result", {
      inputUrl,
      available,
      klvAvailable: !!probe.klv?.available,
      klvConfidence: probe.klv?.confidence || "none",
      container: probe.container?.name || null,
      codec: probe.video?.codec || null,
      width: probe.video?.width ?? null,
      height: probe.video?.height ?? null,
      fps: probe.video?.fps ?? null
    });

    return res.json({
      ok: true,
      available,
      indicator: available ? "green" : "red",
      reason: available ? "video_stream_found" : "video_stream_not_found",
      inputUrl: probe.inputUrl,
      container: probe.container,
      video: probe.video,
      klv: probe.klv,
      streamCount: probe.streamCount,
      testedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = String(error?.message || error);
    log.warn("input_probe_error", { inputUrl, error: serializeError(error) });
    return res.json({
      ok: true,
      available: false,
      indicator: "red",
      reason: "probe_failed",
      inputUrl,
      error: message,
      klv: {
        available: false,
        confidence: "none",
        streamCount: 0,
        streams: []
      },
      testedAt: new Date().toISOString()
    });
  }
});


  return router;
}
