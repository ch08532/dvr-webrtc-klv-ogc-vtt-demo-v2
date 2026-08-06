/** Defines the HLS rendition ladder and creates matching master playlists. */

// This order is part of the HLS recorder contract: v0 is the fixed low rung
// and v1 is the dynamic native/source high rung.
export const NATIVE_ABR_RENDITION_INDEX = 1;

// The Low rendition is the only static part of the ABR ladder.  High is
// always constructed from ffprobe dimensions in topRenditionForSource().
export const HLS_RENDITIONS = [
  {
    id: "360p",
    playlist: "v0/index.m3u8",
    width: 640,
    height: 360,
    videoBitrate: "800k",
    maxRate: "856k",
    bufferSize: "1200k",
    averageBandwidth: 800000,
    bandwidth: 856000,
    codecs: "avc1.42e02a,wvtt"
  }
];

const DEFAULT_SOURCE_FPS = 30;
const FALLBACK_BITS_PER_DISPLAY_PIXEL_FRAME = 0.08;
const BITRATE_SCALE_EXPONENT = 0.8;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseAspectRatio(value) {
  const match = String(value || "").match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function boundedFps(value) {
  const fps = Number(value);
  return Number.isFinite(fps) && fps > 0 ? clamp(fps, 1, 120) : DEFAULT_SOURCE_FPS;
}

function bitrateBounds(rendition, isNative) {
  if (isNative) return { minimum: 250_000, maximum: 12_000_000 };
  return { minimum: 400_000, maximum: 1_500_000 };
}

function formatBitrate(bitsPerSecond) {
  return `${Math.max(1, Math.round(bitsPerSecond / 1_000))}k`;
}

/**
 * Derives bitrate fields for a complete ABR ladder.
 *
 * The probed source bitrate is the native-rung target when available. Lower
 * rungs scale that target by display-pixel area (with a sub-linear exponent
 * for codec overhead); a frame-rate-aware pixels-per-frame estimate is used
 * only when a source bitrate is unavailable. Bounds protect the low rungs
 * from starvation and protect the native rung from excessive transcode load.
 */
function applyCalculatedBitrates(renditions, sourceVideo) {
  const native = renditions[NATIVE_ABR_RENDITION_INDEX];
  if (!native) return renditions;

  const sourceSampleAspectRatio = parseAspectRatio(sourceVideo?.sampleAspectRatio) || 1;
  const nativeDisplayPixels = Math.max(1, Number(native.width) * Number(native.height) * sourceSampleAspectRatio);
  const probedSourceBitrate = Number(sourceVideo?.bitRate);
  const fallbackNativeBitrate = nativeDisplayPixels
    * boundedFps(sourceVideo?.fps)
    * FALLBACK_BITS_PER_DISPLAY_PIXEL_FRAME;
  const nativeBounds = bitrateBounds(native, true);
  const nativeBitrate = clamp(
    Number.isFinite(probedSourceBitrate) && probedSourceBitrate > 0 ? probedSourceBitrate : fallbackNativeBitrate,
    nativeBounds.minimum,
    nativeBounds.maximum
  );

  return renditions.map((rendition, index) => {
    const isNative = index === NATIVE_ABR_RENDITION_INDEX;
    const displayPixels = Math.max(1, Number(rendition.width) * Number(rendition.height));
    const scaledBitrate = isNative
      ? nativeBitrate
      : nativeBitrate * ((displayPixels / nativeDisplayPixels) ** BITRATE_SCALE_EXPONENT);
    const bounds = bitrateBounds(rendition, isNative);
    const targetBitrate = Math.round(clamp(scaledBitrate, bounds.minimum, bounds.maximum) / 1_000) * 1_000;
    const maxRate = Math.round((targetBitrate * 1.07) / 1_000) * 1_000;
    const bufferSize = Math.round((targetBitrate * 1.5) / 1_000) * 1_000;
    return {
      ...rendition,
      videoBitrate: formatBitrate(targetBitrate),
      maxRate: formatBitrate(maxRate),
      bufferSize: formatBitrate(bufferSize),
      averageBandwidth: targetBitrate,
      bandwidth: maxRate
    };
  });
}

/**
 * Builds the native-resolution ABR rung and marks whether it can be copied.
 *
 * `width` and `height` intentionally remain the source's coded dimensions.
 * Its source SAR is preserved by source copy or by the encoder filter in
 * hls_recorder.js, allowing a non-square-pixel source to retain its DAR.
 */
function topRenditionForSource(sourceVideo) {
  const width = Number(sourceVideo?.width);
  const height = Number(sourceVideo?.height);
  const isH264 = String(sourceVideo?.codec || "").toLowerCase() === "h264";
  const profile = String(sourceVideo?.profile || "").toLowerCase();
  // The ABR encoder produces Constrained Baseline H.264. Copy only an H.264
  // Baseline source: copying Main/High into the same ladder would make
  // rendition switches codec-incompatible, even if each rung plays alone.
  const isAbrCopyCompatible = isH264 && profile.includes("baseline");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;

  return {
    id: `${height}p`,
    playlist: "v1/index.m3u8",
    width,
    height,
    videoBitrate: null,
    maxRate: null,
    bufferSize: null,
    averageBandwidth: null,
    bandwidth: null,
    // The copied source may use a profile/level different from the encoded
    // defaults, so omit CODECS rather than advertising an incorrect value.
    codecs: isAbrCopyCompatible ? null : "avc1.42e02a,wvtt",
    sourceCopy: isAbrCopyCompatible
  };
}

/** Selects the fixed Low rung plus a source-native High rung from ffprobe data. */
export function resolveHlsRenditions(sourceVideo) {
  const sourceTop = topRenditionForSource(sourceVideo);
  if (!sourceTop) {
    throw new Error("ABR requires valid ffprobe video width and height for the native High rendition");
  }

  return {
    renditions: applyCalculatedBitrates([...HLS_RENDITIONS, sourceTop], sourceVideo),
    copyNativeTopRung: sourceTop.sourceCopy
  };
}

/** Serializes an ABR HLS master playlist, optionally with the KLV WebVTT subtitle group. */
export function createHlsMasterPlaylist(renditions, { includeSubtitles = true } = {}) {
  if (!Array.isArray(renditions) || renditions.length !== 2) {
    throw new Error("ABR master playlist requires the Low and ffprobe-derived High renditions");
  }
  const subtitleGroup = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="KLV",AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,URI="subtitles.m3u8"';
  const variants = [...renditions]
    .sort((a, b) => a.bandwidth - b.bandwidth)
    .flatMap((rendition) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth}${rendition.codecs ? `,CODECS="${rendition.codecs}"` : ""},RESOLUTION=${rendition.width}x${rendition.height}${includeSubtitles ? ',SUBTITLES="subs"' : ''},CLOSED-CAPTIONS=NONE`,
    rendition.playlist
    ]);

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...(includeSubtitles ? [subtitleGroup] : []),
    ...variants,
    ""
  ].join("\n");
}

/** Serializes the one-rendition master playlist used by HLS passthrough. */
export function createPassthroughHlsMasterPlaylist({ includeSubtitles = true } = {}) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    ...(includeSubtitles ? ['#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="KLV",AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,URI="subtitles.m3u8"'] : []),
    `#EXT-X-STREAM-INF:BANDWIDTH=10000000${includeSubtitles ? ',SUBTITLES="subs"' : ''},CLOSED-CAPTIONS=NONE`,
    "v0/index.m3u8",
    ""
  ].join("\n");
}
