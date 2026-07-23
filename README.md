# DVR + WebRTC + ST0601 KLV + Segmented WebVTT + OGC Moving Features (Demo)

## What this is
A runnable Node.js demo that:
- ingests an MPEG-TS stream (UDP or file)
- parses STANAG 4609 / MISB ST 0601 KLV
- records video as HLS MPEG-TS with `EXT-X-PROGRAM-DATE-TIME` (DVR)
- publishes a three-rung adaptive-bitrate ladder: 90p/100 kbps, 360p/800 kbps, and 720p/3 Mbps
- generates a **segmented WebVTT sidecar track** (default 5 seconds/segment, configurable)
- serves HLS master playlist with subtitles group ("KLV")
- plays Live via WebRTC (mediasoup) and DVR via HLS
- exposes OGC API – Moving Features subset endpoints backed by the same SQLite store

## Prereqs
- Node.js 18+
- `ffmpeg` installed and on PATH
- For GPU encode (default), install FFmpeg with hardware encoder support (for example `h264_nvenc`).

### FFmpeg GPU settings
- `FFMPEG_USE_GPU=1` (default) enables GPU encode for transcode modes (`xcode-any`).
- `FFMPEG_GPU_CODEC=h264_nvenc` selects the GPU encoder.
- `FFMPEG_HWACCEL=auto` selects decode hwaccel mode.
- Set `FFMPEG_USE_GPU=0` to force CPU `libx264` fallback.

## Install / run
```bash
npm install
npm run build
npm start
```

Use `npm run dev` during frontend development. `npm run build` regenerates the ignored `public/assets/` bundle that `npm start` serves.

## Docker
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

Select **Video file** in the UI, choose a `.ts`, `.m2ts`, `.mp4`, `.mov`, or `.mkv` file, then click **Start Source**. The browser uploads it to the server's ignored `./videos/` directory before it is packaged. File sources produce the same HLS ladder and segmented WebVTT output, then transition to **ready** when packaging completes. Play them from the DVR (HLS) tab; the live WebRTC tab is intentionally unavailable for file sources.

The default upload limit is 10 GB. Override it with `MAX_VIDEO_UPLOAD_MB` when starting the server.

While a file source is packaging, the UI displays its conversion percentage, source media time processed, FFmpeg speed, and estimated remaining time. It then reports `finalizing` while WebVTT files are completed and `ready` when HLS playback is available.

DVR output will appear under `./recordings/<streamId>/`:
- `master.m3u8`
- `v0/index.m3u8` (360p video; timing reference for the VTT playlist)
- `v1/index.m3u8` (720p video)
- `v2/index.m3u8` (90p video)
- `playlist.m3u8` (private KLV carrier playlist)
- `subtitles.m3u8` (VTT playlist)
- `meta_<segNo>.vtt` (segmented metadata)

## Notes
- DVR overlay is driven by the WebVTT track (no websocket sync needed).
- Live metadata overlay can be enabled via WS "WS: Live KLV".
- The ST0601 decoder is partial; extend tags as needed for your feed.


## Variable-rate metadata (1–10 Hz) tuning
- `maxCuesPerSecond` (default 10)
- `minCueDurSec` (default 0.10)
- `maxCueDurSec` (default 0.50)

These parameters affect only the WebVTT sidecar overlay. All decoded KLV is still stored at full rate in SQLite.
