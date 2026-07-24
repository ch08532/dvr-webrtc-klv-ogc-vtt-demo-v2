# MPEG-TS KLV Streamer

A tool to stream MPEG-TS video files over UDP multicast for testing the DVR demo.

## Installation

```bash
cd streamer
npm install
```

## Usage

```bash
node streamer.js -i <input_video.mp4> [options]
```

### Options

- `-i, --input <file>`: Input video file (required)
- `-a, --address <address>`: Multicast address (default: 239.1.2.3)
- `-p, --port <port>`: UDP port (default: 5000)
- `-l, --loop`: Loop the video indefinitely
- `-d, --duration <seconds>`: Stream duration (0 = until interrupted)
- `--clean-ts-at <bytes>`: Create and use a clean copy truncated at a known-valid TS byte boundary
- `--udp-bitrate <bits>`: Pace UDP output at a fixed maximum bitrate
- `--udp-burst-bits <bits>`: Limit UDP bursts when output pacing is enabled

### Examples

```bash
# Stream a video file with default settings
node streamer.js -i sample.mp4

# Stream with custom multicast address
node streamer.js -i video.mp4 -a 239.1.1.1 -p 5001

# Stream for 30 seconds only
node streamer.js -i video.mp4 -d 30

# Loop the video indefinitely
node streamer.js -i video.mp4 --loop
```

### Repairing a TS file with a corrupt tail

Use `--clean-ts-at` to preserve the original and create a `-clean.ts` copy containing only valid TS packets. The MX15 launcher is preconfigured with its known valid boundary:

```bash
npm run start-mx15-sample
```

## Generate Sample Video

```bash
node generate-sample.js -o sample.ts -d 30
```

This creates a 30-second test pattern video with color bars and tone.

## Testing with DVR Demo

1. **Generate or obtain a video file** (MP4, AVI, MOV, etc.)

2. **Start the DVR demo**:
   ```bash
   npm start
   ```
   Open http://localhost:8090

3. **Configure a source in the UI**:
   - Stream ID: `test1`
   - Input URL: `udp://239.1.2.3:5000`
   - DVR Seconds: `600`
   - VTT Segment Seconds: `5`
   - Click "Start Source"

4. **Start streaming**:
   ```bash
   cd streamer
   node streamer.js -i ../path/to/your/video.mp4
   ```

5. **Test playback**:
   - Click "Live (WebRTC)" or "DVR (HLS)" tabs
   - The video should play
   - Metadata overlay will appear if KLV data is present

## KLV Metadata Support

**Current Limitation**: This streamer streams video but does not yet inject ST0601 KLV metadata into the MPEG-TS stream.

For testing KLV parsing:
- The DVR demo can parse KLV from streams that contain it
- To test with real KLV data, you would need:
  - A video file with embedded KLV metadata, or
  - A professional video encoding tool that supports MISB ST0601

## Requirements

- Node.js 18+
- FFmpeg installed and in PATH
- Input video file (MP4, AVI, MOV, etc.)

## Troubleshooting

- **FFmpeg not found**: Install FFmpeg and ensure it's in your PATH
- **Network issues**: Check firewall settings for UDP multicast
- **Video not playing**: Verify the input file is a valid video format
- **Multicast not working**: Try using a different multicast address or unicast UDP

## Future Enhancements

- KLV metadata injection into MPEG-TS streams
- Real-time KLV generation and embedding
- Support for various KLV standards (ST0601, ST0102, etc.)
