# PoC design

## 1. Purpose and scope

This is a local-first proof of concept for ingesting video sources that carry MISB ST 0601 KLV metadata. It makes the same source usable in three ways:

- HLS DVR playback with a time-aligned telemetry overlay.
- Low-latency WebRTC playback for live stream sources.
- Telemetry inspection, map display, direct queries, and a small OGC API – Moving Features subset.

An uploaded file may additionally be exported as a keyframe-aligned clip without re-encoding or losing its embedded KLV data. The PoC accepts UDP inputs and uploaded `.ts`, `.m2ts`, `.mp4`, `.mov`, and `.mkv` files. It is intentionally a single-node application: it has no authentication, tenancy, object-store integration, distributed job queue, or production retention policy.

## 2. Architecture at a glance

```text
 Live UDP source                         Uploaded video file
       |                                         |
       +-------------------+---------------------+
                           |
              probe input / choose media mode
                           |
                       FFmpeg recorder
                  /             |              \
   browser HLS video       KLV carrier HLS       RTP ingest
   (video only)            (private, copy-only)  (streams only)
          |                        |                   |
          |                  KLV worker process     mediasoup SFU
          |                   /            \            |
          |          WebVTT sidecars      SQLite      WebRTC browser
          |                   |             |
          +----------- React UI ----------+---- OGC API / live WebSocket
```

The browser does not render KLV directly from the media container. Instead, it receives video from HLS or WebRTC and receives matching decoded telemetry from a WebVTT cue (DVR) or a WebSocket event (live). This separation keeps browser playback compatible while the server retains access to original KLV carrier packets.

## 3. Processes and responsibilities

| Component | Responsibility |
| --- | --- |
| `server.js` | Express/HTTP entry point; source lifecycle; uploads; HLS, KLV, and SFU orchestration; clips; posters; WebSocket; health/runtime endpoints; graceful shutdown. |
| `src/hls_recorder.js` | Starts FFmpeg for browser HLS output and the private KLV carrier HLS output. Reports file packaging progress. |
| `src/klv/klv_stream_worker.js` | Dedicated child process that monitors carrier segments, parses KLV, stores telemetry, and creates ordered WebVTT sidecars. |
| `src/klv/klv_ts_parser.js`, `ts_psi.js`, `st0601.js` | MPEG-TS program/data discovery, KLV extraction, and supported ST 0601 local-set decoding. |
| `src/storage/sqlite_klv_store.js` | SQLite schema, WAL-mode writes, retention, direct queries, and batched transactions. |
| `src/webrtc_sfu.js`, `src/sfu/`, `src/ffmpeg_rtp_ingest.js` | mediasoup worker/client and FFmpeg RTP ingest for live WebRTC. |
| `src/vtt_segmenter.js` | Builds VTT cues and subtitle playlists aligned to HLS segment timing. |
| `src/App.jsx` | React/Mantine control surface: source setup, upload progress, playback, active-source previews, telemetry, clip controls, and system utilization. |
| `src/KlvMap.jsx` | OpenLayers map of direct KLV geometry only. |
| `src/ogc_moving_features.js` | Minimal OGC Moving Features discovery, temporal geometry, and temporal-property routes. |

The top-level Node service owns the source map and public runtime state. The KLV and SFU components run out-of-process so their failures can be reported independently and do not execute within the request handler process.

## 4. Source types and lifecycle

### 4.1 Live stream source

1. The user enters a UDP URL and starts the source.
2. The server probes streams and codecs with `ffprobe`.
3. FFmpeg begins HLS packaging and a private KLV carrier playlist.
4. A KLV worker begins extracting carrier segments.
5. An FFmpeg RTP ingest and mediasoup producer are started for WebRTC.
6. The source reports `running` when the expected media paths are healthy; a lost KLV/SFU path produces `degraded` rather than silently appearing healthy.

### 4.2 File source

