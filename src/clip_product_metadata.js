/**
 * Resolves catalog metadata for the user-selected source interval of a clip.
 * KLV mission time is preferred; a manual no-KLV anchor can still provide a
 * useful temporal extent, while missing spatial metadata deliberately leaves
 * geometry null so the catalog inherits the mission coverage bbox.
 */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function missionWindowForClip(timeline, startSeconds, endSeconds) {
  if (!timeline) return null;
  const startVideoMs = Math.round(Number(startSeconds) * 1000);
  const endVideoMs = Math.round(Number(endSeconds) * 1000);
  const missionStartMs = Math.round(Number(timeline.missionBaseMs) + startVideoMs - Number(timeline.videoBaseMs));
  const missionEndMs = Math.round(Number(timeline.missionBaseMs) + endVideoMs - Number(timeline.videoBaseMs));
  if (![missionStartMs, missionEndMs, timeline.missionMinMs, timeline.missionMaxMs].every(Number.isFinite)) return null;
  const fromMs = Math.max(missionStartMs, Math.round(timeline.missionMinMs));
  const toMs = Math.min(missionEndMs, Math.round(timeline.missionMaxMs));
  return fromMs <= toMs ? { fromMs, toMs } : null;
}

function geometryForTrack(points) {
  const valid = (Array.isArray(points) ? points : []).filter((point) => (
    finiteNumber(point?.lat) != null && finiteNumber(point?.lon) != null
    && Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lon)) <= 180
  ));
  if (valid.length === 1) return `POINT(${valid[0].lon} ${valid[0].lat})`;
  if (valid.length > 1) return `LINESTRING(${valid.map((point) => `${point.lon} ${point.lat}`).join(",")})`;
  return null;
}

/** Builds a WKT geometry from platform and frame-center KLV samples. */
export function clipCoverageWkt({ platformPoints = [], frameCenterPoints = [] } = {}) {
  const members = [geometryForTrack(platformPoints), geometryForTrack(frameCenterPoints)].filter(Boolean);
  if (!members.length) return null;
  return members.length === 1 ? members[0] : `GEOMETRYCOLLECTION(${members.join(",")})`;
}

/**
 * Reads the source metadata needed by a derived clip product. The returned
 * null geometry is intentional: SqliteKlvStore then copies the mission bbox.
 */
export async function deriveClipProductMetadata({ store, streamId, startSeconds, endSeconds }) {
  const timeline = await store.getMissionTimeline(streamId);
  const klvWindow = missionWindowForClip(timeline, startSeconds, endSeconds);

  if (klvWindow) {
    const [platform, frameCenter] = await Promise.all([
      store.listPlatformTrackPoints(streamId, klvWindow),
      store.listFrameCenterTrackPoints(streamId, klvWindow)
    ]);
    return {
      temporalStartMs: klvWindow.fromMs,
      temporalEndMs: klvWindow.toMs,
      geometryWkt: clipCoverageWkt({ platformPoints: platform?.points, frameCenterPoints: frameCenter?.points }),
      metadataSource: "klv"
    };
  }

  const anchor = await store.getManualVideoTimeAnchor(streamId);
  const firstFrameUtcMs = finiteNumber(anchor?.firstFrameUtcMs);
  if (firstFrameUtcMs != null) {
    return {
      temporalStartMs: Math.round(firstFrameUtcMs + Number(startSeconds) * 1000),
      temporalEndMs: Math.round(firstFrameUtcMs + Number(endSeconds) * 1000),
      geometryWkt: null,
      metadataSource: "manual-anchor"
    };
  }

  return { temporalStartMs: null, temporalEndMs: null, geometryWkt: null, metadataSource: "mission" };
}
