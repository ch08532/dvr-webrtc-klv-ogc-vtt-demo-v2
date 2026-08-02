/** Decodes supported MISB ST 0601 fields, including UTC timestamp and Mission ID. */

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

/** Reads a null-padded MISB UTF-8 string. */
function readText(v) {
  const text = v.toString('utf8').replace(/\0+$/g, '').trim();
  return text || null;
}

/** Reads an 8-bit signed value, reserving the MISB invalid sentinel. */
function readInt8(v) {
  const value = v.readInt8(0);
  return value === -128 ? null : value;
}

/** Tests whether every frame-corner coordinate needed for a footprint exists. */
function hasCompleteCorners(payload) {
  return [1, 2, 3, 4].every((index) => Number.isFinite(payload[`frameCorner${index}Lat`]) && Number.isFinite(payload[`frameCorner${index}Lon`]));
}

const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Returns the initial bearing from one geographic point to another. */
function bearingBetween(lat1, lon1, lat2, lon2) {
  const startLat = lat1 * DEG_TO_RAD;
  const endLat = lat2 * DEG_TO_RAD;
  const deltaLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(deltaLon) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat)
    - Math.sin(startLat) * Math.cos(endLat) * Math.cos(deltaLon);
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

/** Returns a point reached by travelling a distance from a latitude/longitude. */
function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = bearingDeg * DEG_TO_RAD;
  const startLat = lat * DEG_TO_RAD;
  const startLon = lon * DEG_TO_RAD;
  const endLat = Math.asin(
    Math.sin(startLat) * Math.cos(angularDistance)
    + Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const endLon = startLon + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLat),
    Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(endLat)
  );
  return {
    lat: endLat * RAD_TO_DEG,
    lon: ((endLon * RAD_TO_DEG + 540) % 360) - 180
  };
}

/** Tests whether the source supplied offset-corner values describe any footprint extent. */
function hasMeaningfulOffsets(payload) {
  const keys = [1, 2, 3, 4].flatMap((index) => [`offsetCorner${index}Lat`, `offsetCorner${index}Lon`]);
  return keys.every((key) => Number.isFinite(payload[key]))
    && keys.some((key) => Math.abs(payload[key]) > 1e-9);
}

/**
 * Estimates frame corners on a flat local ground plane when the source omits
 * usable corner offsets. This is an approximation, not terrain correction.
 */
function computeFlatFrameCorners(payload) {
  const sensorLat = Number(payload.sensorLat);
  const sensorLon = Number(payload.sensorLon);
  const sensorAltitudeM = Number(payload.sensorAltMslM);
  const frameCenterLat = Number(payload.frameCenterLat);
  const frameCenterLon = Number(payload.frameCenterLon);
  const slantRangeM = Number(payload.slantRangeM);
  const horizontalFovDeg = Number(payload.sensorHfovDeg);
  const verticalFovDeg = Number(payload.sensorVfovDeg);
  const sensorRelativeElevationDeg = Number(payload.sensorRelElDeg);
  const platformPitchDeg = Number(payload.platformPitchDeg || 0);
  const sensorRollDeg = Number(payload.sensorRelRollDeg || 0);

  if (![sensorLat, sensorLon, sensorAltitudeM, frameCenterLat, frameCenterLon, slantRangeM, horizontalFovDeg, verticalFovDeg, sensorRelativeElevationDeg, platformPitchDeg, sensorRollDeg].every(Number.isFinite)) {
    return null;
  }
  if (slantRangeM <= 0 || horizontalFovDeg <= 0 || verticalFovDeg <= 0) return null;

  const centerElevationDeg = sensorRelativeElevationDeg + platformPitchDeg;
  if (centerElevationDeg >= -0.01) return null;
  const centerElevationRad = centerElevationDeg * DEG_TO_RAD;
  const groundAltitudeM = Number.isFinite(Number(payload.frameCenterElevationMslM))
    ? Number(payload.frameCenterElevationMslM)
    : sensorAltitudeM + slantRangeM * Math.sin(centerElevationRad);
  const altitudeAboveGroundM = sensorAltitudeM - groundAltitudeM;
  if (!Number.isFinite(altitudeAboveGroundM) || altitudeAboveGroundM <= 0) return null;

  const lookBearingDeg = bearingBetween(sensorLat, sensorLon, frameCenterLat, frameCenterLon);
  const halfHorizontal = horizontalFovDeg / 2;
  const halfVertical = verticalFovDeg / 2;
  const rollRad = sensorRollDeg * DEG_TO_RAD;
  const corners = [
    { horizontal: -halfHorizontal, vertical: halfVertical },
    { horizontal: halfHorizontal, vertical: halfVertical },
    { horizontal: halfHorizontal, vertical: -halfVertical },
    { horizontal: -halfHorizontal, vertical: -halfVertical }
  ].map(({ horizontal, vertical }) => {
    const rotatedHorizontal = horizontal * Math.cos(rollRad) - vertical * Math.sin(rollRad);
    const rotatedVertical = horizontal * Math.sin(rollRad) + vertical * Math.cos(rollRad);
    const elevationRad = (centerElevationDeg + rotatedVertical) * DEG_TO_RAD;
    if (elevationRad >= -0.001) return null;
    const groundDistanceM = altitudeAboveGroundM / Math.tan(-elevationRad);
    if (!Number.isFinite(groundDistanceM) || groundDistanceM <= 0) return null;
    return destinationPoint(sensorLat, sensorLon, lookBearingDeg + rotatedHorizontal, groundDistanceM);
  });

  return corners.every(Boolean) ? corners : null;
}