1. The browser uploads the selected file over HTTP to the ignored `./videos/` directory. XMLHttpRequest is used so the UI can show transferred bytes and percent.
2. The UI reports **Preparing file** while the server probes video, duration, and KLV streams.
3. The server creates full-history VOD HLS, a KLV carrier playlist, WebVTT sidecars, and a poster image. File sources are HLS-only; they do not get a live WebRTC producer.
4. FFmpeg progress updates source media time processed, percent, speed, and ETA.
5. When FFmpeg reaches EOF, state changes to `finalizing`; the KLV worker drains remaining carrier segments and writes the final subtitle playlist.
6. Once finalization succeeds, state is `ready`. Generated HLS/VTT artifacts remain playable even though the media worker processes have exited.

### 4.3 State model

| State | Meaning |
| --- | --- |
| `stopped` | No active source runtime. |
| `starting` | Source is being probed, purged, or media workers are being initialized. The `stage` property adds detail such as `purging`, `hls_started`, or `klv_started`. |
| `running` | Expected HLS and KLV paths are active; a stream source also has RTP ingest. |
| `degraded` | At least one expected path failed while another may still provide useful output. |
| `finalizing` | File-only state: HLS has reached EOF and KLV/VTT sidecars are draining. Latest valid DVR telemetry remains visible. |
| `ready` | File-only completed state: HLS/VTT files are available for VOD playback. |
| `stopping` | Source teardown is in progress. |
| `error` | Startup or runtime failure prevented the expected source behavior. |

Stopping a source terminates its KLV worker, HLS recorder, and any SFU ingest. Purging before start removes that source's generated recording directory, SDP artifact, and SQLite telemetry rows. The original uploaded asset is not a recording artifact and is separately server-owned.

## 5. Media packaging

### 5.1 Input selection and encoder modes

The initial probe selects the safest HLS path:

- **Passthrough:** an H.264 source is copied into browser HLS without video re-encoding.
- **Compatibility fallback:** a non-H.264 source receives one H.264 playback rendition.
- **ABR:** produces low (90p), medium (360p), and native-resolution renditions. A compatible H.264 native rung may be copied; other rungs are encoded.

Browser HLS is deliberately video-only. Source audio does not control HLS compatibility. GPU encoding is enabled by default for transcode paths when the selected FFmpeg encoder is available; setting `FFMPEG_USE_GPU=0` forces the CPU fallback.

### 5.2 Two HLS outputs per source

Each source produces two distinct segment families:

| Output | Contents | Consumer |
| --- | --- | --- |
| Browser HLS | Playback video and a linked segmented WebVTT subtitle/metadata track; no source KLV data stream. | Video.js/HLS browser player. |
| Private carrier HLS | Copy of source video plus data streams, including KLV when present. | KLV worker only; never exposed as the playback experience. |

All playlists use MPEG-TS segments and include program-date-time timing. File playlists retain the complete VOD history; live sources maintain their configured HLS behavior. The private carrier is necessary because a browser-compatible HLS rendition cannot be relied on to carry arbitrary KLV data streams.

### 5.3 Source poster

After source creation, the server queues a lightweight FFmpeg frame capture into `recordings/<streamId>/poster.jpg`. This operation is intentionally asynchronous so it does not delay HLS/KLV/WebRTC startup. The Active Sources panel displays the poster when it is available.

## 6. KLV extraction, timing, and persistence

### 6.1 KLV decoding

The parser identifies KLV data streams in the transport stream, extracts local sets, and decodes the ST 0601 fields used by the UI and API. Supported fields include:

- Precision timestamp (`timestampUnixMicros`, `timestampIso`).
- Mission ID (tag 3, `missionId`).
- Sensor position, altitude, horizontal/vertical FOV, and relative orientation.
- Platform heading, pitch, and roll.
- Slant range, frame center, and full or offset-derived frame corners.

The decoder is intentionally partial. Unsupported tags are not a claim that the source has no such metadata; they are simply not represented in the decoded UI object.

### 6.2 Segment alignment and WebVTT

The KLV worker reads the browser and carrier playlists, pairs a browser video segment with the nearest carrier segment, and derives timing from playlist durations, program-date-time values, KLV precision time, and transport timestamps when present. It writes one `meta_<segment>.vtt` file per browser segment and keeps the subtitle playlist in the same segment order.

