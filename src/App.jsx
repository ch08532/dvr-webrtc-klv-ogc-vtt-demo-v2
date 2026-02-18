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
  const [dvrStatus, setDvrStatus] = useState('Idle');
  const [dvrDiag, setDvrDiag] = useState({
    currentSrc: null,
    currentPlaylistUri: null,
    currentPlaylistResolvedUri: null,
    currentSegmentSequence: null,
    currentSegmentUri: null,
    currentSubtitleUri: null,
    error: null
  });
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
  const [serverOnline, setServerOnline] = useState(true);
  const [streamRuntime, setStreamRuntime] = useState({ streamId: 'stream1', state: 'stopped', running: false, lastError: null });
  const [sourcesList, setSourcesList] = useState([]);

  const videoRef = useRef(null);
  const dvrVideoHostRef = useRef(null);
  const liveVideoRef = useRef(null);
  const wsWorkerRef = useRef(null);
  const vttHookedRef = useRef(false);
  const vttTrackRef = useRef(null);
  const vttTrackCueListenerRef = useRef(null);
  const vttTrackListListenersRef = useRef([]);
  const vttPollTimerRef = useRef(null);
  const vttLastCueSignatureRef = useRef(null);
  const vttDiscoverTimerRef = useRef(null);
  const hlsRetryTimerRef = useRef(null);
  const hlsRetryTokenRef = useRef(0);
  const webrtcRetryTimerRef = useRef(null);
  const webrtcRetryTokenRef = useRef(0);
  const webrtcTransportRef = useRef(null);
  const webrtcConsumerRef = useRef(null);
  const webrtcMediaStreamRef = useRef(null);
  const webrtcStreamIdRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const streamIdRef = useRef(streamId);
  const streamRuntimeRef = useRef(streamRuntime);
  const serverOnlineRef = useRef(serverOnline);
  const offlinePollTimerRef = useRef(null);
  const offlinePollTokenRef = useRef(0);

  const clearOfflinePollLoop = () => {
    if (offlinePollTimerRef.current) {
      clearTimeout(offlinePollTimerRef.current);
      offlinePollTimerRef.current = null;
    }
  };

  const resetPlaybackStateAfterReconnect = () => {
    setDvrDiag((prev) => ({
      ...prev,
      currentSrc: null,
      currentPlaylistUri: null,
      currentPlaylistResolvedUri: null,
      currentSegmentSequence: null,
      currentSegmentUri: null,
      currentSubtitleUri: null,
      error: null
    }));
    setDvrStatus('No media');
    setWebrtcDiag({
      consumerId: null,
      producerScore: null,
      consumerScore: null,
      currentLayers: null,
      error: null
    });
    setLiveStatus('Not connected (start source)');
  };

  const markServerOnline = () => {
    if (!serverOnlineRef.current) {
      serverOnlineRef.current = true;
      setServerOnline(true);
      setStatus('Server connection restored.');
      resetPlaybackStateAfterReconnect();
    }
  };

  const markServerOffline = (error) => {
    if (!serverOnlineRef.current) return;
    serverOnlineRef.current = false;
    setServerOnline(false);
    setStatus(`Server offline. Retrying... (${String(error?.message || error || 'network error')})`);
    setOverlayData(null);
    setSourcesList([]);
    setAutoAttachOnDvr(false);
    setInputProbe((prev) => ({ ...prev, phase: 'idle', error: null }));
    setStreamRuntime((prev) => ({
      ...prev,
      state: 'offline',
      running: false,
      hlsRunning: false,
      klvRunning: false,
      ingestRunning: false,
      lastError: 'server offline'
    }));
    setWebrtcDiag({
      consumerId: null,
      producerScore: null,
      consumerScore: null,
      currentLayers: null,
      error: 'server offline'
    });
    setDvrDiag({
      currentSrc: null,
      currentPlaylistUri: null,
      currentPlaylistResolvedUri: null,
      currentSegmentSequence: null,
      currentSegmentUri: null,
      currentSubtitleUri: null,
      error: 'server offline'
    });
    setHlsMediaLoaded(false);
    setDvrStatus('Server offline. Retrying...');
    setLiveStatus('Server offline. Retrying...');
    clearHlsRetryLoop();
    clearWebRtcRetryLoop();
    disconnectWs();
    cleanupWebRtcPlayback();
    clearDvrPlayerInstance();
  };

  const api = async (url, opts) => {
    try {
      const res = await fetch(url, opts);
      const urlText = String(url || '');
      const isBackendApiPath = /^\/(sources|webrtc|streams|probe|metrics|healthz|ogc)(\/|$)/.test(urlText);
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const hasBackendRequestId = !!res.headers.get('x-request-id');
      const looksLikeBackendApi = hasBackendRequestId || contentType.includes('application/json');
      const backendUnavailableStatus = res.status === 502 || res.status === 503 || res.status === 504;

      if ((isBackendApiPath && !looksLikeBackendApi) || backendUnavailableStatus) {
        const error = new Error(`Backend unavailable (HTTP ${res.status})`);
        markServerOffline(error);
        throw error;
      }
      markServerOnline();
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
    } catch (error) {
      markServerOffline(error);
      throw error;
    }
  };

  const stateColor = (state) => {
    if (state === 'running') return 'green';
    if (state === 'degraded') return 'orange';
    if (state === 'starting' || state === 'stopping') return 'yellow';
    if (state === 'error') return 'red';
    if (state === 'offline') return 'red';
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
  const isStopBlockedByState = ['starting', 'stopping', 'stopped'].includes(streamRuntime?.state);
  const canStartSource = serverOnline && !startRequestInFlight && !stopRequestInFlight && !isStartBlockedByState;
  const canStopSource = serverOnline && !startRequestInFlight && !stopRequestInFlight && !isStopBlockedByState;

  const webrtcBadge = (() => {
    const statusText = String(liveStatus || '').toLowerCase();
    if (!serverOnline) return { color: 'red', label: 'Server Offline' };
    if (/reconnecting|failed|disconnected|closed|ended/.test(statusText)) {
      return { color: 'red', label: 'Reconnecting' };
    }
    if (/connecting|waiting|retrying/.test(statusText)) {
      return { color: 'yellow', label: 'Connecting' };
    }
    if (webrtcDiag.error) return { color: 'red', label: 'Diag Error' };
    if (!webrtcDiag.consumerId) return { color: 'gray', label: 'No Stats' };
    if ((webrtcDiag.producerScore ?? 0) <= 0) return { color: 'red', label: 'No Producer Media' };
    if ((webrtcDiag.consumerScore ?? 0) <= 0) return { color: 'orange', label: 'No Consumer Media' };
    return { color: 'green', label: 'Media Flowing' };
  })();

  const dvrBadge = (() => {
    if (dvrDiag.error) return { color: 'red', label: 'Playback Error' };
    if (/playing/i.test(dvrStatus)) return { color: 'green', label: 'Media Flowing' };
    if (/waiting|buffering|loading|connecting|seeking/i.test(dvrStatus)) return { color: 'yellow', label: 'Buffering' };
    if (/paused/i.test(dvrStatus)) return { color: 'gray', label: 'Paused' };
    if (/ended/i.test(dvrStatus)) return { color: 'orange', label: 'Ended' };
    if (hlsMediaLoaded) return { color: 'green', label: 'Media Ready' };
    return { color: 'gray', label: 'No Media' };
  })();

  const refreshStreamState = async (targetStreamId = streamId, { updateStatus = false } = {}) => {
    if (!targetStreamId) return;
    const result = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
    if (result?.streamId) {
      setStreamRuntime(result);
      if (result.running) setAutoAttachOnDvr(true);
      if (!result.running) setAutoAttachOnDvr(false);
      if (updateStatus) setStatus(JSON.stringify(result, null, 2));
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

  const clearVttPollLoop = () => {
    if (vttPollTimerRef.current) {
      clearInterval(vttPollTimerRef.current);
      vttPollTimerRef.current = null;
    }
  };

  const clearVttDiscoverLoop = () => {
    if (vttDiscoverTimerRef.current) {
      clearInterval(vttDiscoverTimerRef.current);
      vttDiscoverTimerRef.current = null;
    }
  };

  const clearVttTrackListListeners = () => {
    for (const item of vttTrackListListenersRef.current) {
      try { item.list.removeEventListener('addtrack', item.onTrackListChange); } catch {}
      try { item.list.removeEventListener('removetrack', item.onTrackListChange); } catch {}
      try { item.list.removeEventListener('change', item.onTrackListChange); } catch {}
    }
    vttTrackListListenersRef.current = [];
  };

  const clearVttTrackBinding = () => {
    if (vttTrackRef.current && vttTrackCueListenerRef.current) {
      try { vttTrackRef.current.removeEventListener('cuechange', vttTrackCueListenerRef.current); } catch {}
      try { vttTrackRef.current.oncuechange = null; } catch {}
    }
    vttTrackRef.current = null;
    vttTrackCueListenerRef.current = null;
    vttLastCueSignatureRef.current = null;
    vttHookedRef.current = false;
  };

  const clearVttOverlayHooks = () => {
    clearVttDiscoverLoop();
    clearVttPollLoop();
    clearVttTrackListListeners();
    clearVttTrackBinding();
  };

  const clearDvrPlayerInstance = () => {
    clearVttOverlayHooks();
    if (window.player && !window.player.isDisposed?.()) {
      try { window.player.dispose(); } catch {}
    }
    window.player = null;
    if (dvrVideoHostRef.current) {
      try { dvrVideoHostRef.current.innerHTML = ""; } catch {}
    }
    videoRef.current = null;
    setHlsMediaLoaded(false);
    vttHookedRef.current = false;
  };

  const hideTracks = (trackList) => {
    if (!trackList || !Number.isFinite(Number(trackList.length)) || trackList.length <= 0) return;
    for (let i = 0; i < trackList.length; i++) {
      const textTrack = trackList[i];
      if (!textTrack) continue;
      const kind = String(textTrack.kind || "").toLowerCase();
      if (kind !== "subtitles" && kind !== "captions") continue;
      try { textTrack.mode = 'hidden'; } catch {}
    }
  };

  const forceHideCaptionTracks = (player = null) => {
    const p = player || window.player;
    const trackLists = [videoRef.current?.textTracks, p?.textTracks?.(), p?.remoteTextTracks?.()].filter(Boolean);
    for (const list of trackLists) hideTracks(list);
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

  const clearWebRtcDiag = () => {
    setWebrtcDiag({
      consumerId: null,
      producerScore: null,
      consumerScore: null,
      currentLayers: null,
      error: null
    });
  };

  const setLiveNotConnected = () => {
    clearWebRtcDiag();
    setLiveStatus('Not connected (start source)');
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

  const scheduleWebRtcReconnect = (targetStreamId, message, { transport = null, consumer = null } = {}) => {
    if (!serverOnlineRef.current) return;
    if (transport && webrtcTransportRef.current !== transport) return;
    if (consumer && webrtcConsumerRef.current !== consumer) return;

    clearWebRtcDiag();
    setLiveStatus(message);
    setTimeout(() => {
      if (!serverOnlineRef.current) return;
      if (transport && webrtcTransportRef.current !== transport) return;
      if (consumer && webrtcConsumerRef.current !== consumer) return;
      startWebRtcAutoAttach(targetStreamId);
    }, 1000);
  };

  const startLiveWebRtc = async (targetStreamId) => {
    cleanupWebRtcPlayback();
    clearWebRtcDiag();
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
      if (webrtcTransportRef.current !== recvTransport) return;
      if (state === 'connected') setLiveStatus('Connected (waiting for video)...');
      else if (state === 'failed') {
        scheduleWebRtcReconnect(targetStreamId, 'Connection failed. Reconnecting...', { transport: recvTransport });
      } else if (state === 'disconnected') {
        scheduleWebRtcReconnect(targetStreamId, 'Disconnected. Reconnecting...', { transport: recvTransport });
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
      scheduleWebRtcReconnect(targetStreamId, 'Transport closed. Reconnecting...', { transport: recvTransport, consumer });
    });
    consumer.on('producerclose', () => {
      scheduleWebRtcReconnect(targetStreamId, 'Producer closed. Reconnecting...', { transport: recvTransport, consumer });
    });
    consumer.track.onended = () => {
      scheduleWebRtcReconnect(targetStreamId, 'Track ended. Reconnecting...', { transport: recvTransport, consumer });
    };
    consumer.track.onunmute = () => {
      if (webrtcConsumerRef.current !== consumer) return;
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
    } catch (error) {
      setStatus(`Start source failed: ${String(error?.message || error)}`);
      setStreamRuntime((prev) => ({
        ...prev,
        streamId,
        state: serverOnlineRef.current ? 'error' : 'offline',
        running: false,
        lastError: String(error?.message || error)
      }));
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
      clearDvrPlayerInstance();
      setDvrStatus('Stopped');
      setDvrDiag({
        currentSrc: null,
        currentPlaylistUri: null,
        currentPlaylistResolvedUri: null,
        currentSegmentSequence: null,
        currentSegmentUri: null,
        currentSubtitleUri: null,
        error: null
      });
      cleanupWebRtcPlayback();
      clearWebRtcDiag();
      setLiveStatus('Stopped');
      await refreshStreamState(streamId);
      await refreshSources({ silent: true });
    } catch (error) {
      setStatus(`Stop source failed: ${String(error?.message || error)}`);
      if (!serverOnlineRef.current) {
        setLiveNotConnected();
      }
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
      const message = String(result?.error || 'debug unavailable');
      if (/SFU client not initialized|SFU worker is not running/i.test(message)) {
        setWebrtcDiag({
          consumerId: null,
          producerScore: null,
          consumerScore: null,
          currentLayers: null,
          error: null
        });
        if (!hasActiveWebRtcSession(targetStreamId)) {
          setLiveStatus('Waiting for SFU...');
        }
        return;
      }
      setWebrtcDiag((prev) => ({
        ...prev,
        error: message
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
      if (Array.isArray(value)) {
        return { entries: [], text: JSON.stringify(value, null, 2) };
      }
      return { entries: Object.entries(value), text: '' };
    }

    const asText = String(value);
    const trimmed = asText.trim();
    if (!trimmed) return { entries: [], text: '' };

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { entries: Object.entries(parsed), text: '' };
      }
      return { entries: [], text: JSON.stringify(parsed, null, 2) };
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

  const getCurrentHlsPlaylistInfo = (player = null) => {
    const subtitleUriForSegmentUri = (segmentUri) => {
      const raw = String(segmentUri || '').trim();
      if (!raw) return null;
      const queryIndex = raw.search(/[?#]/);
      const normalized = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
      if (!normalized) return null;
      const slashIdx = normalized.lastIndexOf('/');
      const dir = slashIdx >= 0 ? normalized.slice(0, slashIdx + 1) : '';
      const filename = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
      if (!filename) return null;
      const dotIdx = filename.lastIndexOf('.');
      const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
      if (!base) return null;
      return `${dir}meta_${base}.vtt`;
    };

    const p = player || getActiveHlsPlayer();
    if (!p) {
      return {
        currentSrc: null,
        currentPlaylistUri: null,
        currentPlaylistResolvedUri: null,
        currentSegmentSequence: null,
        currentSegmentUri: null,
        currentSubtitleUri: null
      };
    }

    let currentPlaylistUri = null;
    let currentPlaylistResolvedUri = null;
    let currentSegmentSequence = null;
    let currentSegmentUri = null;
    let currentSubtitleUri = null;
    try {
      const tech = p.tech?.({ IWillNotUseThisInPlugins: true });
      const vhs = tech?.vhs || p.vhs || null;
      const mediaPlaylist = vhs?.playlists?.media?.();
      if (mediaPlaylist) {
        currentPlaylistUri = mediaPlaylist.uri || mediaPlaylist.id || null;
        currentPlaylistResolvedUri = mediaPlaylist.resolvedUri || null;

        const segments = Array.isArray(mediaPlaylist.segments) ? mediaPlaylist.segments : null;
        const mediaSequence = Number(mediaPlaylist.mediaSequence);
        const currentTime = Number(p.currentTime?.());
        const seekBounds = getHlsSeekBounds(p);
        const playlistStart = Number(seekBounds?.start ?? 0);

        if (segments?.length && Number.isFinite(currentTime) && Number.isFinite(playlistStart)) {
          let offsetSec = currentTime - playlistStart;
          if (!Number.isFinite(offsetSec) || offsetSec < 0) offsetSec = 0;

          let cumulative = 0;
          let segmentIdx = segments.length - 1;
          for (let i = 0; i < segments.length; i++) {
            const d = Number(segments[i]?.duration);
            const dur = Number.isFinite(d) && d > 0 ? d : 0;
            if (offsetSec < cumulative + dur || i === segments.length - 1) {
              segmentIdx = i;
              break;
            }
            cumulative += dur;
          }

          const segment = segments[segmentIdx] || null;
          if (segment) {
            currentSegmentUri = segment.uri || segment.resolvedUri || null;
            currentSubtitleUri = subtitleUriForSegmentUri(currentSegmentUri);
            currentSegmentSequence = Number.isFinite(mediaSequence)
              ? mediaSequence + segmentIdx
              : segmentIdx;
          }
        }
      }
    } catch {
      // no-op, diagnostics are best-effort
    }

    return {
      currentSrc: String(p.currentSrc?.() || "") || null,
      currentPlaylistUri,
      currentPlaylistResolvedUri,
      currentSegmentSequence,
      currentSegmentUri,
      currentSubtitleUri
    };
  };

  const refreshDvrPlaybackInfo = (player = null) => {
    const info = getCurrentHlsPlaylistInfo(player);
    setDvrDiag((prev) => ({
      ...prev,
      currentSrc: info.currentSrc,
      currentPlaylistUri: info.currentPlaylistUri,
      currentPlaylistResolvedUri: info.currentPlaylistResolvedUri,
      currentSegmentSequence: info.currentSegmentSequence,
      currentSegmentUri: info.currentSegmentUri,
      currentSubtitleUri: info.currentSubtitleUri
    }));
  };

  const connectWs = () => {
    if (!wsWorkerRef.current) {
      const worker = new Worker(new URL('./workers/klv_ws_worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'st0601') {
          if (activeTabRef.current !== 'live-webrtc') return;
          const state = streamRuntimeRef.current?.state;
          if (state === 'stopped' || state === 'stopping') return;
          const payloadStreamId = msg.payload?.streamId;
          if (payloadStreamId && payloadStreamId !== streamIdRef.current) return;
          showOverlay({ mode: "live-ws", ...(msg.payload || {}) }, 'live-webrtc');
          return;
        }
        if (msg.type === 'ws_error') {
          setStatus(`KLV WS worker error: ${String(msg.error || 'socket error')}`);
          return;
        }
        if (msg.type === 'ws_close') {
          setStatus(`KLV WS disconnected (code=${String(msg.code ?? 'n/a')})`);
        }
      };
      worker.onerror = (event) => {
        setStatus(`KLV WS worker error: ${String(event?.message || 'unknown')}`);
      };
      wsWorkerRef.current = worker;
    }
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    wsWorkerRef.current.postMessage({ type: 'connect', url: `${wsProto}://${location.host}/ws` });
  };

  const subscribeWs = () => {
    if (!wsWorkerRef.current) return;
    wsWorkerRef.current.postMessage({ type: 'subscribe', streamId, mode: 'live' });
  };

  const disconnectWs = () => {
    if (!wsWorkerRef.current) return;
    try { wsWorkerRef.current.postMessage({ type: 'disconnect' }); } catch {}
    try { wsWorkerRef.current.terminate(); } catch {}
    wsWorkerRef.current = null;
  };

  const attachHlsDvr = (streamId, retryCount = 0) => {
    const maxRetries = 50; // Stop after 50 retries (~5 seconds)

    const url = `/hls/${encodeURIComponent(streamId)}/master.m3u8`;
    setHlsMediaLoaded(false);
    setDvrStatus('Connecting...');
    setDvrDiag({
      currentSrc: url,
      currentPlaylistUri: null,
      currentPlaylistResolvedUri: null,
      currentSegmentSequence: null,
      currentSegmentUri: null,
      currentSubtitleUri: null,
      error: null
    });

    vttHookedRef.current = false;

    // Reuse existing player on tab switches if source is unchanged.
    if (window.player && !window.player.isDisposed?.()) {
      const currentSrc = String(window.player.currentSrc?.() || "");
      if (currentSrc.includes(`/hls/${encodeURIComponent(streamId)}/master.m3u8`)) {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(hasLoadedHlsMedia(window.player));
        setDvrStatus(window.player.paused?.() ? 'Paused' : 'Playing');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(window.player);
        window.player.play().catch(() => {});
        hookVttOverlaySoon();
        return;
      }
      clearDvrPlayerInstance();
    }

    // Check if host exists and is in DOM
    const hostEl = dvrVideoHostRef.current;
    if (!hostEl || !document.contains(hostEl)) {
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

      if (!videoRef.current || !hostEl.contains(videoRef.current)) {
        hostEl.innerHTML = "";
        const videoEl = document.createElement("video");
        videoEl.id = "video-player";
        videoEl.className = "video-js";
        videoEl.controls = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.style.width = "100%";
        videoEl.style.maxHeight = "400px";
        hostEl.appendChild(videoEl);
        videoRef.current = videoEl;
      }

      window.player = window.videojs(videoRef.current, {
        controls: true,
        liveui: true,
        controlBar: {
          progressControl: true,
          subsCapsButton: false
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
      setDvrStatus('Loading playlist...');

      window.player.on('loadstart', () => {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(false);
        setDvrStatus('Loading playlist...');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('loadedmetadata', () => {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(true);
        setDvrStatus('Ready');
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('canplay', () => {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(true);
        setDvrStatus('Ready');
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('playing', () => {
        setHlsMediaLoaded(true);
        setDvrStatus('Playing');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('waiting', () => {
        setDvrStatus('Buffering...');
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('stalled', () => {
        setDvrStatus('Buffering...');
      });
      window.player.on('seeking', () => {
        setDvrStatus('Seeking...');
      });
      window.player.on('seeked', () => {
        setDvrStatus(window.player.paused?.() ? 'Paused' : 'Playing');
        refreshDvrPlaybackInfo(window.player);
      });
      window.player.on('pause', () => {
        if (!window.player.ended?.()) setDvrStatus('Paused');
      });
      window.player.on('ended', () => {
        setDvrStatus('Ended');
      });
      window.player.on('emptied', () => {
        setHlsMediaLoaded(false);
        setDvrStatus('Idle');
      });
      window.player.on('dispose', () => {
        setHlsMediaLoaded(false);
        setDvrStatus('Idle');
      });

      window.player.on('error', () => {
        setHlsMediaLoaded(false);
        const err = window.player?.error?.();
        const msg = err?.message || `code=${String(err?.code || 'n/a')}`;
        setDvrStatus('Playback error. Reconnecting...');
        setDvrDiag((prev) => ({ ...prev, error: msg }));
        refreshDvrPlaybackInfo(window.player);
        // If the playlist is not yet ready, keep retrying in the background.
        startHlsAutoAttach(streamId);
      });

      window.player.ready(() => {
        forceHideCaptionTracks(window.player);
        window.player.play().catch(() => {});
        refreshDvrPlaybackInfo(window.player);
        hookVttOverlaySoon();
      });
    } catch (error) {
      console.error('Error initializing video.js player:', error);
      setDvrStatus('Playback init failed');
      setDvrDiag((prev) => ({ ...prev, error: String(error?.message || error) }));
    }
  };

  const hookVttOverlaySoon = () => {
    const run = () => {
      if (activeTabRef.current !== 'dvr') return;
      if (tryHookVttTrack()) {
        clearVttDiscoverLoop();
      }
    };

    run();
    if (vttDiscoverTimerRef.current) return;
    vttDiscoverTimerRef.current = setInterval(run, 500);
  };

  const tryHookVttTrack = () => {
    const player = window.player;
    if (!player || player.isDisposed?.()) return false;
    if (vttHookedRef.current && vttTrackRef.current) return true;

    const listToArray = (list) => {
      const out = [];
      if (!list || !Number.isFinite(Number(list.length))) return out;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t) out.push(t);
      }
      return out;
    };

    const scoreTrack = (track) => {
      const label = String(track?.label || '').toLowerCase();
      const kind = String(track?.kind || '').toLowerCase();
      const language = String(track?.language || '').toLowerCase();
      const isKlvLabel = /\bklv\b/.test(label);
      const isSubtitleKind = kind === 'subtitles' || kind === 'captions';
      if (!isSubtitleKind) return -1000;
      let score = 100;
      if (isKlvLabel) score += 300;
      if (label.includes('stanag') || label.includes('misb')) score += 120;
      if (language === 'en') score += 10;
      return score;
    };

    const parseCueIntoOverlay = (track) => {
      const cues = track?.activeCues;
      if (!cues || !cues.length) return false;
      const cue = cues[cues.length - 1];
      if (!cue) return false;
      const cueSignature = `${Number(cue.startTime)}|${Number(cue.endTime)}|${String(cue.text || '')}`;
      if (vttLastCueSignatureRef.current === cueSignature) return true;
      vttLastCueSignatureRef.current = cueSignature;
      try {
        const obj = JSON.parse(cue.text);
        showOverlay({ mode: "dvr-vtt", ...obj }, 'dvr');
      } catch {
        showOverlay({ mode: "dvr-vtt", raw: cue.text }, 'dvr');
      }
      return true;
    };

    const updateDisplayData = (track) => {
      return parseCueIntoOverlay(track);
    };

    const handleCueChange = (event) => {
      const track = event?.target || vttTrackRef.current;
      if (!track) return;
      updateDisplayData(track);
    };

    const bindTrack = (track) => {
      if (!track) return false;

      if (vttTrackRef.current !== track) {
        clearVttTrackBinding();
      }

      if (vttTrackRef.current !== track) {
        // Keep KLV subtitle track off by default in Video.js.
        try { track.mode = 'hidden'; } catch {}
        setStatus(`Bound DVR text track: label=${String(track.label || 'n/a')} kind=${String(track.kind || 'n/a')} language=${String(track.language || 'n/a')}`);
        const onCueChange = (event) => {
          handleCueChange(event);
        };
        try { track.addEventListener('cuechange', onCueChange); } catch {}
        try { track.oncuechange = onCueChange; } catch {}
        vttTrackRef.current = track;
        vttTrackCueListenerRef.current = onCueChange;
      }

      vttHookedRef.current = true;
      updateDisplayData(track);
      return true;
    };

    const allTracks = [];
    const seenTracks = new Set();
    const nativeTrackList = videoRef.current?.textTracks || null;
    const trackLists = [nativeTrackList, player.textTracks?.(), player.remoteTextTracks?.()].filter(Boolean);
    for (const list of trackLists) {
      for (const track of listToArray(list)) {
        if (seenTracks.has(track)) continue;
        seenTracks.add(track);
        allTracks.push(track);
      }
    }
    if (!allTracks.length) return false;

    allTracks.sort((a, b) => scoreTrack(b) - scoreTrack(a));
    const best = allTracks[0];
    if (!best || scoreTrack(best) < 0) return false;

    clearVttTrackListListeners();
    const onTrackListChange = () => {
      forceHideCaptionTracks(player);
      vttHookedRef.current = false;
      tryHookVttTrack();
    };
    for (const list of trackLists) {
      try { list.addEventListener('addtrack', onTrackListChange); } catch {}
      try { list.addEventListener('removetrack', onTrackListChange); } catch {}
      try { list.addEventListener('change', onTrackListChange); } catch {}
      vttTrackListListenersRef.current.push({ list, onTrackListChange });
    }

    if (!vttPollTimerRef.current) {
      vttPollTimerRef.current = setInterval(() => {
        if (activeTabRef.current !== 'dvr') return;
        if (vttTrackRef.current) {
          updateDisplayData(vttTrackRef.current);
          return;
        }
        tryHookVttTrack();
      }, 250);
    }

    return bindTrack(best);
  };

  const startHlsAutoAttach = (targetStreamId) => {
    if (!serverOnlineRef.current) return;
    clearHlsRetryLoop();
    const token = ++hlsRetryTokenRef.current;
    setDvrStatus('Waiting for HLS playlist...');

    const run = async () => {
      if (token !== hlsRetryTokenRef.current) return;
      if (activeTab !== 'dvr') return;
      if (!serverOnlineRef.current) return;

      const available = await probeHlsReady(targetStreamId);
      if (token !== hlsRetryTokenRef.current) return;
      if (!serverOnlineRef.current) return;

      if (available) {
        attachHlsDvr(targetStreamId);
        return;
      }

      hlsRetryTimerRef.current = setTimeout(run, 1000);
    };

    run();
  };

  const startWebRtcAutoAttach = (targetStreamId) => {
    if (!serverOnlineRef.current) return;
    clearWebRtcRetryLoop();
    const token = ++webrtcRetryTokenRef.current;
    let attempts = 0;

    const run = async () => {
      if (token !== webrtcRetryTokenRef.current) return;
      if (activeTab !== 'live-webrtc') return;
      if (!serverOnlineRef.current) return;
      if (hasActiveWebRtcSession(targetStreamId)) {
        reattachWebRtcStream();
        setLiveStatus('Playing');
        return;
      }

      attempts += 1;
      try {
        const runtime = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
        const state = String(runtime?.state || '');
        const sourceStopped = state === 'stopped' || state === 'stopping' || state === 'error' || state === 'offline';

        if (sourceStopped || (!runtime?.running && state !== 'starting')) {
          setLiveNotConnected();
          return;
        }

        if (!runtime?.running || !runtime?.ingestRunning) {
          setLiveStatus('Waiting for ingest producer...');
          webrtcRetryTimerRef.current = setTimeout(run, 1000);
          return;
        }

        await startLiveWebRtc(targetStreamId);
        return;
      } catch (error) {
        if (!serverOnlineRef.current) {
          setLiveNotConnected();
          return;
        }
        setLiveStatus(`Retrying... (${attempts})`);
        webrtcRetryTimerRef.current = setTimeout(run, 1000);
      }
    };

    run();
  };

  useLayoutEffect(() => {
    if (!serverOnline) {
      clearHlsRetryLoop();
      clearWebRtcRetryLoop();
      return;
    }
    if (activeTab === 'dvr') {
      // Keep probing until HLS appears, then attach, but only after user started a source.
      if (autoAttachOnDvr) {
        if (window.player && !window.player.isDisposed?.()) {
          forceHideCaptionTracks(window.player);
          window.player.play().catch(() => {});
          hookVttOverlaySoon();
        } else {
          setTimeout(() => startHlsAutoAttach(streamId), 0);
        }
      }
      clearWebRtcRetryLoop();
    } else if (activeTab === 'live-webrtc') {
      clearHlsRetryLoop();
      try { window.player?.pause?.(); } catch {}
      connectWs();
      subscribeWs();
      if (hasActiveWebRtcSession(streamId)) {
        reattachWebRtcStream();
        setLiveStatus('Playing');
      } else {
        const state = String(streamRuntimeRef.current?.state || '');
        const running = !!streamRuntimeRef.current?.running;
        if (state === 'stopped' || state === 'stopping' || state === 'error' || state === 'offline' || !running) {
          setLiveNotConnected();
          return;
        }
        startWebRtcAutoAttach(streamId);
      }
    }
  }, [activeTab, streamId, autoAttachOnDvr, serverOnline]);

  useEffect(() => {
    activeTabRef.current = activeTab;
    setOverlayData(null);
    if (activeTab !== 'live-webrtc') {
      disconnectWs();
    }
  }, [activeTab]);

  useEffect(() => {
    streamIdRef.current = streamId;
  }, [streamId]);

  useEffect(() => {
    serverOnlineRef.current = serverOnline;
  }, [serverOnline]);

  useEffect(() => {
    streamRuntimeRef.current = streamRuntime;
    if (activeTab === 'live-webrtc' && (streamRuntime?.state === 'stopped' || streamRuntime?.state === 'stopping')) {
      setOverlayData(null);
      setLiveNotConnected();
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
    if (activeTab !== 'dvr') return;
    refreshDvrPlaybackInfo(window.player);
    const timer = setInterval(() => {
      refreshDvrPlaybackInfo(window.player);
    }, 1000);
    return () => clearInterval(timer);
  }, [activeTab, streamId, hlsMediaLoaded]);

  useEffect(() => {
    refreshSources({ silent: true }).catch(() => {});
    refreshStreamState(streamId, { updateStatus: true }).catch(() => {});

    const timer = setInterval(() => {
      refreshSources({ silent: true }).catch(() => {});
      refreshStreamState(streamId).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [streamId]);

  useEffect(() => {
    if (serverOnline) {
      clearOfflinePollLoop();
      return;
    }

    const token = ++offlinePollTokenRef.current;

    const run = async () => {
      if (token !== offlinePollTokenRef.current) return;
      try {
        const res = await fetch(`/sources?_=${Date.now()}`, { cache: 'no-store' });
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        const hasBackendRequestId = !!res.headers.get('x-request-id');
        const looksLikeBackendApi = hasBackendRequestId || contentType.includes('application/json');
        if (!res.ok || !looksLikeBackendApi) {
          throw new Error(`health probe failed (HTTP ${res.status})`);
        }
        if (token !== offlinePollTokenRef.current) return;
        setServerOnline(true);
        await refreshSources({ silent: true });
        await refreshStreamState(streamIdRef.current, { updateStatus: true });
        return;
      } catch {
        // Keep polling while offline.
      }

      if (token !== offlinePollTokenRef.current) return;
      offlinePollTimerRef.current = setTimeout(run, 2000);
    };

    run();
    return () => clearOfflinePollLoop();
  }, [serverOnline]);

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
      clearOfflinePollLoop();
      disconnectWs();
      cleanupWebRtcPlayback();
      clearDvrPlayerInstance();
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'live-webrtc') return;
    if (!serverOnline) return;
    if (!streamRuntime?.running || !streamRuntime?.ingestRunning) return;
    refreshWebRtcDebug(streamId).catch(() => {});
    const timer = setInterval(() => {
      refreshWebRtcDebug(streamId).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [activeTab, streamId, serverOnline, streamRuntime?.running, streamRuntime?.ingestRunning]);

  const dvrOverlayEntries = overlayData?.mode === 'dvr-vtt'
    ? Object.entries(overlayData)
    : [];
  const liveKlvOverlayEntries = overlayData?.mode === 'live-ws'
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
          <Group justify="space-between" align="center" px="md" h="100%">
            <Text size="lg" fw={700}>DVR + WebRTC + KLV Demo</Text>
            <Badge color={serverOnline ? 'green' : 'red'} variant="filled">
              {serverOnline ? 'Server Online' : 'Server Offline'}
            </Badge>
          </Group>
        </AppShell.Header>

        <AppShell.Main>
          <Stack spacing="md">
            {!serverOnline ? (
              <Paper shadow="xs" p="md" withBorder>
                <Text size="sm" fw={600} c="red">Server is offline</Text>
                <Text size="sm" c="dimmed">
                  Cleared local playback state. Polling every 2 seconds until the server returns.
                </Text>
              </Paper>
            ) : null}
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
                  disabled={!serverOnline || !String(inputUrl || '').trim()}
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
                </Tabs.List>

                <Tabs.Panel value="dvr" pt="xs">
                  <Text>DVR HLS playback with VTT overlay</Text>
                  <Group mt="xs" align="flex-start" grow wrap="wrap">
                    <Paper p="sm" withBorder style={{ flex: 2, minWidth: 320 }}>
                      <Group gap="xs" mb="xs">
                        <Text size="sm" c="dimmed">Status: {dvrStatus}</Text>
                        <Badge color={dvrBadge.color} variant="light">{dvrBadge.label}</Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mb="xs">
                        source: {dvrDiag.currentSrc || 'n/a'} | playlist: {dvrDiag.currentPlaylistUri || dvrDiag.currentPlaylistResolvedUri || 'n/a'}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        segment: {dvrDiag.currentSegmentSequence != null ? dvrDiag.currentSegmentSequence : 'n/a'}{dvrDiag.currentSegmentUri ? ` (${dvrDiag.currentSegmentUri})` : ''} | subtitle: {dvrDiag.currentSubtitleUri || 'n/a'}
                      </Text>
                      {dvrDiag.error ? (
                        <Text size="xs" c="red" mb="xs">error: {dvrDiag.error}</Text>
                      ) : null}
                      <div ref={dvrVideoHostRef} style={{ width: '100%', minHeight: '180px' }} />
                      {activeTab === 'dvr' && hlsMediaLoaded ? (
                        <Group mt="xs">
                          <Button variant="light" onClick={seekHlsToStart}>Play From Start</Button>
                          <Button variant="light" onClick={() => seekHlsBySeconds(-15)}>Rewind 15s</Button>
                          <Button variant="light" onClick={toggleHlsPlayPause}>Pause / Play</Button>
                          <Button variant="light" onClick={() => seekHlsBySeconds(15)}>FF 15s</Button>
                          <Button variant="light" onClick={seekHlsToEnd}>Go To End</Button>
                        </Group>
                      ) : null}
                    </Paper>
                    <Paper p="sm" withBorder style={{ flex: 1, minWidth: 280 }}>
                      <Text size="sm" fw={600}>VTT Overlay</Text>
                      {dvrOverlayEntries.length ? (
                        <Stack gap={4} mt="xs">
                          {dvrOverlayEntries.map(([key, value]) => (
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
                          No VTT overlay data yet.
                        </Text>
                      )}
                    </Paper>
                  </Group>
                </Tabs.Panel>

                <Tabs.Panel value="live-webrtc" pt="xs">
                  <Text>Live video via WebRTC</Text>
                  <Group mt="xs" align="flex-start" grow wrap="wrap">
                    <Paper p="sm" withBorder style={{ flex: 2, minWidth: 320 }}>
                      <Group gap="xs" mb="xs">
                        <Text size="sm" c="dimmed">Status: {liveStatus}</Text>
                        <Badge color={webrtcBadge.color} variant="light">{webrtcBadge.label}</Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mb="xs">
                        producerScore: {webrtcDiag.producerScore ?? 'n/a'} | consumerScore: {webrtcDiag.consumerScore ?? 'n/a'} | layers: {webrtcDiag.currentLayers ? JSON.stringify(webrtcDiag.currentLayers) : 'n/a'}
                      </Text>
                      <video ref={liveVideoRef} muted playsInline autoPlay style={{ width: '100%', maxHeight: '400px' }}></video>
                    </Paper>
                    <Paper p="sm" withBorder style={{ flex: 1, minWidth: 280 }}>
                      <Text size="sm" fw={600}>Live KLV Overlay</Text>
                      {liveKlvOverlayEntries.length ? (
                        <Stack gap={4} mt="xs">
                          {liveKlvOverlayEntries.map(([key, value]) => (
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
                          No live KLV overlay data yet.
                        </Text>
                      )}
                    </Paper>
                  </Group>
                </Tabs.Panel>
              </Tabs>
            </Paper>

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
                <Text size="sm" mt="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {statusParsed.text || 'No status yet.'}
                </Text>
              )}
            </Paper>
          </Stack>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
