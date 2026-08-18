# DVR + WebRTC + ST0601 KLV + Segmented WebVTT + OGC Moving Features (Demo)

## What this is
A runnable Node.js demo that:
- ingests an MPEG-TS stream (UDP or file)
- parses STANAG 4609 / MISB ST 0601 KLV
- records video as HLS MPEG-TS with `EXT-X-PROGRAM-DATE-TIME` (DVR)
- publishes a two-rung adaptive-bitrate ladder: 360p/800 kbps and a source-native High rung (always derived from ffprobe; no fixed 1080p fallback)
- generates a **segmented WebVTT sidecar track** (default 5 seconds/segment, configurable)
- decodes ST 0601 Mission ID (tag 3) and precision timestamp alongside supported positional telemetry
- serves HLS master playlist with subtitles group ("KLV")
- plays Live via WebRTC (mediasoup) and DVR via HLS
- exports file-only, keyframe-aligned MPEG-TS clips with copied video, audio, and embedded KLV
- exposes OGC API – Moving Features subset endpoints backed by the same SQLite store

For a short overview of how the pieces fit together, see [DESIGN.md](DESIGN.md).

## Prereqs
- Node.js 18+
- `ffmpeg` installed and on PATH
- `ffprobe` installed and on PATH (normally distributed with FFmpeg)
- Mission Products requires the Windows x64 SpatiaLite 5.1.0 extension. Set
  `SPATIALITE_EXTENSION_PATH` to `mod_spatialite.dll`; see
  [`vendor/spatialite/win-x64`](vendor/spatialite/win-x64/README.md).
- For GPU encode (default), install FFmpeg with hardware encoder support (for example `h264_nvenc`).

### FFmpeg GPU settings
- `FFMPEG_USE_GPU=1` (default) enables GPU encode for HLS transcode modes (`xcode-single`, `xcode-any`).
- `FFMPEG_GPU_CODEC=h264_nvenc` selects the GPU encoder.
- `FFMPEG_HWACCEL=auto` selects decode hwaccel mode.
- In ABR mode, supported H.264/HEVC inputs use CUDA decode plus `scale_cuda`/`pad_cuda` for encoded rungs, keeping frames on the GPU until NVENC. Set `FFMPEG_ABR_GPU_FILTERS=0` to retain GPU encoding while using the CPU filter path.
- Set `FFMPEG_USE_GPU=0` to force CPU `libx264` fallback.
- On startup, the service logs the FFmpeg and FFprobe version lines and runs a one-frame encode using `FFMPEG_GPU_CODEC`. Read the same result from `/healthz` or `/metrics/runtime` under `mediaTools`. Missing FFmpeg/FFprobe makes `/healthz` return `503`; an unavailable GPU encoder is reported but does not prevent CPU fallback.

