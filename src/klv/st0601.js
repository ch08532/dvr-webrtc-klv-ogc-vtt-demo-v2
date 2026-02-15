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

function mapInt32ToRange(v, min, max) {
  if (v === -2147483648) return null;
  const intRange = 2147483647;
  const span = max - min;
  return (v / intRange) * (span / 2) + (min + max) / 2;
}
function mapUint16ToRange(u, min, max) { return min + (u / 65535) * (max - min); }
function mapUint32ToRange(u, min, max) { return min + (u / 4294967295) * (max - min); }
function mapInt16ToRange(v, min, max) {
  if (v === -32768) return null;
  return min + ((v + 32767) / 65534) * (max - min);
}

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
      case 20: if (v.length === 4) out.sensorRelRollDeg = mapUint32ToRange(v.readUInt32BE(0), 0, 360); break;

      case 21: if (v.length === 4) out.slantRangeM = mapUint32ToRange(v.readUInt32BE(0), 0, 5_000_000); break;

      case 23: if (v.length === 4) out.frameCenterLat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 24: if (v.length === 4) out.frameCenterLon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;

      case 65: if (v.length === 4) out.platformHeadingDeg = mapUint32ToRange(v.readUInt32BE(0), 0, 360); break;
      case 66: if (v.length === 2) out.platformPitchDeg = mapInt16ToRange(v.readInt16BE(0), -20, 20); break;
      case 67: if (v.length === 2) out.platformRollDeg = mapInt16ToRange(v.readInt16BE(0), -50, 50); break;

      default:
        break;
    }
  }
  return out;
}
