export function parseTsHeader(pkt) {
  if (pkt.length !== 188 || pkt[0] !== 0x47) return null;

  const tei = (pkt[1] & 0x80) !== 0;
  const pusi = (pkt[1] & 0x40) !== 0;
  const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
  const afc = (pkt[3] >> 4) & 0x03;

  let off = 4;
  if (afc === 2 || afc === 3) {
    const afl = pkt[off];
    off += 1 + afl;
  }

  const hasPayload = afc === 1 || afc === 3;
  const payload = (!hasPayload || off > 188) ? Buffer.alloc(0) : pkt.subarray(off);
  return { tei, pusi, pid, payload };
}

export function parsePat(payload) {
  if (payload.length < 1) return null;
  let off = 0;
  const pointer = payload[off]; off += 1 + pointer;
  if (off + 8 > payload.length) return null;
  if (payload[off] !== 0x00) return null;

  const sectionLen = ((payload[off + 1] & 0x0f) << 8) | payload[off + 2];
  const sectionEnd = off + 3 + sectionLen;
  if (sectionEnd > payload.length) return null;

  let p = off + 8;
  const programs = [];
  while (p + 4 <= sectionEnd - 4) {
    const programNumber = (payload[p] << 8) | payload[p + 1];
    const pmtPid = ((payload[p + 2] & 0x1f) << 8) | payload[p + 3];
    p += 4;
    if (programNumber !== 0) programs.push({ programNumber, pmtPid });
  }
  return programs;
}

export function parsePmt(payload) {
  if (payload.length < 1) return null;
  let off = 0;
  const pointer = payload[off]; off += 1 + pointer;
  if (off + 12 > payload.length) return null;
  if (payload[off] !== 0x02) return null;

  const sectionLen = ((payload[off + 1] & 0x0f) << 8) | payload[off + 2];
  const sectionEnd = off + 3 + sectionLen;
  if (sectionEnd > payload.length) return null;

  const programInfoLen = ((payload[off + 10] & 0x0f) << 8) | payload[off + 11];
  let p = off + 12 + programInfoLen;

  const streams = [];
  while (p + 5 <= sectionEnd - 4) {
    const streamType = payload[p];
    const pid = ((payload[p + 1] & 0x1f) << 8) | payload[p + 2];
    const esInfoLen = ((payload[p + 3] & 0x0f) << 8) | payload[p + 4];
    const esInfo = payload.subarray(p + 5, p + 5 + esInfoLen);
    streams.push({ streamType, pid, esInfo });
    p += 5 + esInfoLen;
  }
  return streams;
}

export function hasKlvaRegistration(esInfo) {
  let i = 0;
  while (i + 2 <= esInfo.length) {
    const tag = esInfo[i];
    const len = esInfo[i + 1];
    const d0 = i + 2;
    const d1 = d0 + len;
    if (d1 > esInfo.length) break;
    if (tag === 0x05 && len >= 4) {
      const ident = esInfo.subarray(d0, d0 + 4).toString("ascii");
      if (ident === "KLVA" || ident === "KLV ") return true;
    }
    i = d1;
  }
  return false;
}

export function chooseKlvPidFromPmt(streams) {
  const candidates = streams.filter(s => s.streamType === 0x06);
  const klva = candidates.find(s => hasKlvaRegistration(s.esInfo));
  return (klva ?? candidates[0])?.pid ?? null;
}
