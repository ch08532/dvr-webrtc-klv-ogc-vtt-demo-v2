import '@mantine/core/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AppShell, Text, Tabs, TextInput, NumberInput, Button, Group, Stack, Paper, Badge, Switch, Collapse } from '@mantine/core';
import { Device } from 'mediasoup-client';

const theme = createTheme({
  /** Put your mantine theme override here */
});

function App() {
  const [streamId, setStreamId] = useState('stream1');
  const [inputUrl, setInputUrl] = useState('udp://239.1.2.3:5000');
  const [mode, setMode] = useState('xcode-any');
  const [dvrSeconds, setDvrSeconds] = useState(600);
  const [hlsSegmentSeconds, setHlsSegmentSeconds] = useState(5);
  const [maxCuesPerSecond, setMaxCuesPerSecond] = useState(10);
  const [minCueDurSec, setMinCueDurSec] = useState(0.10);
  const [maxCueDurSec, setMaxCueDurSec] = useState(0.50);
  const [purgeBeforeStart, setPurgeBeforeStart] = useState(true);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [inputProbe, setInputProbe] = useState({
    phase: 'idle',
    available: null,
    indicator: null,
    container: null,
    video: null,
    klv: null,
    error: null,
    testedAt: null
  });
  const [status, setStatus] = useState('Ready. Start Source, then choose Live or DVR. DVR overlay is from segmented WebVTT.');
  const [overlayData, setOverlayData] = useState(null);
  const [activeTab, setActiveTab] = useState('dvr');
  const [autoAttachOnDvr, setAutoAttachOnDvr] = useState(false);
  const [hlsMediaLoaded, setHlsMediaLoaded] = useState(false);
  const [liveStatus, setLiveStatus] = useState('Idle');
  const [webrtcDiag, setWebrtcDiag] = useState({
    consumerId: null,
    producerScore: null,
    consumerScore: null,
    currentLayers: null,
    error: null
  });
  const [startRequestInFlight, setStartRequestInFlight] = useState(false);
  const [stopRequestInFlight, setStopRequestInFlight] = useState(false);
  const [streamRuntime, setStreamRuntime] = useState({ streamId: 'stream1', state: 'stopped', running: false, lastError: null });
  const [sourcesList, setSourcesList] = useState([]);

  const videoRef = useRef(null);
  const liveVideoRef = useRef(null);
  const wsRef = useRef(null);
  const vttHookedRef = useRef(false);
  const hlsRetryTimerRef = useRef(null);
  const hlsRetryTokenRef = useRef(0);
  const webrtcRetryTimerRef = useRef(null);
  const webrtcRetryTokenRef = useRef(0);
  const webrtcTransportRef = useRef(null);
  const webrtcConsumerRef = useRef(null);
  const webrtcMediaStreamRef = useRef(null);
  const webrtcStreamIdRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const streamRuntimeRef = useRef(streamRuntime);

  const api = async (url, opts) => {
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
  };

  const stateColor = (state) => {
    if (state === 'running') return 'green';
    if (state === 'degraded') return 'orange';
    if (state === 'starting' || state === 'stopping') return 'yellow';
    if (state === 'error') return 'red';
    return 'gray';
  };

  const probeBadgeColor = (() => {
    if (inputProbe.phase === 'testing') return 'yellow';
    if (inputProbe.indicator === 'green') return 'green';
    if (inputProbe.indicator === 'red') return 'red';
    return 'gray';
  })();

  const probeBadgeLabel = (() => {
    if (inputProbe.phase === 'testing') return 'Testing...';
    if (inputProbe.indicator === 'green') return 'Video Found';
    if (inputProbe.indicator === 'red') return 'No Video';
    return 'Not Tested';
  })();

  const isStartBlockedByState = ['starting', 'running', 'degraded', 'stopping'].includes(streamRuntime?.state);
  const isStopBlockedByState = ['stopping', 'stopped'].includes(streamRuntime?.state);
  const canStartSource = !startRequestInFlight && !stopRequestInFlight && !isStartBlockedByState;
  const canStopSource = !startRequestInFlight && !stopRequestInFlight && !isStopBlockedByState;

  const webrtcBadge = (() => {
    if (webrtcDiag.error) return { color: 'red', label: 'Diag Error' };
    if (!webrtcDiag.consumerId) return { color: 'gray', label: 'No Stats' };
    if ((webrtcDiag.producerScore ?? 0) <= 0) return { color: 'red', label: 'No Producer Media' };
    if ((webrtcDiag.consumerScore ?? 0) <= 0) return { color: 'orange', label: 'No Consumer Media' };
    return { color: 'green', label: 'Media Flowing' };
  })();

  const refreshStreamState = async (targetStreamId = streamId) => {
    if (!targetStreamId) return;
    const result = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
    if (result?.streamId) {
      setStreamRuntime(result);
      if (result.running) setAutoAttachOnDvr(true);
      if (!result.running) setAutoAttachOnDvr(false);
    }
  };

  const testInputFeed = async () => {
    const targetUrl = String(inputUrl || '').trim();
    if (!targetUrl) return;

    setInputProbe((prev) => ({
      ...prev,
      phase: 'testing',
      available: null,
      indicator: null,
      container: null,
      video: null,
      klv: null,
      error: null
    }));

    try {
      const result = await api('/probe/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputUrl: targetUrl })
      });

      if (!result?.ok) {
        throw new Error(result?.error || 'Probe failed');
      }

      setInputProbe({
        phase: 'done',
        available: !!result.available,
        indicator: result.indicator || (result.available ? 'green' : 'red'),
        container: result.container || null,
        video: result.video || null,
        klv: result.klv || null,
        error: result.error || null,
        testedAt: result.testedAt || new Date().toISOString()
      });
    } catch (error) {
      setInputProbe({
        phase: 'done',
        available: false,
        indicator: 'red',
        container: null,
        video: null,
        klv: null,
        error: String(error?.message || error),
        testedAt: new Date().toISOString()
      });
    }
  };

  const clearHlsRetryLoop = () => {
    if (hlsRetryTimerRef.current) {
      clearTimeout(hlsRetryTimerRef.current);
      hlsRetryTimerRef.current = null;
    }
  };

  const probeHlsReady = async (targetStreamId) => {
    const root = `/hls/${encodeURIComponent(targetStreamId)}`;
    const token = Date.now();
    const masterUrl = `${root}/master.m3u8?_=${token}`;
    const mediaUrl = `${root}/playlist.m3u8?_=${token}`;
    try {
      const [masterRes, mediaRes] = await Promise.all([
        fetch(masterUrl, { cache: 'no-store' }),
        fetch(mediaUrl, { cache: 'no-store' })
      ]);
      if (!masterRes.ok || !mediaRes.ok) return false;
      const mediaTxt = await mediaRes.text();
      return mediaTxt.includes('#EXTM3U');
    } catch {
      return false;
    }
  };

  const clearWebRtcRetryLoop = () => {
    if (webrtcRetryTimerRef.current) {
      clearTimeout(webrtcRetryTimerRef.current);
      webrtcRetryTimerRef.current = null;
    }
  };

  const cleanupWebRtcPlayback = () => {
    try { webrtcConsumerRef.current?.close?.(); } catch {}
    try { webrtcTransportRef.current?.close?.(); } catch {}
    webrtcConsumerRef.current = null;
    webrtcTransportRef.current = null;
    webrtcMediaStreamRef.current = null;
    webrtcStreamIdRef.current = null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
  };

  const hasActiveWebRtcSession = (targetStreamId) => {
    const transport = webrtcTransportRef.current;
    const consumer = webrtcConsumerRef.current;
    if (!transport || !consumer) return false;
    if (webrtcStreamIdRef.current !== targetStreamId) return false;
    if (transport.closed || consumer.closed) return false;
    if (transport.connectionState && transport.connectionState !== 'connected') return false;
    if (!consumer.track || consumer.track.readyState !== 'live') return false;
    return true;
  };

  const reattachWebRtcStream = () => {
    if (!liveVideoRef.current || !webrtcMediaStreamRef.current) return;
    if (liveVideoRef.current.srcObject !== webrtcMediaStreamRef.current) {
      liveVideoRef.current.srcObject = webrtcMediaStreamRef.current;
    }
    liveVideoRef.current.autoplay = true;
    liveVideoRef.current.muted = true;
    liveVideoRef.current.playsInline = true;
    liveVideoRef.current.play().catch(() => {});
  };

  const startLiveWebRtc = async (targetStreamId) => {
    cleanupWebRtcPlayback();
    setLiveStatus('Connecting...');

    const routerRtpCapabilities = await api('/webrtc/rtpCapabilities');
    if (!routerRtpCapabilities || routerRtpCapabilities.error) {
      throw new Error(routerRtpCapabilities?.error || 'Failed to fetch router RTP capabilities');
    }

    const device = new Device();
    await device.load({ routerRtpCapabilities });

    const transportInfo = await api('/webrtc/createTransport', { method: 'POST' });
    if (!transportInfo?.transportId) {
      throw new Error(transportInfo?.error || 'Failed to create WebRTC transport');
    }

    const recvTransport = device.createRecvTransport({
      id: transportInfo.transportId,
      iceParameters: transportInfo.iceParameters,
      iceCandidates: transportInfo.iceCandidates,
      dtlsParameters: transportInfo.dtlsParameters
    });
    webrtcTransportRef.current = recvTransport;

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      api('/webrtc/connectTransport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transportId: transportInfo.transportId, dtlsParameters })
      })
        .then((res) => {
          if (res?.ok === false) throw new Error(res.error || 'connect transport failed');
          callback();
        })
        .catch((error) => errback(error));
    });

    recvTransport.on('connectionstatechange', (state) => {
      if (state === 'connected') setLiveStatus('Connected (waiting for video)...');
      else if (state === 'failed') {
        setLiveStatus('Connection failed. Reconnecting...');
        setTimeout(() => startWebRtcAutoAttach(targetStreamId), 1000);
      } else if (state === 'disconnected') {
        setLiveStatus('Disconnected. Reconnecting...');
        setTimeout(() => startWebRtcAutoAttach(targetStreamId), 1000);
      }
    });

    const consumeInfo = await api('/webrtc/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streamId: targetStreamId,
        transportId: transportInfo.transportId,
        rtpCapabilities: device.rtpCapabilities
      })
    });

    if (!consumeInfo?.consumerId || !consumeInfo?.producerId) {
      throw new Error(consumeInfo?.error || 'Producer not ready for WebRTC yet');
    }

    const consumer = await recvTransport.consume({
      id: consumeInfo.consumerId,
      producerId: consumeInfo.producerId,
      kind: consumeInfo.kind,
      rtpParameters: consumeInfo.rtpParameters
    });
    webrtcConsumerRef.current = consumer;
    consumer.on('transportclose', () => {
      setLiveStatus('Transport closed. Reconnecting...');
      setTimeout(() => startWebRtcAutoAttach(targetStreamId), 1000);
    });
    consumer.on('producerclose', () => {
      setLiveStatus('Producer closed. Reconnecting...');
      setTimeout(() => startWebRtcAutoAttach(targetStreamId), 1000);
    });
    consumer.track.onended = () => {
      setLiveStatus('Track ended. Reconnecting...');
      setTimeout(() => startWebRtcAutoAttach(targetStreamId), 1000);
    };
    consumer.track.onunmute = () => {
      setLiveStatus('Receiving video...');
    };

    const stream = new MediaStream([consumer.track]);
    webrtcMediaStreamRef.current = stream;
    webrtcStreamIdRef.current = targetStreamId;
    if (liveVideoRef.current) {
      const videoEl = liveVideoRef.current;
      videoEl.srcObject = stream;
      videoEl.autoplay = true;
      videoEl.muted = true;
      videoEl.playsInline = true;

      const playResult = await videoEl.play().catch(() => null);
      if (playResult == null && videoEl.paused) {
        setLiveStatus('Tap video to start playback');
        return;
      }

      await new Promise((resolve, reject) => {
        let done = false;
        let frameCbId = null;
        const finish = (ok, error = null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          videoEl.removeEventListener('playing', onPlaying);
          videoEl.removeEventListener('timeupdate', onTimeUpdate);
          videoEl.removeEventListener('loadeddata', onLoadedData);
          if (frameCbId != null && typeof videoEl.cancelVideoFrameCallback === 'function') {
            try { videoEl.cancelVideoFrameCallback(frameCbId); } catch {}
          }
          if (ok) resolve();
          else reject(error || new Error('No WebRTC video frames received'));
        };

        const onPlaying = () => finish(true);
        const onTimeUpdate = () => {
          if (videoEl.currentTime > 0) finish(true);
        };
        const onLoadedData = () => {
          if (videoEl.readyState >= 2) finish(true);
        };

        const timer = setTimeout(() => {
          finish(false, new Error('WebRTC connected but no video frames yet'));
        }, 8000);

        videoEl.addEventListener('playing', onPlaying);
        videoEl.addEventListener('timeupdate', onTimeUpdate);
        videoEl.addEventListener('loadeddata', onLoadedData);

        if (typeof videoEl.requestVideoFrameCallback === 'function') {
          frameCbId = videoEl.requestVideoFrameCallback(() => finish(true));
        }
      });

      setLiveStatus('Playing');
    }
  };

  const startSource = async () => {
    if (!canStartSource) return;
    setStartRequestInFlight(true);
    setHlsMediaLoaded(false);
    setStreamRuntime({ streamId, state: 'starting', running: false, lastError: null });
    try {
      const result = await api("/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamId,
          inputUrl,
          mode,
          dvrSeconds,
          hlsSegmentSeconds,
          vttSegmentSeconds: hlsSegmentSeconds,
          maxCuesPerSecond,
          minCueDurSec,
          maxCueDurSec,
          purgeBeforeStart
        })
      });
      setStatus(JSON.stringify(result, null, 2));
      if (result?.state?.streamId) setStreamRuntime(result.state);
      await refreshStreamState(streamId);
      await refreshSources({ silent: true });

      if (result?.ok) {
        setAutoAttachOnDvr(true);
      }

      // Start probing for HLS and attach as soon as playlist is available.
      if (result?.ok && activeTab === 'dvr') {
        startHlsAutoAttach(streamId);
      }
      if (result?.ok && activeTab === 'live-webrtc') {
        startWebRtcAutoAttach(streamId);
      }
      if (result?.ok && activeTab === 'live-klv') {
        connectWs();
        subscribeWs();
      }
    } finally {
      setStartRequestInFlight(false);
    }
  };

  const stopSource = async () => {
    if (!canStopSource) return;
    setStopRequestInFlight(true);
    setOverlayData(null);
    disconnectWs();
    setStreamRuntime((prev) => ({ ...prev, streamId, state: 'stopping', running: false, ingestRunning: false }));
    try {
      const result = await api(`/sources/${encodeURIComponent(streamId)}`, { method: "DELETE" });
      setStatus(JSON.stringify(result, null, 2));
      if (result?.state?.streamId) setStreamRuntime(result.state);
      setAutoAttachOnDvr(false);
      clearHlsRetryLoop();
      clearWebRtcRetryLoop();
      if (window.player) {
        window.player.dispose();
        window.player = null;
      }
      setHlsMediaLoaded(false);
      cleanupWebRtcPlayback();
      setLiveStatus('Stopped');
      await refreshStreamState(streamId);
      await refreshSources({ silent: true });
    } finally {
      setStopRequestInFlight(false);
    }
  };

  const refreshSources = async ({ silent = false } = {}) => {
    const result = await api("/sources");
    if (Array.isArray(result)) setSourcesList(result);
    if (!silent) setStatus(JSON.stringify(result, null, 2));
  };

  const refreshWebRtcDebug = async (targetStreamId = streamId) => {
    if (!targetStreamId) return;
    const result = await api('/webrtc/debug');
    if (!result?.ok || !result?.snapshot) {
      setWebrtcDiag((prev) => ({
        ...prev,
        error: result?.error || 'debug unavailable'
      }));
      return;
    }

    const consumers = Array.isArray(result.snapshot.consumers) ? result.snapshot.consumers : [];
    const c = consumers.find((x) => x.streamId === targetStreamId) || null;

    setWebrtcDiag({
      consumerId: c?.consumerId || null,
      producerScore: Number.isFinite(c?.score?.producerScore) ? c.score.producerScore : null,
      consumerScore: Number.isFinite(c?.score?.score) ? c.score.score : null,
      currentLayers: c?.currentLayers ?? null,
      error: null
    });
  };

  const showOverlay = (obj, scopeTab = null) => {
    if (scopeTab && activeTabRef.current !== scopeTab) return;
    setOverlayData(obj);
  };

  const formatOverlayValue = (value) => {
    if (value == null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const parseStatusPayload = (value) => {
    if (value == null) return { entries: [], text: '' };
    if (typeof value === 'object') {
      return { entries: Object.entries(value), text: '' };
    }

    const asText = String(value);
    const trimmed = asText.trim();
    if (!trimmed) return { entries: [], text: '' };

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return { entries: Object.entries(parsed), text: '' };
      }
    } catch {
      // Fallback to plain text status.
    }

    return { entries: [], text: asText };
  };

  const getActiveHlsPlayer = () => {
    if (!window.player || window.player.isDisposed?.()) return null;
    return window.player;
  };

  const hasLoadedHlsMedia = (player) => {
    if (!player || player.isDisposed?.()) return false;
    const readyState = Number(player.readyState?.());
    if (Number.isFinite(readyState) && readyState >= 1) return true;
    const seekable = player.seekable?.();
    return !!seekable && seekable.length > 0;
  };

  const getHlsSeekBounds = (player) => {
    const seekable = player.seekable?.();
    if (seekable && seekable.length > 0) {
      return {
        start: Number(seekable.start(0)),
        end: Number(seekable.end(seekable.length - 1))
      };
    }

    const duration = Number(player.duration?.());
    const current = Number(player.currentTime?.() || 0);
    const fallbackEnd = Number.isFinite(duration) ? duration : Math.max(0, current);
    return { start: 0, end: fallbackEnd };
  };

  const clampToBounds = (value, start, end) => {
    if (!Number.isFinite(value)) return start;
    if (value < start) return start;
    if (value > end) return end;
    return value;
  };

  const seekHlsBySeconds = (deltaSeconds) => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus("HLS player is not ready.");
      return;
    }
    const { start, end } = getHlsSeekBounds(player);
    const current = Number(player.currentTime?.() || start);
    const target = clampToBounds(current + deltaSeconds, start, end);
    player.currentTime(target);
  };

  const seekHlsToStart = () => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus("HLS player is not ready.");
      return;
    }
    const { start } = getHlsSeekBounds(player);
    player.currentTime(start);
  };

  const seekHlsToEnd = () => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus("HLS player is not ready.");
      return;
    }
    const { end } = getHlsSeekBounds(player);
    player.currentTime(end);
  };

  const toggleHlsPlayPause = () => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus("HLS player is not ready.");
      return;
    }
    if (player.paused?.()) {
      player.play().catch(() => {});
    } else {
      player.pause?.();
    }
  };

  const connectWs = () => {
    if (wsRef.current && (wsRef.current.readyState === 0 || wsRef.current.readyState === 1)) return;
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    wsRef.current = new WebSocket(`${wsProto}://${location.host}/ws`);
    wsRef.current.onopen = () => subscribeWs();
    wsRef.current.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (activeTabRef.current !== 'live-klv') return;
      if (!streamRuntimeRef.current?.running) return;
      if (msg.type === "st0601") showOverlay({ mode: "live-ws", ...msg }, 'live-klv');
    };
  };

  const subscribeWs = () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type: "subscribe", streamId, mode: "live" }));
  };

  const disconnectWs = () => {
    if (!wsRef.current) return;
    try {
      if (wsRef.current.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "subscribe", streamId: null, mode: "live" }));
      }
    } catch {}
    try { wsRef.current.close(); } catch {}
    wsRef.current = null;
  };

  const attachHlsDvr = (streamId, retryCount = 0) => {
    const maxRetries = 50; // Stop after 50 retries (~5 seconds)

    const url = `/hls/${encodeURIComponent(streamId)}/master.m3u8`;
    setHlsMediaLoaded(false);

    vttHookedRef.current = false;

    // Reuse existing player on tab switches if source is unchanged.
    if (window.player && !window.player.isDisposed?.()) {
      const currentSrc = String(window.player.currentSrc?.() || "");
      if (currentSrc.includes(`/hls/${encodeURIComponent(streamId)}/master.m3u8`)) {
        setHlsMediaLoaded(hasLoadedHlsMedia(window.player));
        window.player.play().catch(() => {});
        hookVttOverlaySoon();
        return;
      }
      window.player.dispose();
      window.player = null;
      setHlsMediaLoaded(false);
    }

    // Check if element exists and is in DOM
    if (!videoRef.current || !document.contains(videoRef.current)) {
      if (retryCount < maxRetries) {
        console.warn(`Video element not ready, retrying in 100ms (${retryCount + 1}/${maxRetries})`);
        setTimeout(() => attachHlsDvr(streamId, retryCount + 1), 100);
      } else {
        console.error('Video element not found after maximum retries');
      }
      return;
    }

    try {
      // Initialize video.js player
      if (typeof window.videojs !== 'function') {
        setStatus('Video.js is not loaded. Check script includes in index.html.');
        return;
      }

      window.player = window.videojs(videoRef.current, {
        controls: true,
        liveui: true,
        controlBar: {
          progressControl: true
        },
        html5: {
          hls: {
            overrideNative: !window.videojs.browser.IS_SAFARI
          }
        }
      });

      window.player.src({
        src: url,
        type: 'application/x-mpegURL'
      });
      setHlsMediaLoaded(false);

      window.player.on('loadedmetadata', () => setHlsMediaLoaded(true));
      window.player.on('canplay', () => setHlsMediaLoaded(true));
      window.player.on('playing', () => setHlsMediaLoaded(true));
      window.player.on('loadstart', () => setHlsMediaLoaded(false));
      window.player.on('emptied', () => setHlsMediaLoaded(false));
      window.player.on('dispose', () => setHlsMediaLoaded(false));

      window.player.on('error', () => {
        setHlsMediaLoaded(false);
        // If the playlist is not yet ready, keep retrying in the background.
        startHlsAutoAttach(streamId);
      });

      window.player.ready(() => {
        window.player.play().catch(() => {});
        hookVttOverlaySoon();
      });
    } catch (error) {
      console.error('Error initializing video.js player:', error);
    }
  };

  const hookVttOverlaySoon = () => {
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
  };

  const tryHookVttTrack = () => {
    if (vttHookedRef.current) return true;

    const tracks = window.player ? window.player.textTracks() : [];
    if (!tracks || !tracks.length) return false;

    let metaTrack = null;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].label === "KLV" || tracks[i].language === "en") {
        metaTrack = tracks[i];
        break;
      }
    }
    if (!metaTrack) return false;

    metaTrack.mode = "hidden";
    metaTrack.oncuechange = () => {
      const cues = metaTrack.activeCues;
      if (!cues || !cues.length) return;
      const cue = cues[cues.length - 1];
      try {
        const obj = JSON.parse(cue.text);
        showOverlay({ mode: "dvr-vtt", ...obj }, 'dvr');
      } catch {
        showOverlay({ mode: "dvr-vtt", raw: cue.text }, 'dvr');
      }
    };

    vttHookedRef.current = true;
    return true;
  };

  const startHlsAutoAttach = (targetStreamId) => {
    clearHlsRetryLoop();
    const token = ++hlsRetryTokenRef.current;

    const run = async () => {
      if (token !== hlsRetryTokenRef.current) return;
      if (activeTab !== 'dvr') return;

      const available = await probeHlsReady(targetStreamId);
      if (token !== hlsRetryTokenRef.current) return;

      if (available) {
        attachHlsDvr(targetStreamId);
        return;
      }

      hlsRetryTimerRef.current = setTimeout(run, 1000);
    };

    run();
  };

  const startWebRtcAutoAttach = (targetStreamId) => {
    clearWebRtcRetryLoop();
    const token = ++webrtcRetryTokenRef.current;
    let attempts = 0;

    const run = async () => {
      if (token !== webrtcRetryTokenRef.current) return;
      if (activeTab !== 'live-webrtc') return;
      if (hasActiveWebRtcSession(targetStreamId)) {
        reattachWebRtcStream();
        setLiveStatus('Playing');
        return;
      }

      attempts += 1;
      const runtime = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
      if (!runtime?.running || !runtime?.ingestRunning) {
        setLiveStatus('Waiting for ingest producer...');
        webrtcRetryTimerRef.current = setTimeout(run, 1000);
        return;
      }

      try {
        await startLiveWebRtc(targetStreamId);
        return;
      } catch (error) {
        setLiveStatus(`Retrying... (${attempts})`);
      }

      webrtcRetryTimerRef.current = setTimeout(run, 1000);
    };

    run();
  };

  useLayoutEffect(() => {
    if (activeTab === 'dvr') {
      // Keep probing until HLS appears, then attach, but only after user started a source.
      if (autoAttachOnDvr) {
        if (window.player && !window.player.isDisposed?.()) {
          window.player.play().catch(() => {});
          hookVttOverlaySoon();
        } else {
          setTimeout(() => startHlsAutoAttach(streamId), 0);
        }
      }
      clearWebRtcRetryLoop();
    } else if (activeTab === 'live-klv') {
      clearHlsRetryLoop();
      try { window.player?.pause?.(); } catch {}
      clearWebRtcRetryLoop();
      connectWs();
      subscribeWs();
    } else if (activeTab === 'live-webrtc') {
      clearHlsRetryLoop();
      try { window.player?.pause?.(); } catch {}
      if (hasActiveWebRtcSession(streamId)) {
        reattachWebRtcStream();
        setLiveStatus('Playing');
      } else {
        startWebRtcAutoAttach(streamId);
      }
    }
  }, [activeTab, streamId, autoAttachOnDvr]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    setOverlayData(null);
    if (activeTab !== 'live-klv') {
      disconnectWs();
    }
  }, [activeTab]);

  useEffect(() => {
    streamRuntimeRef.current = streamRuntime;
    if (activeTab === 'live-klv' && !streamRuntime?.running) {
      setOverlayData(null);
    }
  }, [streamRuntime, activeTab]);

  useEffect(() => {
    if (activeTab !== 'dvr') {
      setHlsMediaLoaded(false);
      return;
    }
    setHlsMediaLoaded(hasLoadedHlsMedia(window.player));
  }, [activeTab]);

  useEffect(() => {
    refreshSources({ silent: true }).catch(() => {});
    refreshStreamState(streamId).catch(() => {});

    const timer = setInterval(() => {
      refreshSources({ silent: true }).catch(() => {});
      refreshStreamState(streamId).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [streamId]);

  useEffect(() => {
    setInputProbe({
      phase: 'idle',
      available: null,
      indicator: null,
      container: null,
      video: null,
      klv: null,
      error: null,
      testedAt: null
    });
  }, [inputUrl]);

  useEffect(() => {
    return () => {
      clearHlsRetryLoop();
      clearWebRtcRetryLoop();
      disconnectWs();
      cleanupWebRtcPlayback();
      if (window.player) {
        window.player.dispose();
        window.player = null;
      }
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'live-webrtc') return;
    refreshWebRtcDebug(streamId).catch(() => {});
    const timer = setInterval(() => {
      refreshWebRtcDebug(streamId).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [activeTab, streamId]);

  const overlayEntries = overlayData && typeof overlayData === 'object'
    ? Object.entries(overlayData)
    : [];
  const statusParsed = parseStatusPayload(status);

  return (
    <MantineProvider theme={theme}>
      <AppShell
        header={{ height: 60 }}
        padding="md"
      >
        <AppShell.Header>
          <Text size="lg" fw={700} p="md">DVR + WebRTC + KLV Demo</Text>
        </AppShell.Header>

        <AppShell.Main>
          <Stack spacing="md">
            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Start Source</Text>
              <Group mt="xs" align="end" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  label="Stream ID"
                  value={streamId}
                  onChange={(e) => setStreamId(e.target.value)}
                />
                <TextInput
                  style={{ flex: 1 }}
                  label="Input URL"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                />
                <Button
                  onClick={testInputFeed}
                  loading={inputProbe.phase === 'testing'}
                  disabled={!String(inputUrl || '').trim()}
                >
                  Test Feed
                </Button>
                <Badge color={probeBadgeColor} variant="filled">{probeBadgeLabel}</Badge>
              </Group>
              {(inputProbe.container || inputProbe.video || inputProbe.klv || inputProbe.error) ? (
                <Text size="xs" mt="xs" c={inputProbe.error ? 'red' : 'dimmed'}>
                  {inputProbe.error
                    ? `Probe error: ${inputProbe.error}`
                    : `container: ${inputProbe.container?.longName || inputProbe.container?.name || 'unknown'} | video codec: ${inputProbe.video?.codecLongName || inputProbe.video?.codec || 'unknown'}${inputProbe.video?.width && inputProbe.video?.height ? ` | ${inputProbe.video.width}x${inputProbe.video.height}` : ''}${Number.isFinite(inputProbe.video?.fps) ? ` | ${inputProbe.video.fps} fps` : ''} | klv: ${inputProbe.klv?.available ? (inputProbe.klv?.confidence === 'high' ? 'detected' : 'possible (data stream found)') : 'not detected'}`}
                </Text>
              ) : null}
              <Group mt="sm">
                <Button
                  variant="subtle"
                  onClick={() => setShowAdvancedSettings((prev) => !prev)}
                >
                  {showAdvancedSettings ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
                </Button>
              </Group>
              <Collapse in={showAdvancedSettings}>
                <Group grow mt="xs">
                  <TextInput label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} />
                  <NumberInput label="DVR Seconds" value={dvrSeconds} onChange={setDvrSeconds} />
                  <NumberInput label="HLS/VTT Segment Seconds" value={hlsSegmentSeconds} onChange={setHlsSegmentSeconds} min={0.25} step={0.25} />
                </Group>
                <Group grow mt="xs">
                  <NumberInput label="Max Cues/Sec" value={maxCuesPerSecond} onChange={setMaxCuesPerSecond} />
                  <NumberInput label="Min Cue Dur Sec" value={minCueDurSec} onChange={setMinCueDurSec} step={0.01} precision={2} />
                  <NumberInput label="Max Cue Dur Sec" value={maxCueDurSec} onChange={setMaxCueDurSec} step={0.01} precision={2} />
                </Group>
              </Collapse>
              <Switch
                mt="sm"
                label="Purge existing recordings and KLV data before start"
                checked={purgeBeforeStart}
                onChange={(event) => setPurgeBeforeStart(event.currentTarget.checked)}
              />
              <Group mt="md">
                <Button onClick={startSource} disabled={!canStartSource}>Start Source</Button>
                <Button onClick={stopSource} color="red" disabled={!canStopSource}>Stop Source</Button>
                <Button onClick={refreshSources} variant="outline" disabled={startRequestInFlight || stopRequestInFlight}>Refresh</Button>
              </Group>

              <Group mt="md" align="center">
                <Text size="sm">Current Stream State:</Text>
                <Badge color={stateColor(streamRuntime?.state)} variant="filled">
                  {streamRuntime?.state || 'unknown'}
                </Badge>
                <Text size="sm">{streamRuntime?.running ? 'Running' : 'Not Running'}</Text>
              </Group>
              {streamRuntime?.lastError ? (
                <Text size="sm" c="red" mt="xs">Last error: {streamRuntime.lastError}</Text>
              ) : null}
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Active Sources</Text>
              <Stack spacing="xs" mt="xs">
                {sourcesList.length ? sourcesList.map((s) => (
                  <Paper key={s.streamId} p="xs" withBorder>
                    <Group justify="space-between">
                      <Text>{s.streamId}</Text>
                      <Group gap="xs">
                        <Badge color={stateColor(s.state)}>{s.state || 'unknown'}</Badge>
                        <Text size="sm">{s.running ? 'Running' : 'Not Running'}</Text>
                      </Group>
                    </Group>
                    <Text size="xs" c="dimmed">
                      hls: {s.hlsRunning ? 'up' : 'down'} | klv: {s.klvRunning ? 'up' : 'down'} | ingest: {s.ingestRunning ? 'up' : 'down'}
                    </Text>
                  </Paper>
                )) : <Text size="sm" c="dimmed">No active sources</Text>}
              </Stack>
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Playback</Text>
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  <Tabs.Tab value="dvr">DVR (HLS)</Tabs.Tab>
                  <Tabs.Tab value="live-webrtc">Live (WebRTC)</Tabs.Tab>
                  <Tabs.Tab value="live-klv">Live KLV (WS)</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="dvr" pt="xs">
                  <Text>DVR HLS playback with VTT overlay</Text>
                  <video ref={videoRef} id="video-player" className="video-js" controls muted playsInline style={{ width: '100%', maxHeight: '400px' }}></video>
                  {activeTab === 'dvr' && hlsMediaLoaded ? (
                    <Group mt="xs">
                      <Button variant="light" onClick={seekHlsToStart}>Play From Start</Button>
                      <Button variant="light" onClick={() => seekHlsBySeconds(-15)}>Rewind 15s</Button>
                      <Button variant="light" onClick={toggleHlsPlayPause}>Pause / Play</Button>
                      <Button variant="light" onClick={() => seekHlsBySeconds(15)}>FF 15s</Button>
                      <Button variant="light" onClick={seekHlsToEnd}>Go To End</Button>
                    </Group>
                  ) : null}
                </Tabs.Panel>

                <Tabs.Panel value="live-webrtc" pt="xs">
                  <Text>Live video via WebRTC</Text>
                  <Group gap="xs" mb="xs">
                    <Text size="sm" c="dimmed">Status: {liveStatus}</Text>
                    <Badge color={webrtcBadge.color} variant="light">{webrtcBadge.label}</Badge>
                  </Group>
                  <Text size="xs" c="dimmed" mb="xs">
                    producerScore: {webrtcDiag.producerScore ?? 'n/a'} | consumerScore: {webrtcDiag.consumerScore ?? 'n/a'} | layers: {webrtcDiag.currentLayers ? JSON.stringify(webrtcDiag.currentLayers) : 'n/a'}
                  </Text>
                  <video ref={liveVideoRef} muted playsInline autoPlay style={{ width: '100%', maxHeight: '400px' }}></video>
                </Tabs.Panel>

                <Tabs.Panel value="live-klv" pt="xs">
                  <Text>Live KLV via WebSocket</Text>
                </Tabs.Panel>
              </Tabs>
            </Paper>

            <Group grow>
              <Paper shadow="xs" p="md">
                <Text size="lg" fw={500}>Status</Text>
                {statusParsed.entries.length ? (
                  <Stack gap={4} mt="xs">
                    {statusParsed.entries.map(([key, value]) => (
                      <Group key={key} justify="space-between" align="flex-start" wrap="nowrap">
                        <Text size="xs" fw={600}>{key}</Text>
                        <Text
                          size="xs"
                          style={{ maxWidth: '70%', textAlign: 'right', overflowWrap: 'anywhere' }}
                        >
                          {formatOverlayValue(value)}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed" mt="xs">
                    {statusParsed.text || 'No status yet.'}
                  </Text>
                )}
              </Paper>
              <Paper shadow="xs" p="md">
                <Text size="lg" fw={500}>Overlay</Text>
                {overlayEntries.length ? (
                  <Stack gap={4} mt="xs">
                    {overlayEntries.map(([key, value]) => (
                      <Group key={key} justify="space-between" align="flex-start" wrap="nowrap">
                        <Text size="xs" fw={600}>{key}</Text>
                        <Text
                          size="xs"
                          style={{ maxWidth: '70%', textAlign: 'right', overflowWrap: 'anywhere' }}
                        >
                          {formatOverlayValue(value)}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed" mt="xs">
                    No overlay data for this tab.
                  </Text>
                )}
              </Paper>
            </Group>
          </Stack>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
