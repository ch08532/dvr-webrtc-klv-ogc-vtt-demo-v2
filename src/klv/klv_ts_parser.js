import fs from "node:fs";
import dgram from "node:dgram";
import { Transform } from "node:stream";
import { PassThrough } from "node:stream";
import { decodeSt0601LocalSet } from "./st0601.js";
import { parseTsHeader, parsePat, parsePmt, chooseKlvPidFromPmt } from "./ts_psi.js";
import { createServiceLogger, serializeError } from "../service_logger.js";

const log = createServiceLogger("klv_ts_parser");

const ST0601_KEY = Buffer.from([
  0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01,
  0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00,
]);

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

class TsPacketizer extends Transform {
  constructor() { super({ readableObjectMode: true }); this._buf = Buffer.alloc(0); }
  _transform(chunk, _enc, cb) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 188) {
      this.push(this._buf.subarray(0, 188));
      this._buf = this._buf.subarray(188);
    }
    cb();
  }
}

function isIpv4Multicast(address) {
  const first = Number(address.split(".")[0]);
  return Number.isInteger(first) && first >= 224 && first <= 239;
}

function openInput(inputUrl) {
  if (inputUrl.startsWith("udp://")) {
    const m = inputUrl.match(/^udp:\/\/([^:]+):(\d+)$/);
    if (!m) throw new Error("UDP URL must be udp://host:port");

    const address = m[1];
    const port = Number(m[2]);
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const out = new PassThrough();

    sock.on("message", (msg) => {
      out.write(msg);
    });

    sock.on("error", (error) => {
      out.destroy(error);
    });

    sock.on("close", () => {
      out.end();
    });

    sock.bind(port, isIpv4Multicast(address) ? "0.0.0.0" : address, () => {
      if (isIpv4Multicast(address)) {
        try {
          sock.addMembership(address);
        } catch (error) {
          out.destroy(error);
        }
      }
    });

    const destroy = out.destroy.bind(out);
    out.destroy = (error) => {
      try { sock.close(); } catch {}
      return destroy(error);
    };

    return out;
  }
  return fs.createReadStream(inputUrl);
}

function scanForSt0601(buf, onDecoded) {
  let idx = 0;
  while (true) {
    idx = buf.indexOf(ST0601_KEY, idx);
    if (idx === -1) return;

    const lenInfo = berReadLength(buf, idx + 16);
    if (!lenInfo) return;

    const v0 = idx + 16 + lenInfo.bytes;
    const v1 = v0 + lenInfo.length;
    if (v1 > buf.length) return;

    const value = buf.subarray(v0, v1);
    const decoded = decodeSt0601LocalSet(value);
    if (Object.keys(decoded).length) onDecoded(decoded);

    idx = v1;
  }
}

export async function startKlvIngest({ streamId, inputUrl, onDecoded, requestId }) {
  log.info("start", { requestId, streamId, inputUrl });
  const input = openInput(inputUrl);
  const packetizer = new TsPacketizer();

  let pmtPid = null;
  let klvPids = null;

  const rolling = new Map();
  const KEEP = 256 * 1024;

  function append(pid, payload) {
    const prev = rolling.get(pid) ?? Buffer.alloc(0);
    let buf = Buffer.concat([prev, payload]);
    if (buf.length > KEEP) buf = buf.subarray(buf.length - KEEP);
    rolling.set(pid, buf);
    return buf;
  }

  input.pipe(packetizer);

  packetizer.on("data", (pkt) => {
    const h = parseTsHeader(pkt);
    if (!h || h.tei) return;

    if (h.pid === 0x0000 && h.pusi) {
      const progs = parsePat(h.payload);
      if (progs?.length) pmtPid = progs[0].pmtPid;
      if (progs?.length) log.debug("pat_detected", { requestId, streamId, pmtPid });
      return;
    }

    if (pmtPid != null && h.pid === pmtPid && h.pusi) {
      const streams = parsePmt(h.payload);
      if (streams) {
        const preferred = chooseKlvPidFromPmt(streams);
        const allCandidates = streams
          .filter((s) => s.streamType === 0x06)
          .map((s) => s.pid);
        if (preferred != null) {
          klvPids = new Set([preferred, ...allCandidates]);
        } else if (allCandidates.length) {
          klvPids = new Set(allCandidates);
        }
      }
      if (streams) {
        log.debug("pmt_detected", {
          requestId,
          streamId,
          pmtPid,
          klvPids: klvPids ? [...klvPids] : null
        });
      }
      return;
    }

    if (!h.payload?.length) return;

    if (klvPids?.size) {
      if (!klvPids.has(h.pid)) return;
      const buf = append(h.pid, h.payload);
      scanForSt0601(buf, onDecoded);
    } else {
      const buf = append(h.pid, h.payload);
      scanForSt0601(buf, onDecoded);
      if (rolling.size > 64) rolling.clear();
    }
  });

  input.on("error", (error) => {
    log.error("input_error", { requestId, streamId, error: serializeError(error) });
  });

  packetizer.on("error", (error) => {
    log.error("packetizer_error", { requestId, streamId, error: serializeError(error) });
  });

  return { streamId, inputUrl, input, packetizer, requestId };
}

export async function stopKlvIngest(handle) {
  log.info("stop_requested", { requestId: handle?.requestId, streamId: handle?.streamId });
  try { handle?.input?.destroy(); } catch {}
  try { handle?.packetizer?.destroy(); } catch {}
}