### Processing modes
- **HLS passthrough** is the default: confirmed H.264 video is copied without video encoding; audio is omitted from browser playback. A separate copy-only carrier playlist retains the original video, audio, and KLV for extraction and clips.
- **HLS compatibility fallback** activates when passthrough input is not H.264 (for example MPEG-2 video): it produces browser-compatible H.264 playback renditions while retaining the original video, audio, and KLV carrier without re-encoding it.
- **HLS ABR** creates two renditions: Low (360p) and High (the source's native resolution). Only an H.264 Baseline source is copied into High; other source codecs or H.264 profiles are encoded to their native-resolution High rung so adaptive switches remain codec-compatible.
- **ABR bitrate planning** uses the probed source video bitrate for the native rung when it is available and scales the 360p rung by display-pixel area. A frame-rate-aware estimate is used when a live source does not report bitrate; bounded targets prevent impractically low or high outputs.
- **Live WebRTC auto-copy** copies H.264 into RTP when the input probe confirms H.264; it falls back to transcoding for other codecs. File sources are HLS-only.

## Install / run
```bash
npm install
npm run build
npm start
```

`npm start` now runs the service under a small local lifecycle manager. Stop it
cleanly from any terminal in the project with `npm run stop`; use `npm run status`
to confirm whether it is running. Pressing Ctrl+C in the start terminal also asks
the server to perform the same graceful shutdown. The manager waits 15 seconds
for workers and FFmpeg to close, then terminates only that service's remaining
process tree if necessary. Use `npm run start:direct` only when you specifically
want to run `server.js` without the lifecycle commands.

Use `npm run dev` during frontend development. `npm run build` regenerates the ignored `public/assets/` bundle that `npm start` serves.

## API documentation

When the server is running, open [Swagger UI](http://localhost:8090/docs). The versioned OpenAPI 3.0 definition is also available at `http://localhost:8090/openapi.yaml` in [openapi.yaml](./openapi.yaml).

## Docker
**Run this if you want to test via containerization.  Highly recommend to to run on bare metal using Node.**

Build and run with Docker Compose (uses host networking for UDP multicast access):
```bash
docker-compose up --build
```

This will:
- Build the container with Node.js latest and ffmpeg
- Run with host networking to access UDP streams
- Mount `./mission-products` and `./db` for persistent storage

## Testing with Video Streams

A companion streaming tool is included in the `streamer/` directory to test with your own video files:

```bash
cd streamer
npm install

# Generate a test video
node generate-sample.js -o sample.ts -d 30

# Stream your video over UDP multicast
node streamer.js -i ../path/to/your/video.mp4
```

Then configure the DVR demo to ingest from `udp://239.1.2.3:5000`.

**Note**: The current streamer streams video but does not inject KLV metadata. For testing KLV parsing, you need video files that already contain embedded ST0601 metadata.

Open:
- UI: http://localhost:8090
- OGC collections: http://localhost:8090/ogc/collections

### OGC API - Processes

FMV source provisioning is also available through the service-lifetime OGC API - Processes resources at `http://localhost:8090/ogc/processes` and `http://localhost:8090/ogc/jobs`. `provision-live-fmv` starts live ingest, HLS/KLV, and WebRTC, then completes when the source reaches `running`. `package-fmv-file` packages an uploaded/local source and completes when it reaches `ready`; HLS can be consumed while it is still finalizing. Both results link to the continuing `/sources/{streamId}/state` source session, rather than owning it. `export-clip` and `export-klv` provide finite artifact exports. Dismissing a successful job only removes job metadata; stop the continuing session explicitly with `DELETE /sources/{streamId}`.

## Start a source
In the UI, set:
- Input URL:
  - UDP: `udp://239.1.2.3:5000`
  - or file: `./sample.ts`
- DVR seconds: e.g. `600`
- VTT segment seconds: default `5`

Click **Start Source**. The service creates the internal stream ID automatically; operators select the mission and source, not a storage/session identifier.

### Ingesting a video file

Select **Video file** in the UI, choose a `.ts`, `.m2ts`, `.mp4`, `.mov`, or `.mkv` file, then click **Start Source**. The service generates an internal stream ID and a future product ID, storing the authoritative original at `./mission-products/<productId>/source/<assetId>.<ext>` beside generated HLS and metadata artifacts. The source directory is private and is never cataloged as a downloadable asset. The catalog FMV product is published only after packaging reaches `ready`; recordings and telemetry then persist across restarts and source stops until that product is deleted. Uploads use 64 MB resumable HTTP chunks: an interrupted transfer automatically retries, and selecting the same file again resumes from the server-confirmed byte offset when the browser's saved upload session is still available.

The default upload limit is 10 GB. Override it with `MAX_VIDEO_UPLOAD_MB` when starting the server.

### Ingesting a file already on the server

Choose **Local server file** and select a supported file from the server-driven dropdown. It lists files beneath `./videos/` (including subfolders) and the server copies the selection directly into its future product workspace before packaging, avoiding the browser HTTP upload.

For safety, the default allowed root is `./videos/` (created automatically if absent). You can instead configure one or more allowed parent folders; on Windows, separate roots with `;`:

```powershell
$env:LOCAL_VIDEO_SOURCE_ROOTS = 'D:\media;E:\incoming'
npm start
```

The dropdown lists content only from those roots, and the copy endpoint validates the selection again. The original local file is never moved or modified.

While a file source is packaging, the UI displays its conversion percentage, source media time processed, FFmpeg speed, and estimated remaining time. It then reports `finalizing` while the remaining carrier segments are decoded and WebVTT is completed, and `ready` when HLS playback is available. The latest valid telemetry remains visible on the DVR map during finalization.

DVR output for an FMV product appears under `./mission-products/<productId>/`:
- `source/<assetId>.<ext>` (private authoritative uploaded original)
- `source/.uploads/` (private temporary resumable-upload chunks and session metadata)
- `master.m3u8`
- `v0/index.m3u8` (360p video; timing reference for the VTT playlist)
- `v1/index.m3u8` (native High video)
- `playlist.m3u8` (private KLV carrier playlist)
- `subtitles.m3u8` (VTT playlist)
- `meta_<segNo>.vtt` (segmented metadata)
- `poster.jpg` (source preview image)

### Creating a file clip

The DVR clip control is available only for an uploaded file source. It builds a cached filmstrip of representative frames from the authoritative source behind the trim handles. While packaging is still underway, the server derives the playable boundary from the completed browser-HLS playlist entries whose segment files exist on disk—not FFmpeg's source-processing progress. The future portion of the filmstrip is striped/dimmed, and trim handles are clamped to the last completed HLS segment; the **Playable** readout updates as segments arrive. Once the source reaches `ready`, the full source duration becomes selectable.

**Download clip** stream-copies the selected range into a temporary downloadable MPEG-TS file and does not create a mission product. **Download & create product** also stores a managed copy and publishes a child clip product. When the selected range has KLV location data, its catalog coverage and time extent are derived from that range; otherwise the product inherits its mission coverage bbox. FFmpeg preserves source video, audio, and KLV/data streams, and the start can move to a nearby preceding decodable keyframe. There is no re-encode or fixed maximum duration by default; set `MAX_CLIP_DURATION_SECONDS` to impose one.

### Snapshots

For an uploaded file, the playback snapshot button offers **Authoritative uploaded source (FFmpeg)**, which seeks directly in the uploaded file for a fast capture at the nearest decodable keyframe at or before the current playback time, and **Displayed HLS player frame**, which captures the browser-decoded frame including active zoom/pan and image adjustments (brightness, contrast, and saturation). Live streams retain the adjusted browser-frame snapshot only. These controls are browser-only and never change the delivered or recorded media.

For the HLS ABR ladder, the native High rendition retains the source sample aspect ratio when it must be encoded. The Low 360p square-pixel rung scales directly from the source display geometry before padding, preventing side bars for a 1440×1080 source with 4:3 SAR without an extra full-resolution scale. WebRTC itself is not changed.

The DVR diagnostics show the active rendition and an **ABR processing** line that identifies every rung as `encoded` or `source copy`. The same per-rung plan is written to the HLS recorder startup log.

### Mission Target Log

The **Add Mark** action creates a SQLite-backed target-log entry for the current stream in DVR or live playback. It is available only when the current frame has a usable KLV mission timestamp or, for a confirmed no-KLV file, a manually configured first-frame UTC anchor. Its displayed and sorted mission time is a user-editable KLV timestamp, not the player offset. The service derives a separate internal video offset from the stream's KLV timeline, keeping file-backed pins aligned to the clip filmstrip and supporting DVR seeking. Editing mission time updates that alignment; a time outside the known KLV mission range remains a valid mark but has no clip pin. Position is optional: blank coordinates are stored as unavailable (`null`), render as `—`, and create no map pin; a deliberate `0,0` remains a valid position. New marks initially use frame-center telemetry when available, falling back to platform position; latitude and longitude can be edited in decimal degrees or set by clicking either telemetry map. Marks are persisted in `db/klv.sqlite`; hovering a list entry, clip-filmstrip dot, or map pin highlights its positioned counterparts, while clicking an aligned list entry or pin in DVR seeks the HLS player without creating a persistent selection. Live WebRTC markers remain informational because that player cannot seek to historical target times.

Use **Manage fields** to add stream-specific text, number, or boolean metadata fields. Deactivating a field retains historical values already stored on entries. Recordings, SQLite telemetry, Target Log entries, and schemas persist across backend restarts and source stops. Deleting the FMV product removes all of its source-owned data; deleting a Target Log product removes that source’s Target Log data.

### Platform and frame-center history

The independent **Platform history** and **Frame-center history** controls use `GET /streams/:streamId/klv/platform-history.geojson` and `GET /streams/:streamId/klv/frame-center-history.geojson`, not the full decoded KLV event collection. The KLV worker stores one final valid platform or frame-center position after each completed browser HLS segment; each response preserves HLS sequence order, removes consecutive stationary points, and returns at most `PLATFORM_HISTORY_MAX_POINTS` coordinates (default `5000`). Its `properties.timesMs` array is index-aligned with the GeoJSON coordinates so file playback can hide points after the active WebVTT cue. Time-shifted HLS and WebRTC request a rolling 15-minute mission-time window every five seconds. The map temporarily appends the active platform or frame center to bridge the normal one-segment storage delay; it does not persist that bridge point. Compact indexes persist with stream telemetry until the owning FMV product is deleted. Replayed/looping inputs are not separated into individual passes; their samples remain in HLS sequence order.

### KLV CSV export

The export menu in either KLV telemetry panel exports the selected stream's stored SQLite telemetry separately from the Mission Target Log. **CSV** contains one chronological row per decoded KLV event with normalized telemetry columns and derived video alignment time where available. **KML** contains compact Google Earth time-series tracks for platform position (`sensorLat`/`sensorLon`/`sensorAltMslM`, plane icon), **Sensor - Frame Center**, and target position. It omits FOV footprints, but the platform and SPI `gx:Track` elements contain sample-aligned ExtendedData arrays for UTC mission time, gimbal orientation/FOV, slant range, target size/location, tracking-gate size, and target CE90/LE90. This compact representation is intended for Google Earth; Google Maps does not expose those fields as per-sample popups. Both formats omit raw JSON to reduce file size.

## Notes
- The DVR VTT telemetry panel has **Data** and **Map** tabs; its map is driven by the active WebVTT cue (no websocket sync needed). The equivalent live WebRTC telemetry map uses the active KLV WebSocket feed. Both maps show KLV platform/sensor position, frame-center position, platform heading, their connecting line, an amber footprint, plus independently toggled cyan platform and red frame-center history trails. Source frame corners are preferred; when source offsets are missing or all zero, a `computed-flat` estimate uses sensor pose, FOV, range, and a flat-ground approximation. Each map centers on its first valid frame center; use **Center map** to recenter later.
- The Data tabs display all decoded telemetry in the active cue, including `missionId` when ST 0601 tag 3 is present. The KLV `timestampIso` is displayed beneath each map.
- Terrain correction, external terrain loading, and terrain-derived footprints are not used. The computed-flat fallback is an approximation and may be less accurate over uneven terrain.
- Live metadata overlay can be enabled via WS "WS: Live KLV".
- The ST0601 decoder is partial; extend tags as needed for your feed.


## Variable-rate metadata (1–10 Hz) tuning
- `maxCuesPerSecond` (default 10)
- `minCueDurSec` (default 0.10)
- `maxCueDurSec` (default 0.50)

These parameters affect only the WebVTT sidecar overlay. All decoded KLV is still stored at full rate in SQLite unless `KLV_WRITE_SQLITE=0` is set for profiling.

## File KLV finalization tuning

Completed file segments are decoded in bounded batches and their SQLite records are inserted transactionally before ordered WebVTT sidecars are published. SQLite writer contention is retried with bounded backoff. The defaults are four concurrent decode tasks and batches of sixteen segments. Tune only when profiling a particular machine or storage device:

- `KLV_SEGMENT_DECODE_WORKERS` (default `4`, range `1`–`8`)
- `KLV_SEGMENT_DECODE_BATCH_SIZE` (default `workers × 4`, range `workers`–`64`)
- `KLV_WRITE_SQLITE` (default `1`): set to `0` to skip decoded KLV inserts while retaining KLV decode and VTT generation. OGC/SQLite telemetry queries will not include newly processed metadata.
- `KLV_FINALIZE_MIN_TIMEOUT_MS` (default `30000`)
- `KLV_FINALIZE_MS_PER_SEGMENT` (default `500`)
- `KLV_FINALIZE_MAX_TIMEOUT_MS` (default `7200000`)
