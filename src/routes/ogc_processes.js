import { Router } from "express";
import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["successful", "failed", "dismissed"]);
const SOURCE_PROCESS_IDS = new Set(["provision-live-fmv", "package-fmv-file"]);

const jsonLink = (href, title) => ({ href, rel: "item", type: "application/json", title });

/**
 * Minimal OGC API - Processes Core implementation.  Jobs deliberately have a
 * service lifetime: a completed provisioning job describes the session it
 * created, but is never the owner of that continuing source session.
 */
export function createOgcProcessesRouter({ startSourceRuntime, stopSourceRuntime, createFileClipRuntime, getSourceRuntime, subscribeSourceState }) {
  const router = Router();
  const jobs = new Map();

  const processDefinitions = {
    "provision-live-fmv": {
      id: "provision-live-fmv",
      title: "Provision live FMV",
      description: "Starts live ingest, HLS/KLV processing, and a WebRTC producer. The job completes once the source is running.",
      inputs: {
        streamId: { schema: { type: "string" } },
        inputUrl: { schema: { type: "string", format: "uri" } },
        hlsMode: { schema: { type: "string", enum: ["passthrough", "abr"], default: "passthrough" } },
        webRtcMode: { schema: { type: "string", enum: ["auto", "copy", "transcode"], default: "auto" } },
        hlsSegmentSeconds: { schema: { type: "number", default: 1 } },
        vttSegmentSeconds: { schema: { type: "number", default: 5 } },
        maxCuesPerSecond: { schema: { type: "number", default: 10 } },
        minCueDurSec: { schema: { type: "number", default: 0.1 } },
        maxCueDurSec: { schema: { type: "number", default: 0.5 } }
      },
      outputs: { sourceSession: { schema: { type: "object" } } }
    },
    "package-fmv-file": {
      id: "package-fmv-file",
      title: "Package FMV file",
      description: "Packages an uploaded FMV asset into HLS, VTT, and Moving Features resources. The job completes when finalization is ready.",
      inputs: {
        streamId: { schema: { type: "string" } },
        assetId: { schema: { type: "string" } },
        hlsMode: { schema: { type: "string", enum: ["passthrough", "abr"], default: "passthrough" } },
        hlsSegmentSeconds: { schema: { type: "number", default: 1 } },
        vttSegmentSeconds: { schema: { type: "number", default: 5 } },
        maxCuesPerSecond: { schema: { type: "number", default: 10 } },
        minCueDurSec: { schema: { type: "number", default: 0.1 } },
        maxCueDurSec: { schema: { type: "number", default: 0.5 } }
      },
      outputs: { sourceSession: { schema: { type: "object" } } }
    },
    "export-klv": {
      id: "export-klv",
      title: "Export KLV telemetry",
      description: "Publishes a link to a CSV or KML export of a source's canonical KLV telemetry.",
      inputs: { streamId: { schema: { type: "string" } }, format: { schema: { type: "string", enum: ["csv", "kml"], default: "csv" } } },
      outputs: { telemetryExport: { schema: { type: "string", format: "uri" } } }
    },
    "export-clip": {
      id: "export-clip",
      title: "Export FMV clip",
      description: "Creates an exported clip from the existing source clip service.",
      inputs: { streamId: { schema: { type: "string" } }, startSeconds: { schema: { type: "number" } }, endSeconds: { schema: { type: "number" } } },
      outputs: { clip: { schema: { type: "object" } } }
    }
  };

  const base = "/ogc";
  const jobUrl = (id) => `${base}/jobs/${encodeURIComponent(id)}`;
  const sourceUrl = (streamId) => `/sources/${encodeURIComponent(streamId)}/state`;
  const sessionResult = (streamId, { live }) => ({
    sourceSession: {
      streamId,
      sourceState: jsonLink(sourceUrl(streamId), "Source lifecycle state"),
      hlsMaster: { href: `/hls/${encodeURIComponent(streamId)}/master.m3u8`, rel: "enclosure", type: "application/vnd.apple.mpegurl", title: "HLS master playlist" },
      subtitles: { href: `/hls/${encodeURIComponent(streamId)}/subtitles.m3u8`, rel: "alternate", type: "application/vnd.apple.mpegurl", title: "KLV WebVTT subtitles" },
      movingFeatures: jsonLink(`/ogc/collections/${encodeURIComponent(streamId)}`, "OGC Moving Features collection"),
      ...(live ? {
        webrtc: {
          rtpCapabilities: jsonLink("/webrtc/rtpCapabilities", "WebRTC RTP capabilities"),
          createTransport: { href: "/webrtc/createTransport", rel: "service", type: "application/json", title: "WebRTC signaling entry point" }
        }
      } : {
        poster: { href: `/hls/${encodeURIComponent(streamId)}/poster.jpg`, rel: "preview", type: "image/jpeg", title: "Source poster" }
      })
    }
  });

  const linksForJob = (job) => [
    { href: jobUrl(job.id), rel: "self", type: "application/json" },
    { href: `${jobUrl(job.id)}/results`, rel: "results", type: "application/json" },
    ...(job.streamId ? [jsonLink(sourceUrl(job.streamId), "Source lifecycle state")] : [])
  ];
  const publicJob = (job) => ({
    processID: job.processId,
    type: "process",
    jobID: job.id,
    status: job.status,
    message: job.message,
    progress: job.progress,
    created: job.created,
    started: job.started || null,
    finished: job.finished || null,
    links: linksForJob(job)
  });
  const setStatus = (job, status, { message, progress, results } = {}) => {
    if (TERMINAL.has(job.status)) return;
    job.status = status;
    job.message = message ?? job.message;
    job.progress = progress ?? job.progress;
    if (results) job.results = results;
    if (status === "running" && !job.started) job.started = new Date().toISOString();
    if (TERMINAL.has(status)) job.finished = new Date().toISOString();
  };
  const fail = (job, message) => setStatus(job, "failed", { message, progress: 100 });
  const finishSourceJob = (job, state) => {
    const live = job.processId === "provision-live-fmv";
    const ready = live ? state.state === "running" : state.state === "ready";
    if (ready) setStatus(job, "successful", { message: "Source session is ready", progress: 100, results: sessionResult(job.streamId, { live }) });
    else if (["degraded", "error", "stopped"].includes(state.state)) fail(job, state.lastError || `Source entered ${state.state}`);
  };
  const executeSourceJob = async (job) => {
    const live = job.processId === "provision-live-fmv";
    try {
      setStatus(job, "running", { message: "Provisioning source session", progress: 10 });
      const body = { ...job.inputs, sourceType: live ? "stream" : "file" };
      if (!live) delete body.webRtcMode;
      const created = await startSourceRuntime(body, job.requestId);
      job.streamId = created.streamId;
      // Dismissal can arrive while FFmpeg/SFU startup is awaiting.  In that
      // case the source was not yet stoppable at DELETE time, so stop it now.
      if (job.status === "dismissed") {
        await stopSourceRuntime(created.streamId).catch(() => {});
        return;
      }
      finishSourceJob(job, created.state || getSourceRuntime(created.streamId));
      if (!TERMINAL.has(job.status)) {
        job.message = live ? "Waiting for live ingest" : "Packaging and finalizing FMV file";
        job.progress = live ? 75 : 50;
      }
    } catch (error) {
      fail(job, String(error?.message || error));
    }
  };
  const executeExport = async (job) => {
    try {
      setStatus(job, "running", { message: "Preparing export", progress: 25 });
      const { streamId } = job.inputs;
      if (!streamId) return fail(job, "streamId is required");
      if (job.processId === "export-klv") {
        const format = job.inputs.format || "csv";
        if (!["csv", "kml"].includes(format)) return fail(job, "format must be csv or kml");
        setStatus(job, "successful", {
          message: "Telemetry export is available",
          progress: 100,
          results: { telemetryExport: { href: `/streams/${encodeURIComponent(streamId)}/klv/export.${format}`, rel: "enclosure", type: format === "csv" ? "text/csv" : "application/vnd.google-earth.kml+xml" } }
        });
        return;
      }
      if (!createFileClipRuntime) return fail(job, "Clip export is unavailable");
      const created = await createFileClipRuntime(streamId, job.inputs);
      const { path: _privatePath, ...clip } = created.clip;
      setStatus(job, "successful", {
        message: "Clip export is available",
        progress: 100,
        results: { clip: { ...clip, href: clip.downloadUrl, rel: "enclosure", type: "video/mp2t" } }
      });
    } catch (error) {
      fail(job, String(error?.message || error));
    }
  };
  const execute = (job) => {
    queueMicrotask(() => {
      if (job.status === "dismissed") return;
      if (SOURCE_PROCESS_IDS.has(job.processId)) void executeSourceJob(job);
      else void executeExport(job);
    });
  };

  subscribeSourceState?.((state) => {
    for (const job of jobs.values()) {
      if (job.streamId === state.streamId && SOURCE_PROCESS_IDS.has(job.processId) && !TERMINAL.has(job.status)) finishSourceJob(job, state);
    }
  });
  router.get("/", (_req, res) => res.json({ title: "OGC API - Processes", links: [
    { href: `${base}/conformance`, rel: "conformance", type: "application/json" },
    { href: `${base}/processes`, rel: "processes", type: "application/json" },
    { href: `${base}/jobs`, rel: "jobs", type: "application/json" }
  ] }));
  router.get("/conformance", (_req, res) => res.json({ conformsTo: ["http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core"] }));
  router.get("/processes", (_req, res) => res.json({ processes: Object.values(processDefinitions).map((definition) => ({ ...definition, jobControlOptions: ["async-execute"], outputTransmission: ["value", "reference"], links: [{ href: `${base}/processes/${definition.id}`, rel: "self", type: "application/json" }] })), links: [{ href: `${base}/processes`, rel: "self", type: "application/json" }] }));
  router.get("/processes/:processId", (req, res) => {
    const definition = processDefinitions[req.params.processId];
    if (!definition) return res.status(404).json({ detail: "Process not found" });
    res.json({ ...definition, jobControlOptions: ["async-execute"], outputTransmission: ["value", "reference"], links: [{ href: `${base}/processes/${definition.id}/execution`, rel: "execute", type: "application/json" }] });
  });
  router.post("/processes/:processId/execution", (req, res) => {
    const definition = processDefinitions[req.params.processId];
    if (!definition) return res.status(404).json({ detail: "Process not found" });
    const inputs = req.body?.inputs && typeof req.body.inputs === "object" ? req.body.inputs : req.body || {};
    if (!inputs.streamId || (definition.id === "provision-live-fmv" && !inputs.inputUrl) || (definition.id === "package-fmv-file" && !inputs.assetId)) {
      return res.status(400).json({ detail: "Required process inputs are missing" });
    }
    const job = { id: randomUUID(), processId: definition.id, inputs, streamId: String(inputs.streamId), requestId: req.requestId, status: "accepted", message: "Job accepted", progress: 0, created: new Date().toISOString(), started: null, finished: null, results: null };
    jobs.set(job.id, job);
    execute(job);
    res.status(201).location(jobUrl(job.id)).json(publicJob(job));
  });
  router.get("/jobs", (_req, res) => res.json({ jobs: [...jobs.values()].map(publicJob), links: [{ href: `${base}/jobs`, rel: "self", type: "application/json" }] }));
  router.get("/jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ detail: "Job not found" });
    res.json(publicJob(job));
  });
  router.get("/jobs/:jobId/results", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ detail: "Job not found" });
    if (job.status !== "successful") return res.status(409).json({ detail: `Results are unavailable while job status is ${job.status}` });
    res.json({ jobID: job.id, processID: job.processId, outputs: job.results, links: linksForJob(job) });
  });
  router.delete("/jobs/:jobId", async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ detail: "Job not found" });
    const wasInProgress = !TERMINAL.has(job.status);
    // Mark before teardown so the source-state observer cannot turn an
    // operator dismissal into a failed job while the stop transition fires.
    if (wasInProgress) setStatus(job, "dismissed", { message: "Job dismissed", progress: 100 });
    job.results = null;
    if (wasInProgress && SOURCE_PROCESS_IDS.has(job.processId) && job.streamId) {
      await stopSourceRuntime(job.streamId).catch(() => {});
    }
    // Dismissal removes job metadata only. A successful provisioned source is
    // deliberately not stopped; DELETE /sources/{streamId} owns that action.
    jobs.delete(job.id);
    res.status(204).end();
  });

  return router;
}