/** Decodes the supported MISB ST 0601 local-set tags into engineering units. */
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

      case 3: {
        const missionId = readText(v);
        if (missionId) out.missionId = missionId;
        break;
      }

      // Platform, sensor, and image identity.
      case 4: { const value = readText(v); if (value) out.platformTailNumber = value; break; }
      case 8: if (v.length === 1) out.platformTrueAirspeedMps = v[0]; break;
      case 9: if (v.length === 1) out.platformIndicatedAirspeedMps = v[0]; break;
      case 10: { const value = readText(v); if (value) out.platformDesignation = value; break; }
      case 11: { const value = readText(v); if (value) out.imageSourceSensor = value; break; }
      case 12: { const value = readText(v); if (value) out.imageCoordinateSystem = value; break; }

      case 13: if (v.length === 4) out.sensorLat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 14: if (v.length === 4) out.sensorLon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 15: if (v.length === 2) out.sensorAltMslM = mapUint16ToRange(v.readUInt16BE(0), -900, 19000); break;

      case 16: if (v.length === 2) out.sensorHfovDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 180); break;
      case 17: if (v.length === 2) out.sensorVfovDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 180); break;

      case 18: if (v.length === 4) out.sensorRelAzDeg = mapUint32ToRange(v.readUInt32BE(0), 0, 360); break;
      case 19: if (v.length === 4) out.sensorRelElDeg = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 20: if (v.length === 4) out.sensorRelRollDeg = mapUint32ToRange(v.readUInt32BE(0), -180, 180); break;

      case 21: if (v.length === 4) out.slantRangeM = mapUint32ToRange(v.readUInt32BE(0), 0, 5_000_000); break;

      // Target geometry, location, tracking gate, and position-error metadata.
      case 22: if (v.length === 2) out.targetWidthM = mapUint16ToRange(v.readUInt16BE(0), 0, 10_000); break;

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

      // Environmental conditions and platform/aircraft state.
      case 34: if (v.length === 1) out.icingDetectedCode = v[0]; break;
      case 35: if (v.length === 2) out.windDirectionDeg = mapUint16ToRange(v.readUInt16BE(0), 0, 360); break;
      case 36: if (v.length === 1) out.windSpeedMps = v[0]; break;
      case 37: if (v.length === 2) out.staticPressureMbar = mapUint16ToRange(v.readUInt16BE(0), 0, 5_000); break;
      case 38: if (v.length === 2) out.densityAltitudeM = mapUint16ToRange(v.readUInt16BE(0), -900, 19_000); break;
      case 39: if (v.length === 1) out.outsideAirTemperatureC = readInt8(v); break;

      case 40: if (v.length === 4) out.targetLat = mapInt32ToRange(v.readInt32BE(0), -90, 90); break;
      case 41: if (v.length === 4) out.targetLon = mapInt32ToRange(v.readInt32BE(0), -180, 180); break;
      case 42: if (v.length === 2) out.targetElevationMslM = mapUint16ToRange(v.readUInt16BE(0), -900, 19_000); break;
      case 43: if (v.length === 1) out.targetTrackGateWidthPx = v[0]; break;
      case 44: if (v.length === 1) out.targetTrackGateHeightPx = v[0]; break;
      case 45: if (v.length === 2) out.targetLocationCe90M = mapUint16ToRange(v.readUInt16BE(0), 0, 4_095); break;
      case 46: if (v.length === 2) out.targetLocationLe90M = mapUint16ToRange(v.readUInt16BE(0), 0, 4_095); break;

      case 49: if (v.length === 2) out.differentialPressureMbar = mapUint16ToRange(v.readUInt16BE(0), 0, 5_000); break;
      case 50: if (v.length === 2) out.platformAngleOfAttackDeg = mapInt16ToRange(v.readInt16BE(0), -20, 20); break;
      case 51: if (v.length === 2) out.platformVerticalSpeedMps = mapInt16ToRange(v.readInt16BE(0), -180, 180); break;
      case 52: if (v.length === 2) out.platformSideslipAngleDeg = mapInt16ToRange(v.readInt16BE(0), -20, 20); break;
      case 53: if (v.length === 2) out.airfieldBarometricPressureMbar = mapUint16ToRange(v.readUInt16BE(0), 0, 5_000); break;
      case 54: if (v.length === 2) out.airfieldElevationM = mapUint16ToRange(v.readUInt16BE(0), -900, 19_000); break;
      case 55: if (v.length === 1) out.relativeHumidityPercent = v[0]; break;
      case 56: if (v.length === 1) out.platformGroundSpeedMps = v[0]; break;
      case 58: if (v.length === 2) out.platformFuelRemainingKg = mapUint16ToRange(v.readUInt16BE(0), 0, 10_000); break;
      case 59: { const value = readText(v); if (value) out.platformCallSign = value; break; }

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
  if (hasFrameCenter && hasMeaningfulOffsets(out)) {
    for (const index of [1, 2, 3, 4]) {
      out[`frameCorner${index}Lat`] = out.frameCenterLat + out[`offsetCorner${index}Lat`];
      out[`frameCorner${index}Lon`] = out.frameCenterLon + out[`offsetCorner${index}Lon`];
    }
    out.frameCornerSource = 'offset';
    return out;
  }

  const computedCorners = computeFlatFrameCorners(out);
  if (computedCorners) {
    computedCorners.forEach((corner, index) => {
      const cornerIndex = index + 1;
      out[`frameCorner${cornerIndex}Lat`] = corner.lat;
      out[`frameCorner${cornerIndex}Lon`] = corner.lon;
    });
    out.frameCornerSource = 'computed-flat';
  }

  return out;
}
