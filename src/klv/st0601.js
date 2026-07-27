/** Decodes the MISB ST 0601 local-set payload into usable telemetry fields. */

/** Reads a BER length field from a local-set buffer. */
function berReadLength(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const n = first & 0x7f;
  if (n === 0 || offset + 1 + n > buf.length) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 1 + i];
  return { length: len, bytes: 1 + n };
}

/** Reads a BER OID local-set tag. */
function berOidReadTag(buf, offset) {
  let tag = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    tag = (tag << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return { tag, bytes: i - offset };
  }
  return null;
}

/** Scales a signed 32-bit MISB value into its physical range. */
function mapInt32ToRange(v, min, max) {
  if (v === -2147483648) return null;
  const intRange = 2147483647;
  const span = max - min;
  return (v / intRange) * (span / 2) + (min + max) / 2;
}
/** Scales an unsigned 16-bit MISB value into its physical range. */
function mapUint16ToRange(u, min, max) { return min + (u / 65535) * (max - min); }
/** Scales an unsigned 32-bit MISB value into its physical range. */
function mapUint32ToRange(u, min, max) { return min + (u / 4294967295) * (max - min); }
/** Scales a signed 16-bit MISB value into its physical range. */
function mapInt16ToRange(v, min, max) {
  if (v === -32768) return null;
  return min + ((v + 32767) / 65534) * (max - min);
}

/** Tests whether every frame-corner coordinate needed for a footprint exists. */
function hasCompleteCorners(payload) {
  return [1, 2, 3, 4].every((index) => Number.isFinite(payload[`frameCorner${index}Lat`]) && Number.isFinite(payload[`frameCorner${index}Lon`]));
}

/** Decodes supported ST 0601 tags, retaining raw values for unsupported fields. */
export function decodeSt0601LocalSet(lsBuf) {
  const out = {};
  let off = 0;

  while (off < lsBuf.length) {
    const tagInfo = berOidReadTag(lsBuf, off);
    if (!tagInfo) break;
    off += tagInfo.bytes;

    const lenInfo = berReadLength(lsBuf, off);
    if (!lenInfo) break;
    off += lenInfo.bytes;

    const end = off + lenInfo.length;
    if (end > lsBuf.length) break;

    const v = lsBuf.subarray(off, end);
    off = end;

    switch (tagInfo.tag) {
      case 2:
        if (v.length === 8) {
          const micros = v.readBigUInt64BE(0);
          out.timestampUnixMicros = micros.toString();
          out.timestampIso = new Date(Number(micros / 1000n)).toISOString();
        }
        break;

      case 13: if (v.length === 4) out.sensorLat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 14: if (v.length === 4) out.sensorLon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 15: if (v.length === 2) out.sensorAltMslM = mapUint16ToRange(v.readUInt16BE(0), -900, 19000); break;

      case 16: if (v.length === 2) out.sensorHfovDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 180); break;
      case 17: if (v.length === 2) out.sensorVfovDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 180); break;

      case 18: if (v.length === 4) out.sensorRelAzDeg = mapUint32ToRange(v.readUInt32BE(0), 0, 360); break;
      case 19: if (v.length === 4) out.sensorRelElDeg = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 20: if (v.length === 4) out.sensorRelRollDeg = mapUint32ToRange(v.readUInt32BE(0), -180, 180); break;

      case 21: if (v.length === 4) out.slantRangeM = mapUint32ToRange(v.readUInt32BE(0), 0, 5_000_000); break;

      case 23: if (v.length === 4) out.frameCenterLat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 24: if (v.length === 4) out.frameCenterLon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 25: if (v.length === 2) out.frameCenterElevationMslM = mapUint16ToRange(v.readUInt16BE(0), -900, 19000); break;

      case 26: if (v.length === 2) out.offsetCorner1Lat = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 27: if (v.length === 2) out.offsetCorner1Lon = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 28: if (v.length === 2) out.offsetCorner2Lat = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 29: if (v.length === 2) out.offsetCorner2Lon = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 30: if (v.length === 2) out.offsetCorner3Lat = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 31: if (v.length === 2) out.offsetCorner3Lon = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 32: if (v.length === 2) out.offsetCorner4Lat = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;
      case 33: if (v.length === 2) out.offsetCorner4Lon = mapInt16ToRange(v.readInt16BE(0), -0.075, 0.075); break;

      case 82: if (v.length === 4) out.frameCorner1Lat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 83: if (v.length === 4) out.frameCorner1Lon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 84: if (v.length === 4) out.frameCorner2Lat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 85: if (v.length === 4) out.frameCorner2Lon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 86: if (v.length === 4) out.frameCorner3Lat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 87: if (v.length === 4) out.frameCorner3Lon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 88: if (v.length === 4) out.frameCorner4Lat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 89: if (v.length === 4) out.frameCorner4Lon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;

      case 5: if (v.length === 2) out.platformHeadingDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 360); break;
      case 6: if (v.length === 2) out.platformPitchDeg = mapInt16ToRange(v.readInt16BE(0), -20, 20); break;
      case 7: if (v.length === 2) out.platformRollDeg = mapInt16ToRange(v.readInt16BE(0), -50, 50); break;

      default:
        break;
    }
  }

  if (hasCompleteCorners(out)) {
    out.frameCornerSource = 'full';
    return out;
  }

  const hasFrameCenter = Number.isFinite(out.frameCenterLat) && Number.isFinite(out.frameCenterLon);
  const hasCompleteOffsets = [1, 2, 3, 4].every((index) => Number.isFinite(out[`offsetCorner${index}Lat`]) && Number.isFinite(out[`offsetCorner${index}Lon`]));
  if (hasFrameCenter && hasCompleteOffsets) {
    for (const index of [1, 2, 3, 4]) {
      out[`frameCorner${index}Lat`] = out.frameCenterLat + out[`offsetCorner${index}Lat`];
      out[`frameCorner${index}Lon`] = out.frameCenterLon + out[`offsetCorner${index}Lon`];
    }
    out.frameCornerSource = 'offset';
  }

  return out;
}
