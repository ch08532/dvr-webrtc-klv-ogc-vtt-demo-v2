import fs from "node:fs";

export function readHlsPdtWindowMs(videoPlaylistPath) {
  try {
    const txt = fs.readFileSync(videoPlaylistPath, "utf8");
    const matches = [...txt.matchAll(/#EXT-X-PROGRAM-DATE-TIME:\s*([^\r\n]+)/g)];
    if (!matches.length) return null;

    const first = Date.parse(matches[0][1].trim());
    const last = Date.parse(matches[matches.length - 1][1].trim());
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

    // video segments are 1s in this recorder -> add 1s to cover last segment
    return { firstMs: first, lastMs: last + 1000 };
  } catch {
    return null;
  }
}
