#!/usr/bin/env node
/** Streams a local transport stream to UDP multicast for PoC integration testing. */

import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();

/** Parses a required positive-integer command-line option. */
function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer byte count`);
  }
  return parsed;
}

/** Creates a transport-packet-aligned temporary copy for repeatable looping. */
async function ensureTruncatedTsCopy(inputFile, validBytes) {
  const sourceStat = await fs.promises.stat(inputFile);
  if (sourceStat.size < validBytes) {
    throw new Error(`Input is only ${sourceStat.size} bytes; cannot retain ${validBytes} bytes`);
  }

  const parsed = path.parse(inputFile);
  const cleanFile = path.join(parsed.dir, `${parsed.name}-clean${parsed.ext || '.ts'}`);
  try {
    const cleanStat = await fs.promises.stat(cleanFile);
    if (cleanStat.size === validBytes) return cleanFile;
    throw new Error(`Existing clean copy has ${cleanStat.size} bytes; expected ${validBytes}. Remove it before retrying.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  console.log(`Creating clean TS copy: ${cleanFile} (${validBytes} bytes)`);
  const source = await fs.promises.open(inputFile, 'r');
  const clean = await fs.promises.open(cleanFile, 'wx');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let position = 0;

  try {
    while (position < validBytes) {
      const length = Math.min(buffer.length, validBytes - position);
      const { bytesRead } = await source.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error('Input ended before the requested clean-copy boundary');
      await clean.write(buffer, 0, bytesRead);
      position += bytesRead;
    }
  } catch (error) {
    await clean.close().catch(() => {});
    await fs.promises.unlink(cleanFile).catch(() => {});
    throw error;
  } finally {
    await source.close().catch(() => {});
    await clean.close().catch(() => {});
  }

  return cleanFile;
}

program
  .name('mpegts-klv-streamer')
  .description('Stream MPEG-TS video with ST0601 KLV metadata over UDP multicast')
  .version('1.0.0')
  .requiredOption('-i, --input <file>', 'Input video file')
  .option('-a, --address <address>', 'Multicast address', '239.1.2.3')
  .option('-p, --port <port>', 'UDP port', '5000')
  .option('-l, --loop', 'Loop the video indefinitely', false)
  .option('-d, --duration <seconds>', 'Stream duration in seconds (0 = until interrupted)', '0')
  .option('--clean-ts-at <bytes>', 'Create and stream a clean TS copy truncated at this valid byte boundary')
  .option('--udp-bitrate <bits>', 'Pace UDP output to this bitrate in bits per second')
  .option('--udp-burst-bits <bits>', 'Maximum UDP burst size when --udp-bitrate is set');

program.parse();

const options = program.opts();

// Check if input file exists
if (!fs.existsSync(options.input)) {
  console.error(`Input file not found: ${options.input}`);
  process.exit(1);
}

let inputFile = options.input;
if (options.cleanTsAt != null) {
  try {
    inputFile = await ensureTruncatedTsCopy(options.input, parsePositiveInteger(options.cleanTsAt, '--clean-ts-at'));
  } catch (error) {
    console.error(`Unable to prepare clean TS copy: ${String(error?.message || error)}`);
    process.exit(1);
  }
}

let udpBitrate = null;
let udpBurstBits = null;
try {
  if (options.udpBitrate != null) udpBitrate = parsePositiveInteger(options.udpBitrate, '--udp-bitrate');
  if (options.udpBurstBits != null) udpBurstBits = parsePositiveInteger(options.udpBurstBits, '--udp-burst-bits');
  if (udpBurstBits != null && udpBitrate == null) {
    throw new Error('--udp-burst-bits requires --udp-bitrate');
  }
} catch (error) {
  console.error(`Invalid UDP pacing option: ${String(error?.message || error)}`);
  process.exit(1);
}

console.log(`Streaming ${inputFile} to udp://${options.address}:${options.port}`);
console.log(`Loop: ${options.loop ? 'enabled' : 'disabled'}`);
console.log(`Duration: ${options.duration > 0 ? options.duration + ' seconds' : 'until interrupted'}`);
if (udpBitrate != null) {
  console.log(`UDP pacing: ${udpBitrate} bits/s${udpBurstBits != null ? `, burst limit ${udpBurstBits} bits` : ''}`);
}
console.log(`Press Ctrl+C to stop`);

// FFmpeg command to stream MPEG-TS over UDP multicast
const ffmpegArgs = [
  '-re', // Read input at native frame rate
  '-i', inputFile, // Input file
  '-map', '0:v:0', // Video is required
  '-map', '0:a:0?', // Preserve audio when present
  '-map', '0:d:0?', // Preserve the first recognized data stream (KLV)
  '-c', 'copy', // Copy streams without re-encoding
  '-f', 'mpegts', // Output format
];

if (options.loop) {
  ffmpegArgs.unshift('-stream_loop', '-1'); // Loop indefinitely
}

if (options.duration > 0) {
  ffmpegArgs.push('-t', options.duration.toString());
}

const udpParams = new URLSearchParams({ pkt_size: '1316' });
if (udpBitrate != null) udpParams.set('bitrate', String(udpBitrate));
if (udpBurstBits != null) udpParams.set('burst_bits', String(udpBurstBits));
ffmpegArgs.push(`udp://${options.address}:${options.port}?${udpParams.toString()}`);

console.log(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['pipe', 'inherit', 'inherit']
});

ffmpeg.on('close', (code) => {
  console.log(`FFmpeg exited with code ${code}`);
  process.exit(code);
});

ffmpeg.on('error', (err) => {
  console.error('Failed to start FFmpeg:', err);
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nStopping stream...');
  ffmpeg.kill('SIGINT');
});

process.on('SIGTERM', () => {
  ffmpeg.kill('SIGTERM');
});