The DVR player attaches the VTT track in hidden mode. The React application listens for cue changes, parses the cue JSON, and uses it to update the Data panel and map. The subtitle track is not visually rendered over the video.

### 6.3 Bounded batching and ordered output

For finite files, waiting for every segment serially made finalization expensive. The worker now:

1. Selects a bounded batch of completed, paired carrier segments.
2. Starts up to `KLV_SEGMENT_DECODE_WORKERS` asynchronous segment decodes (default `4`, clamped to `1`–`8`).
3. Re-applies decoded results in playlist order to establish timing bases.
4. Inserts each batch's decoded events using one SQLite transaction, chunking large SQL statements below SQLite's bind-variable limit.
5. Publishes VTT files in playlist order and advances the processed segment marker.

This improves storage and I/O throughput without allowing concurrent work to change VTT cue order or timeline alignment. The default batch size is `workers × 4`, controlled by `KLV_SEGMENT_DECODE_BATCH_SIZE` (clamped to `workers`–`64`).

### 6.4 SQLite and retention

`db/klv.sqlite` stores `stream_id`, source-time milliseconds, and decoded JSON. The store uses WAL journal mode, normal synchronous mode, a busy timeout, and a `(stream_id, t_ms)` index. The server's demo retention job removes records older than two hours every 30 seconds. The WebVTT rate controls do not reduce the full-rate records persisted to SQLite.

The direct telemetry endpoint is:

```text
GET /streams/:streamId/klv?fromMs=<epoch-ms>&toMs=<epoch-ms>
```

## 7. Playback and telemetry UI

### 7.1 DVR

The DVR tab uses Video.js/HLS. A file-backed playlist is explicitly positioned at its beginning after metadata loads so it does not inherit a live-DVR end position. A live stream is explicitly positioned at the Video.js live-tracker time (or the seekable-range end when unavailable) so its HLS view starts at the live edge despite retaining DVR history. The current video time, selected rendition, segment, subtitle segment, and playback diagnostics are visible in the UI.

The Data tab renders fields from the active WebVTT cue, including `missionId` when present. The Map tab shows `timestampIso` beneath the map and preserves the latest valid cue during `finalizing` and `ready` file states.

### 7.2 Live WebRTC

For live sources, the browser obtains router RTP capabilities, creates/connects a mediasoup transport, and consumes the RTP producer. A browser Web Worker reconnects to the live KLV WebSocket (`/ws`) without blocking the UI. Clients subscribe by stream ID and receive the latest stored event immediately after subscribing, then new decoded events as they arrive.

### 7.3 Map

The OpenLayers map intentionally renders **only direct KLV geometry**:

- Sensor/platform marker and heading.
- Frame-center marker and line from sensor to frame center.
- An amber footprint when complete KLV frame-corner coordinates are present (full corners or decoded offsets).

No terrain model is downloaded. There is no terrain correction, terrain target, or terrain-derived footprint. **Center map** recenters on the latest valid frame-center position.

## 8. File clips and KLV preservation

The clip widget is available only for file sources because the server needs an authoritative, seekable original asset. It uses the packaged HLS duration for UI preview but does not export from HLS segments.

1. The user drags start/end grips or sets boundaries at the HLS playhead.
2. The client previews the boundary by seeking HLS.
3. The export endpoint validates the requested range against the original asset duration.
4. FFmpeg uses input-side seeking and stream copy for video, audio, and data streams (`-c:v copy`, `-c:a copy`, `-c:d copy`).
5. The start snaps to a source keyframe, so the actual output boundary may precede the exact UI time.
6. The output is MPEG-TS, allowing KLV data streams to remain embedded. The server probes the result and rejects a KLV-bearing source whose KLV was not retained.

Clip APIs:

```text
POST /sources/:streamId/clips
GET  /sources/:streamId/clips/:clipId/download
```

The default policy accepts any duration at least 0.25 seconds. A deployment can set a positive `MAX_CLIP_DURATION_SECONDS` limit. Clips are held under `recordings/<streamId>/clips/` and tracked in memory for the lifetime of the active source.

## 9. HTTP, WebSocket, and OGC surfaces

The UI uses these primary HTTP routes:

