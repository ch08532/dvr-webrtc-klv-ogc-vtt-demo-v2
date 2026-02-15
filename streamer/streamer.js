#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();

program
  .name('mpegts-klv-streamer')
  .description('Stream MPEG-TS video with ST0601 KLV metadata over UDP multicast')
  .version('1.0.0')
  .requiredOption('-i, --input <file>', 'Input video file')
  .option('-a, --address <address>', 'Multicast address', '239.1.2.3')
  .option('-p, --port <port>', 'UDP port', '5000')
  .option('-l, --loop', 'Loop the video indefinitely', false)
  .option('-d, --duration <seconds>', 'Stream duration in seconds (0 = until interrupted)', '0');

program.parse();

const options = program.opts();

// Check if input file exists
if (!fs.existsSync(options.input)) {
  console.error(`Input file not found: ${options.input}`);
  process.exit(1);
}

console.log(`Streaming ${options.input} to udp://${options.address}:${options.port}`);
console.log(`Loop: ${options.loop ? 'enabled' : 'disabled'}`);
console.log(`Duration: ${options.duration > 0 ? options.duration + ' seconds' : 'until interrupted'}`);
console.log(`Press Ctrl+C to stop`);

// FFmpeg command to stream MPEG-TS over UDP multicast
const ffmpegArgs = [
  '-re', // Read input at native frame rate
  '-i', options.input, // Input file
  '-c', 'copy', // Copy streams without re-encoding
  '-f', 'mpegts', // Output format
];

if (options.loop) {
  ffmpegArgs.unshift('-stream_loop', '-1'); // Loop indefinitely
}

if (options.duration > 0) {
  ffmpegArgs.push('-t', options.duration.toString());
}

ffmpegArgs.push(`udp://${options.address}:${options.port}?pkt_size=1316`);

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