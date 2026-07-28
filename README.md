# DVR + WebRTC + ST0601 KLV + Segmented WebVTT + OGC Moving Features (Demo)

## What this is
A runnable Node.js demo that:
- ingests an MPEG-TS stream (UDP or file)
- parses STANAG 4609 / MISB ST 0601 KLV
- records video as HLS MPEG-TS with `EXT-X-PROGRAM-DATE-TIME` (DVR)
- publishes a three-rung adaptive-bitrate ladder: 90p/100 kbps, 360p/800 kbps, and 1080p/6 Mbps
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
- For GPU encode (default), install FFmpeg with hardware encoder support (for example `h264_nvenc`).

### FFmpeg GPU settings
- `FFMPEG_USE_GPU=1` (default) enables GPU encode for HLS transcode modes (`xcode-single`, `xcode-any`).
- `FFMPEG_GPU_CODEC=h264_nvenc` selects the GPU encoder.
- `FFMPEG_HWACCEL=auto` selects decode hwaccel mode.
- Set `FFMPEG_USE_GPU=0` to force CPU `libx264` fallback.

### Processing modes
- **HLS passthrough** is the default: confirmed H.264 video is copied without video encoding; audio is omitted from browser playback. A separate copy-only carrier playlist retains the original video, audio, and KLV for extraction and clips.
- **HLS compatibility fallback** activates when passthrough input is not H.264 (for example MPEG-2 video): it produces browser-compatible H.264 playback renditions while retaining the original video, audio, and KLV carrier without re-encoding it.
- **HLS ABR** creates three renditions: Low (90p), Medium (360p), and High (the source's native resolution). A compatible H.264 source is copied into High; other source codecs are encoded to their native-resolution High rung.
- **Live WebRTC auto-copy** copies H.264 into RTP when the input probe confirms H.264; it falls back to transcoding for other codecs. File sources are HLS-only.

## Install / run
```bash
npm install
npm run build
npm start
```

Use `npm run dev` during frontend development. `npm run build` regenerates the ignored `public/assets/` bundle that `npm start` serves.

## Docker
**Run this if you want to test via containerization.  Highly recommend to to run on bare metal using Node.**

Build and run with Docker Compose (uses host networking for UDP multicast access):
```bash
docker-compose up --build
```

This will:
- Build the container with Node.js latest and ffmpeg
- Run with host networking to access UDP streams
- Mount `./recordings` and `./db` for persistent storage

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

## Start a source
In the UI, set:
- Stream ID: `stream1`
- Input URL:
  - UDP: `udp://239.1.2.3:5000`
  - or file: `./sample.ts`
- DVR seconds: e.g. `600`
- VTT segment seconds: default `5`

Click **Start Source**.

### Ingesting a video file

Select **Video file** in the UI, choose a `.ts`, `.m2ts`, `.mp4`, `.mov`, or `.mkv` file, then click **Start Source**. The browser uploads it to the server's ignored `./videos/` directory before it is packaged. The UI displays uploaded bytes and percent during this HTTP transfer, then a **Preparing file** stage while the server probes video and KLV streams. File sources produce the same HLS ladder and segmented WebVTT output, then transition to **ready** when packaging completes. Play them from the DVR (HLS) tab; the live WebRTC tab is intentionally unavailable for file sources.

The default upload limit is 10 GB. Override it with `MAX_VIDEO_UPLOAD_MB` when starting the server.

While a file source is packaging, the UI displays its conversion percentage, source media time processed, FFmpeg speed, and estimated remaining time. It then reports `finalizing` while the remaining carrier segments are decoded and WebVTT is completed, and `ready` when HLS playback is available. The latest valid telemetry remains visible on the DVR map during finalization.

DVR output will appear under `./recordings/<streamId>/`:
- `master.m3u8`
- `v0/index.m3u8` (360p video; timing reference for the VTT playlist)
- `v1/index.m3u8` (1080p video)
- `v2/index.m3u8` (90p video)
- `playlist.m3u8` (private KLV carrier playlist)
- `subtitles.m3u8` (VTT playlist)
- `meta_<segNo>.vtt` (segmented metadata)
- `poster.jpg` (source preview image)

### Creating a file clip

The DVR **Create video clip** control is available only for an uploaded file source. Drag either edge to preview the HLS start/end positions, then export. Export reuses the private source-stream-copy carrier already produced during normal file packaging, concatenates the complete keyframe-aligned segments covering the request, snaps both bounds to decodable source keyframes, and copies video, audio, and KLV data streams into a downloadable MPEG-TS clip. There is no re-encode, delayed first export, or fixed maximum duration by default; set `MAX_CLIP_DURATION_SECONDS` to impose one.

## Notes
- The DVR VTT telemetry panel has **Data** and **Map** tabs; its map is driven by the active WebVTT cue (no websocket sync needed). The equivalent live WebRTC telemetry map uses the active KLV WebSocket feed. Both maps show KLV platform/sensor position, frame-center position, platform heading, their connecting line, and an amber footprint. Source frame corners are preferred; when source offsets are missing or all zero, a `computed-flat` estimate uses sensor pose, FOV, range, and a flat-ground approximation. Each map centers on its first valid frame center; use **Center map** to recenter later.
- The Data tabs display all decoded telemetry in the active cue, including `missionId` when ST 0601 tag 3 is present. The KLV `timestampIso` is displayed beneath each map.
- Terrain correction, external terrain loading, and terrain-derived footprints are not used. The computed-flat fallback is an approximation and may be less accurate over uneven terrain.
- Live metadata overlay can be enabled via WS "WS: Live KLV".
- The ST0601 decoder is partial; extend tags as needed for your feed.


## Variable-rate metadata (1–10 Hz) tuning
- `maxCuesPerSecond` (default 10)
- `minCueDurSec` (default 0.10)
- `maxCueDurSec` (default 0.50)

These parameters affect only the WebVTT sidecar overlay. All decoded KLV is still stored at full rate in SQLite.

## File KLV finalization tuning

Completed file segments are decoded in bounded batches and their SQLite records are inserted transactionally before ordered WebVTT sidecars are published. SQLite writer contention is retried with bounded backoff, and uploaded-file telemetry is excluded from live-stream retention. The defaults are four concurrent decode tasks and batches of sixteen segments. Tune only when profiling a particular machine or storage device:

- `KLV_SEGMENT_DECODE_WORKERS` (default `4`, range `1`–`8`)
- `KLV_SEGMENT_DECODE_BATCH_SIZE` (default `workers × 4`, range `workers`–`64`)
- `KLV_FINALIZE_MIN_TIMEOUT_MS` (default `30000`)
- `KLV_FINALIZE_MS_PER_SEGMENT` (default `500`)
- `KLV_FINALIZE_MAX_TIMEOUT_MS` (default `7200000`)
