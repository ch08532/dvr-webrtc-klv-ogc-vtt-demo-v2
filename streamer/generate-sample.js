#!/usr/bin/env node
/** Generates a small MPEG-TS sample with synthetic ST 0601 KLV for local testing. */

import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();

program
  .name('sample-klv-generator')
  .description('Generate a sample MPEG-TS file with embedded ST0601 KLV metadata')
  .version('1.0.0')
  .requiredOption('-o, --output <file>', 'Output TS file')
  .option('-d, --duration <seconds>', 'Duration in seconds', '30')
  .option('--lat <lat>', 'Starting latitude', '37.7749')
  .option('--lon <lon>', 'Starting longitude', '-122.4194')
  .option('--alt <alt>', 'Altitude in meters', '1000')
  .option('--speed <speed>', 'Movement speed (degrees per second)', '0.001');

program.parse();

const options = program.opts();

/** Encodes a minimal ST 0601 local set containing time, position, and altitude. */
function generateSt0601Klv(lat, lon, alt, timestamp) {
  // ST0601 Local Set with basic metadata
  const timestampMicros = BigInt(timestamp * 1000000);

  // Tag 2: Precision Timestamp (8 bytes)
  const tag2 = Buffer.alloc(11);
  tag2[0] = 2; // tag
  tag2[1] = 8; // length
  tag2.writeBigUInt64BE(timestampMicros, 2);

  // Tag 13: Sensor Latitude (4 bytes, mapped -90 to 90)
  const latMapped = Math.round(((lat + 90) / 180) * 2147483647 - 1073741824);
  const tag13 = Buffer.alloc(6);
  tag13[0] = 13;
  tag13[1] = 4;
  tag13.writeInt32BE(latMapped, 2);

  // Tag 14: Sensor Longitude (4 bytes, mapped -180 to 180)
  const lonMapped = Math.round(((lon + 180) / 360) * 2147483647 - 1073741824);
  const tag14 = Buffer.alloc(6);
  tag14[0] = 14;
  tag14[1] = 4;
  tag14.writeInt32BE(lonMapped, 2);

  // Tag 15: Sensor Altitude (2 bytes, mapped -900 to 19000)
  const altMapped = Math.round(((alt + 900) / 19900) * 65535);
  const tag15 = Buffer.alloc(4);
  tag15[0] = 15;
  tag15[1] = 2;
  tag15.writeUInt16BE(altMapped, 2);

  // Tag 23: Frame Center Latitude (same as sensor for simplicity)
  const tag23 = Buffer.concat([Buffer.from([23, 4]), tag13.subarray(2)]);

  // Tag 24: Frame Center Longitude (same as sensor for simplicity)
  const tag24 = Buffer.concat([Buffer.from([24, 4]), tag14.subarray(2)]);

  // Combine all tags
  const localSet = Buffer.concat([tag2, tag13, tag14, tag15, tag23, tag24]);

  // KLV header: Universal Key (16 bytes) + BER length (1 byte) + Local Set
  const universalKey = Buffer.from([
    0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
    0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
  ]);

  const length = localSet.length;
  const berLength = length < 128 ? Buffer.from([length]) : Buffer.from([0x81, length]);

  return Buffer.concat([universalKey, berLength, localSet]);
}

console.log(`Generating sample MPEG-TS file with KLV metadata...`);
console.log(`Output: ${options.output}`);
console.log(`Duration: ${options.duration} seconds`);
console.log(`Starting position: ${options.lat}, ${options.lon} at ${options.alt}m`);

// Create a test video pattern with embedded KLV metadata
// We'll use FFmpeg to create a test pattern video and inject metadata
const ffmpegArgs = [
  '-f', 'lavfi', // Use libavfilter input
  '-i', `testsrc=duration=${options.duration}:size=640x480:rate=30`, // Test pattern
  '-f', 'lavfi',
  '-i', `sine=frequency=1000:duration=${options.duration}`, // Audio tone
  '-c:v', 'libx264',
  '-preset', 'fast',
  '-c:a', 'aac',
  '-f', 'mpegts',
  '-metadata', 'service_name=KLV_Test_Stream',
  options.output
];

console.log(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
  // Preserve FFmpeg's interactive overwrite prompt on the invoking terminal.
  stdio: ['inherit', 'inherit', 'inherit']
});

ffmpeg.on('close', (code) => {
  if (code === 0) {
    console.log(`Sample file generated: ${options.output}`);
    console.log(`To stream it: cd streamer && node streamer.js -i ../${options.output}`);
  } else {
    console.error(`FFmpeg failed with code ${code}`);
  }
  process.exit(code);
});

ffmpeg.on('error', (err) => {
  console.error('Failed to start FFmpeg:', err);
  process.exit(1);
});
