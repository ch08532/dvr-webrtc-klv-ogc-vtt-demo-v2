import fs from "node:fs";
import path from "node:path";

function isWithinDirectory(filePath, directory) {
  return filePath === directory || filePath.startsWith(`${directory}${path.sep}`);
}

/**
 * Finds the playable end of a browser HLS playlist from completed media files.
 *
 * FFmpeg publishes a segment before it lists that segment in the playlist, but
 * checking both artifacts keeps this value safe while playlists are replaced
 * atomically. The returned duration is therefore an availability boundary, not
 * FFmpeg's more optimistic input-processing progress.
 */
export function readCompletedHlsPlaylistAvailability({ outDir, playlistName = "v0/index.m3u8" }) {
  const outputDirectory = path.resolve(outDir);
  const playlistPath = path.resolve(outputDirectory, playlistName);
  if (!isWithinDirectory(playlistPath, outputDirectory)) {
    return { endSeconds: 0, segmentCount: 0 };
  }

  let text;
  try {
    text = fs.readFileSync(playlistPath, "utf8");
  } catch {
    return { endSeconds: 0, segmentCount: 0 };
  }

  let pendingDuration = null;
  let endSeconds = 0;
  let segmentCount = 0;
  const playlistDirectory = path.dirname(playlistPath);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const duration = Number(line.slice("#EXTINF:".length).split(",")[0].trim());
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pendingDuration == null) continue;

    // HLS URIs emitted here are relative filesystem names. Strip an optional
    // cache query before resolving, then reject any path outside this source.
    const segmentUri = line.split(/[?#]/, 1)[0];
    const segmentPath = path.resolve(playlistDirectory, segmentUri);
    if (!isWithinDirectory(segmentPath, outputDirectory)) break;
    try {
      const stats = fs.statSync(segmentPath);
      if (!stats.isFile() || stats.size <= 0) break;
    } catch {
      break;
    }
    endSeconds += pendingDuration;
    segmentCount += 1;
    pendingDuration = null;
  }

  return {
    endSeconds: Number(endSeconds.toFixed(3)),
    segmentCount
  };
}
