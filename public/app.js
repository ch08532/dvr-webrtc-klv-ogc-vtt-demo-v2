/* globals Hls, mediasoupClient */
const statusEl = document.getElementById("status");
const overlayText = document.getElementById("overlayText");
const video = document.getElementById("video");

const streamIdEl = document.getElementById("streamId");
const inputUrlEl = document.getElementById("inputUrl");
const modeEl = document.getElementById("mode");
const dvrSecondsEl = document.getElementById("dvrSeconds");
const vttSegmentSecondsEl = document.getElementById("vttSegmentSeconds");
const maxCuesPerSecondEl = document.getElementById("maxCuesPerSecond");
const minCueDurSecEl = document.getElementById("minCueDurSec");
const maxCueDurSecEl = document.getElementById("maxCueDurSec");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");

const tabLive = document.getElementById("tabLive");
const tabDvr = document.getElementById("tabDvr");
const tabLiveKlv = document.getElementById("tabLiveKlv");

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let ws = null;
let hls = null;
let live = { device: null, transport: null, consumer: null };
let vttHooked = false;

function logStatus(obj) {
  statusEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}
function showOverlay(obj) {
  overlayText.textContent = JSON.stringify(obj, null, 2);
}
async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ---------- WS (LIVE only) ----------
function connectWs() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => subscribeWs();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "st0601") showOverlay({ mode: "live-ws", ...msg });
  };
}
function subscribeWs() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "subscribe", streamId: streamIdEl.value.trim(), mode: "live" }));
}
tabLiveKlv.onclick = () => { connectWs(); subscribeWs(); };

// ---------- DVR (HLS + segmented VTT) ----------
function attachHlsDvr(streamId) {
  const url = `/hls/${encodeURIComponent(streamId)}/master.m3u8`;

  vttHooked = false;

  if (hls) { hls.destroy(); hls = null; }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.srcObject = null;
    video.src = url;
    video.play().catch(()=>{});
    hookVttOverlaySoon();
    return;
  }

  hls = new Hls({ lowLatencyMode: true, backBufferLength: 90 });
  hls.attachMedia(video);

  hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
  hls.on(Hls.Events.ERROR, () => {});

  video.srcObject = null;
  video.play().catch(()=>{});
  hookVttOverlaySoon();
}

function hookVttOverlaySoon() {
  // The text track may appear a bit after playback starts.
  const tries = 12;
  let n = 0;

  const t = setInterval(() => {
    n++;
    if (tryHookVttTrack()) {
      clearInterval(t);
    } else if (n >= tries) {
      clearInterval(t);
    }
  }, 400);
}

function tryHookVttTrack() {
  if (vttHooked) return true;

  const tracks = video.textTracks;
  if (!tracks || !tracks.length) return false;

  let metaTrack = null;
  for (let i = 0; i < tracks.length; i++) {
    // our master playlist gives NAME="KLV"
    if (tracks[i].label === "KLV" || tracks[i].language === "en") {
      metaTrack = tracks[i];
      break;
    }
  }
  if (!metaTrack) return false;

  metaTrack.mode = "hidden"; // don't render captions, we consume cues
  metaTrack.oncuechange = () => {
    const cues = metaTrack.activeCues;
    if (!cues || !cues.length) return;
    const cue = cues[cues.length - 1];
    try {
      const obj = JSON.parse(cue.text);
      showOverlay({ mode: "dvr-vtt", ...obj });
    } catch {
      showOverlay({ mode: "dvr-vtt", raw: cue.text });
    }
  };

  vttHooked = true;
  return true;
}

// ---------- Live WebRTC (mediasoup consume) ----------
async function startLive(streamId) {
  await stopLive();

  const routerCaps = await api("/webrtc/rtpCapabilities");

  // mediasoupClient must be available as a global from the CDN
  const device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: routerCaps });

  const t = await api("/webrtc/createTransport", { method: "POST" });

  const transport = device.createRecvTransport({
    id: t.transportId,
    iceParameters: t.iceParameters,
    iceCandidates: t.iceCandidates,
    dtlsParameters: t.dtlsParameters
  });

  transport.on("connect", async ({ dtlsParameters }, cb, eb) => {
    try {
      await api("/webrtc/connectTransport", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transportId: t.transportId, dtlsParameters })
      });
      cb();
    } catch (e) { eb(e); }
  });

  const c = await api("/webrtc/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId, transportId: t.transportId, rtpCapabilities: device.rtpCapabilities })
  });

  const consumer = await transport.consume({
    id: c.consumerId,
    producerId: c.producerId || "ignored",
    kind: c.kind,
    rtpParameters: c.rtpParameters
  });

  const ms = new MediaStream();
  ms.addTrack(consumer.track);
  video.srcObject = ms;
  await video.play().catch(()=>{});

  live = { device, transport, consumer };
}

async function stopLive() {
  if (hls) { hls.destroy(); hls = null; }
  try { live.consumer?.close(); } catch {}
  try { live.transport?.close(); } catch {}
  live = { device: null, transport: null, consumer: null };

  video.srcObject = null;
  video.removeAttribute("src");
  video.load();
}

// ---------- UI ----------
startBtn.onclick = async () => {
  const streamId = streamIdEl.value.trim();
  const inputUrl = inputUrlEl.value.trim();
  const mode = modeEl.value;
  const dvrSeconds = Number(dvrSecondsEl.value);
  const vttSegmentSeconds = Number(vttSegmentSecondsEl.value);
  const maxCuesPerSecond = Number(maxCuesPerSecondEl.value);
  const minCueDurSec = Number(minCueDurSecEl.value);
  const maxCueDurSec = Number(maxCueDurSecEl.value);

  const result = await api("/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streamId, inputUrl, mode, dvrSeconds, vttSegmentSeconds, maxCuesPerSecond, minCueDurSec, maxCueDurSec })
  });
  logStatus(result);
};

stopBtn.onclick = async () => {
  const streamId = streamIdEl.value.trim();
  const result = await api(`/sources/${encodeURIComponent(streamId)}`, { method: "DELETE" });
  logStatus(result);
  await stopLive();
};

refreshBtn.onclick = async () => logStatus(await api("/sources"));

tabLive.onclick = async () => {
  tabLive.classList.add("active");
  tabDvr.classList.remove("active");
  await startLive(streamIdEl.value.trim());
};

tabDvr.onclick = async () => {
  tabDvr.classList.add("active");
  tabLive.classList.remove("active");
  await stopLive();
  attachHlsDvr(streamIdEl.value.trim());
};

logStatus("Ready. Start Source, then choose Live or DVR. DVR overlay is from segmented WebVTT.");
