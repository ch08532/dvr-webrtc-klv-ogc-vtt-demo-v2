/** Defines the HLS rendition ladder and creates matching master playlists. */

// This order is part of the HLS recorder contract: the native/source rung is
// v1, while v0 and v2 are fixed, square-pixel playback renditions.
export const NATIVE_ABR_RENDITION_INDEX = 1;

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
  },
  {
    id: "1080p",
    playlist: "v1/index.m3u8",
    width: 1920,
    height: 1080,
    videoBitrate: "6000k",
    maxRate: "6420k",
    bufferSize: "9000k",
    averageBandwidth: 6000000,
    bandwidth: 6420000,
    codecs: "avc1.42e02a,wvtt"
  },
  {
    id: "90p",
    playlist: "v2/index.m3u8",
    width: 160,
    height: 90,
    videoBitrate: "100k",
    maxRate: "120k",
    bufferSize: "150k",
    averageBandwidth: 100000,
    bandwidth: 120000,
    codecs: "avc1.42e02a,wvtt"
  }
];

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

  const is720pOrLower = height <= 720;
  return {
    id: `${height}p`,
    playlist: "v1/index.m3u8",
    width,
    height,
    videoBitrate: is720pOrLower ? "3000k" : "6000k",
    maxRate: is720pOrLower ? "3210k" : "6420k",
    bufferSize: is720pOrLower ? "4500k" : "9000k",
    averageBandwidth: is720pOrLower ? 3000000 : 6000000,
    bandwidth: is720pOrLower ? 3210000 : 6420000,
    // The copied source may use a profile/level different from the encoded
    // defaults, so omit CODECS rather than advertising an incorrect value.
    codecs: isAbrCopyCompatible ? null : "avc1.42e02a,wvtt",
    sourceCopy: isAbrCopyCompatible
  };
}

/** Selects the fixed ladder plus a source-native top rung when dimensions exist. */
export function resolveHlsRenditions(sourceVideo) {
  const sourceTop = topRenditionForSource(sourceVideo);
  if (!sourceTop) {
    return {
      renditions: HLS_RENDITIONS,
      copyNativeTopRung: false
    };
  }

  return {
    renditions: HLS_RENDITIONS.map((rendition, index) => (
      index === NATIVE_ABR_RENDITION_INDEX ? sourceTop : rendition
    )),
    copyNativeTopRung: sourceTop.sourceCopy
  };
}

/** Serializes an ABR HLS master playlist with the KLV WebVTT subtitle group. */
export function createHlsMasterPlaylist(renditions = HLS_RENDITIONS) {
  const subtitleGroup = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="KLV",AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,URI="subtitles.m3u8"';
  const variants = [...renditions]
    .sort((a, b) => a.bandwidth - b.bandwidth)
    .flatMap((rendition) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth}${rendition.codecs ? `,CODECS="${rendition.codecs}"` : ""},RESOLUTION=${rendition.width}x${rendition.height},SUBTITLES="subs",CLOSED-CAPTIONS=NONE`,
    rendition.playlist
    ]);

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    subtitleGroup,
    ...variants,
    ""
  ].join("\n");
}

/** Serializes the one-rendition master playlist used by HLS passthrough. */
export function createPassthroughHlsMasterPlaylist() {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="KLV",AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,URI="subtitles.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=10000000,SUBTITLES="subs",CLOSED-CAPTIONS=NONE',
    "v0/index.m3u8",
    ""
  ].join("\n");
}
