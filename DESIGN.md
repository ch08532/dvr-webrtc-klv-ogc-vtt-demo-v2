# PoC design

## Purpose

This proof of concept accepts a video feed that may contain ST 0601 KLV telemetry. It lets a browser play the video, view the telemetry on a map, and review earlier video using a DVR-style timeline.

## Main flow

```text
UDP stream or uploaded file
            |
     probe + FFmpeg + KLV parser
       /             |              \
 HLS DVR video   live RTP feed     decoded KLV
       |             |              /        \
 HLS DVR player mediasoup SFU   WebVTT       SQLite / OGC API
       |             |              |              |
       +--- browser UI ------------+--------------+
                     |
            WebRTC live player
```

## What each part does

- `server.js` starts and manages a source. It probes the input, selects the HLS/WebRTC mode, and exposes the HTTP, WebSocket, upload, and OGC endpoints.
- `src/hls_recorder.js` runs FFmpeg to split the input into HLS segments. H.264 video is copied in passthrough mode; other video is encoded to H.264. HLS output is video-only.
- `src/klv/` reads KLV data from the transport stream, decodes the supported ST 0601 fields, and records time-aligned telemetry.
- The WebVTT writer creates small metadata files aligned with HLS video segments, so DVR playback can show the matching telemetry without a live connection.
- SQLite stores decoded telemetry for history and the small OGC Moving Features API.
- `src/webrtc_sfu.js` and the RTP ingest code provide low-latency live H.264 video through mediasoup. Uploaded files use HLS only.
- `src/App.jsx` is the browser UI: source setup, live WebRTC view, HLS DVR player, telemetry details, and map.

## HLS outputs

For every source, the app writes two different HLS paths:

- The browser path contains video only, plus a WebVTT subtitle/metadata track.
- The private carrier path preserves source video and KLV so the server can continue extracting telemetry. It is not served as the playback experience.

In passthrough mode, H.264 video is packetized into HLS without re-encoding. Source audio is deliberately discarded. If the video is not H.264, the app creates a single H.264 playback rendition instead. The optional ABR mode creates low, medium, and native-resolution renditions.

## Live video

For a stream source, FFmpeg also sends H.264 RTP to mediasoup. The browser connects to mediasoup using WebRTC for low-latency live viewing. In **Auto** mode, H.264 is copied into RTP; other video is transcoded to H.264 first. This live route is separate from the HLS DVR route. Uploaded files do not have a live WebRTC route.

## A useful mental model

Video and telemetry travel together in the input, but the PoC separates them for the browser: HLS/WebRTC delivers video, while WebVTT (for DVR) or WebSocket (for live) delivers the matching telemetry. The UI joins them using time.
