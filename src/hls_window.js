import fs from "node:fs";

export function readHlsPdtWindowMs(videoPlaylistPath) {
  try {
    const txt = fs.readFileSync(videoPlaylistPath, "utf8");
    const matches = [...txt.matchAll(/#EXT-X-PROGRAM-DATE-TIME:\s*([^\r\n]+)/g)];
    if (!matches.length) return null;

    const first = Date.parse(matches[0][1].trim());
    const last = Date.parse(matches[matches.length - 1][1].trim());
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;

    // Approximate live edge coverage using declared target duration when available.
    const tdMatch = txt.match(/#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/);
    const targetDurationSec = tdMatch ? Number(tdMatch[1]) : 1;
    const durationMs = Number.isFinite(targetDurationSec) && targetDurationSec > 0
      ? Math.round(targetDurationSec * 1000)
      : 1000;

    return { firstMs: first, lastMs: last + durationMs };
  } catch {
    return null;
  }
}