| Route | Purpose |
| --- | --- |
| `POST /uploads/video` | Stores an allowed video file and returns a server-owned asset ID. Enforces `MAX_VIDEO_UPLOAD_MB` (10 GB default). |
| `POST /probe/input` | Performs a non-starting input probe. |
| `POST /sources` | Starts a stream or uploaded-file source. |
| `GET /sources`, `GET /sources/:streamId/state` | Enumerates sources and returns lifecycle/progress/runtime state. |
| `DELETE /sources/:streamId` | Stops a source and its child media workers. |
| `/hls/:streamId/...` | Serves generated HLS playback files, VTT sidecars, and source posters. |
| `GET /metrics/runtime`, `GET /healthz` | Host, GPU, worker, source, and service health information. |
| `/webrtc/*` | mediasoup signaling for live browser consumption. |
| `/ogc/*` | OGC Moving Features demo subset. |

The `/ws` WebSocket supports a `subscribe` message containing `streamId` and `mode: "live"`. It broadcasts decoded ST 0601 objects only to subscribed clients.

The OGC subset exposes collection discovery plus `platform` and `frameCenter` moving features. It returns temporal geometry sequences and temporal property arrays from the same SQLite data, accepting ISO timestamps or epoch milliseconds in the `datetime` query parameter.

## 10. Observability, errors, and shutdown

All requests receive an `X-Request-Id`; service logs use that request context. Source runtime state exposes HLS/KLV/ingest process status, encoder selection, GPU usage, probe results, file progress, stage, and last error. `/metrics/runtime` adds host CPU/RAM/GPU metrics and child worker health.

Expected failures are surfaced instead of silently hidden:

- Input probe or startup failure leaves the source in `error` with `lastError`.
- KLV or SFU ingest exit can degrade a source while leaving any remaining path available.
- Finalization uses a duration/segment-count estimate, bounded by `KLV_FINALIZE_MIN_TIMEOUT_MS`, `KLV_FINALIZE_MS_PER_SEGMENT`, and `KLV_FINALIZE_MAX_TIMEOUT_MS`; timeout failures are reported in state.
- Browser source polling treats unavailable backend responses as offline and resets playback state until the server returns.

On process shutdown, the service stops source workers, closes WebSocket clients and HTTP sockets, closes the SQLite store, and applies a bounded forced-exit timeout.

## 11. Configuration and operational boundaries

Key environment variables include:

| Setting | Purpose |
| --- | --- |
| `HTTP_PORT`, `HTTP_PORT_SCAN_RANGE` | HTTP listener and optional fallback port scan. |
| `WS_PATH` | Live KLV WebSocket path (default `/ws`). |
| `WEBRTC_ANNOUNCED_IP` | Address advertised by mediasoup. |
| `FFPROBE_BIN`, `INPUT_PROBE_TIMEOUT_MS` | Input inspection executable and timeout. |
| `FFMPEG_USE_GPU`, `FFMPEG_GPU_CODEC`, `FFMPEG_HWACCEL` | HLS transcode acceleration policy. |
| `MAX_VIDEO_UPLOAD_MB` | File upload limit (default 10 GB). |
| `MAX_CLIP_DURATION_SECONDS` | Optional clip-duration policy; unrestricted when unset or zero. |
| `SOURCE_POSTER_WIDTH`, `SOURCE_POSTER_TIMEOUT_MS` | Active-source poster capture behavior. |
| `KLV_SEGMENT_DECODE_WORKERS`, `KLV_SEGMENT_DECODE_BATCH_SIZE` | Bounded file KLV decode concurrency and batch size. |
| `KLV_FINALIZE_MIN_TIMEOUT_MS`, `KLV_FINALIZE_MS_PER_SEGMENT`, `KLV_FINALIZE_MAX_TIMEOUT_MS` | Adaptive file KLV finalization timeout bounds. |

This code is a PoC rather than a hardened media service. In particular, deployments should add authentication/authorization, HTTPS and secure WebRTC network configuration, source admission controls, disk quotas and cleanup for uploads/clips, operational monitoring, durable job recovery, and environment-specific media validation before exposing it beyond a trusted environment.
