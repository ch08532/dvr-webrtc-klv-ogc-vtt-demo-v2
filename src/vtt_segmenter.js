import fs from "node:fs";
import path from "node:path";

function pad(n, w) { return String(n).padStart(w, "0"); }

function vttTime(seconds) {
  const s = Math.max(0, seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${pad(hh,2)}:${pad(mm,2)}:${pad(ss,2)}.${pad(ms,3)}`;
}

function safeJson(obj) { return JSON.stringify(obj); }

function iso(ms) { return new Date(ms).toISOString(); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * Segmented WebVTT writer designed for DVR:
 * - Writes meta_<segNo>.vtt (segNo = floor(unixMs / segMs)) so filenames are stable.
 * - Maintains subtitles.m3u8 sliding window aligned to the VIDEO playlist window.
 * - Handles variable-rate metadata (e.g., 1–10 Hz) via:
 *   - per-second throttle (maxCuesPerSecond)
 *   - adaptive cue duration based on inter-sample dt
 * - "Closes" segments once they are behind the current live edge to avoid rewriting old files.
 */
export class SegmentedVttWriter {
  constructor({
    outDir,
    segmentSeconds = 5,
    subtitlePlaylistName = "subtitles.m3u8",
    filePrefix = "meta_",
    maxExtraSegments = 3,

    // Variable-rate tuning
    maxCuesPerSecond = 10,
    minCueDurSec = 0.10,
    maxCueDurSec = 0.50
  }) {
    if (segmentSeconds <= 0) throw new Error("segmentSeconds must be > 0");
    this.outDir = outDir;
    this.segSec = Number(segmentSeconds);
    this.segMs = Math.round(this.segSec * 1000);

    this.subtitlePlaylistPath = path.join(outDir, subtitlePlaylistName);
    this.filePrefix = filePrefix;
    this.maxExtraSegments = Number(maxExtraSegments);

    this.maxCuesPerSecond = Number(maxCuesPerSecond);
    this.minCueDurSec = Number(minCueDurSec);
    this.maxCueDurSec = Number(maxCueDurSec);

    this._segments = new Map(); // segNo -> { cues: string[], dirty: bool }
    this._window = null;        // { firstSegNo, lastSegNo } inclusive

    // throttling + adaptive duration
    this._lastKlvMs = null;
    this._lastCueSecond = null;
    this._cueCountThisSecond = 0;

    // segment lifecycle
    this._closed = new Set();   // segNo that will not be rewritten once written
    this._flushTimer = null;
  }

  setWindow(windowStartMs, windowEndMs) {
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return;

    const startMs = Math.floor(windowStartMs / this.segMs) * this.segMs;
    const endMs = Math.ceil(windowEndMs / this.segMs) * this.segMs;

    const firstSegNo = Math.floor(startMs / this.segMs);
    const lastSegNo = Math.floor((endMs - 1) / this.segMs);

    const prev = this._window;
    this._window = { firstSegNo, lastSegNo };

    // Close segments strictly behind the live edge
    for (const segNo of this._segments.keys()) {
      if (segNo < lastSegNo) this._closed.add(segNo);
    }

    // Drop segments outside window (and delete their files)
    for (const segNo of this._segments.keys()) {
      if (segNo < firstSegNo || segNo > lastSegNo) {
        this._segments.delete(segNo);
        this._closed.delete(segNo);
        const p = this._segPath(segNo);
        try { fs.unlinkSync(p); } catch {}
      }
    }

    if (!prev || prev.firstSegNo !== firstSegNo || prev.lastSegNo !== lastSegNo) {
      this._writeSubtitlePlaylist();
    }
  }

  addKlv({ klvUnixMs, payload }) {
    if (!Number.isFinite(klvUnixMs)) return;

    // Per-second throttle (keeps VTT lightweight while DB remains full-rate)
    const sec = Math.floor(klvUnixMs / 1000);
    if (this._lastCueSecond !== sec) {
      this._lastCueSecond = sec;
      this._cueCountThisSecond = 0;
    }
    if (this._cueCountThisSecond >= this.maxCuesPerSecond) return;
    this._cueCountThisSecond++;

    const segNo = Math.floor(klvUnixMs / this.segMs);
    const segStartMs = segNo * this.segMs;

    // If we know the video window, ignore samples far outside it
    if (this._window) {
      const { firstSegNo, lastSegNo } = this._window;
      if (segNo < firstSegNo - this.maxExtraSegments) return;
      if (segNo > lastSegNo + this.maxExtraSegments) return;
    }

    // Adaptive cue duration based on inter-sample dt
    let dtSec = 0.1;
    if (this._lastKlvMs != null) {
      dtSec = Math.max(0.01, (klvUnixMs - this._lastKlvMs) / 1000);
    }
    this._lastKlvMs = klvUnixMs;

    const cueStartSec = (klvUnixMs - segStartMs) / 1000;
    const cueDur = clamp(dtSec * 1.2, this.minCueDurSec, this.maxCueDurSec);
    const cueEndSec = Math.min(this.segSec, cueStartSec + cueDur);

    // Lean subset for VTT (tune as needed)
    const lean = {
      timestampIso: payload.timestampIso,
      ingestTimestampIso: payload.ingestTimestampIso,
      ingestTimestampUnixMicros: payload.ingestTimestampUnixMicros,
      sensorLat: payload.sensorLat,
      sensorLon: payload.sensorLon,
      frameCenterLat: payload.frameCenterLat,
      frameCenterLon: payload.frameCenterLon,
      frameCorner1Lat: payload.frameCorner1Lat,
      frameCorner1Lon: payload.frameCorner1Lon,
      frameCorner2Lat: payload.frameCorner2Lat,
      frameCorner2Lon: payload.frameCorner2Lon,
      frameCorner3Lat: payload.frameCorner3Lat,
      frameCorner3Lon: payload.frameCorner3Lon,
      frameCorner4Lat: payload.frameCorner4Lat,
      frameCorner4Lon: payload.frameCorner4Lon,
      frameCornerSource: payload.frameCornerSource,
      sensorAltMslM: payload.sensorAltMslM,
      platformHeadingDeg: payload.platformHeadingDeg,
      platformPitchDeg: payload.platformPitchDeg,
      platformRollDeg: payload.platformRollDeg,
      sensorRelAzDeg: payload.sensorRelAzDeg,
      sensorRelElDeg: payload.sensorRelElDeg,
      sensorHfovDeg: payload.sensorHfovDeg,
      sensorVfovDeg: payload.sensorVfovDeg,
      slantRangeM: payload.slantRangeM
    };

    const cue =
      `${vttTime(cueStartSec)} --> ${vttTime(cueEndSec)}\n` +
      `${safeJson(lean)}\n\n`;

    let seg = this._segments.get(segNo);
    if (!seg) {
      seg = { cues: [], dirty: false };
      this._segments.set(segNo, seg);
    }
    seg.cues.push(cue);
    seg.dirty = true;

    this._scheduleFlush();
  }

  async flushNow() {
    for (const [segNo, seg] of this._segments.entries()) {
      if (!seg.dirty) continue;

      const filePath = this._segPath(segNo);

      // Closed segments are written once; after that avoid rewriting
      if (this._closed.has(segNo) && fs.existsSync(filePath)) {
        seg.dirty = false;
        // Free in-memory closed segments; file content is already persisted.
        this._segments.delete(segNo);
        this._closed.delete(segNo);
        continue;
      }

      seg.dirty = false;

      let content = "WEBVTT\n\n";
      for (const c of seg.cues) content += c;
      fs.writeFileSync(filePath, content);

      if (this._closed.has(segNo)) {
        // Once a closed segment is written, keep only the on-disk file.
        this._segments.delete(segNo);
        this._closed.delete(segNo);
      }
    }

    this._writeSubtitlePlaylist();
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flushNow().catch(() => {});
    }, 200);
  }

  _segFilename(segNo) { return `${this.filePrefix}${segNo}.vtt`; }
  _segPath(segNo) { return path.join(this.outDir, this._segFilename(segNo)); }

  _writeSubtitlePlaylist() {
    const w = this._window;
    if (!w) return;

    const { firstSegNo, lastSegNo } = w;
    const target = Math.ceil(this.segSec);

    let txt = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:${target}
#EXT-X-MEDIA-SEQUENCE:${firstSegNo}
`;

    for (let segNo = firstSegNo; segNo <= lastSegNo; segNo++) {
      const segPath = this._segPath(segNo);
      if (!fs.existsSync(segPath)) {
        fs.writeFileSync(segPath, "WEBVTT\n\n");
      }
      const segStartMs = segNo * this.segMs;
      txt += `#EXT-X-PROGRAM-DATE-TIME:${iso(segStartMs)}\n`;
      txt += `#EXTINF:${this.segSec.toFixed(3)},\n`;
      txt += `${this._segFilename(segNo)}\n`;
    }

    fs.writeFileSync(this.subtitlePlaylistPath, txt);
  }
}
