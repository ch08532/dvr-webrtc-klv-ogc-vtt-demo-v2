import '@mantine/core/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AppShell, Text, Tabs, TextInput, NumberInput, Button, Group, Stack, Paper, Badge, Switch, Collapse, Select, FileInput, Progress } from '@mantine/core';
import { Device } from 'mediasoup-client';
import { HLS_RENDITIONS } from './hls_ladder.js';
import KlvMap from './KlvMap.jsx';

const theme = createTheme({
  /** Put your mantine theme override here */
});

function hlsQualityOptionsFor(renditions) {
  return [
    { value: 'auto', label: 'Auto (adaptive)' },
    ...[...renditions].sort((a, b) => a.bandwidth - b.bandwidth).map((rendition) => ({
      value: rendition.id,
      label: rendition.playlist === 'v2/index.m3u8'
        ? 'Low (90p)'
        : rendition.playlist === 'v0/index.m3u8'
          ? 'Medium (360p)'
          : `High (${rendition.id}${rendition.sourceCopy ? ', source copy' : ''})`
  }))
  ];
}

function emptyWebRtcDiag() {
  return {
    consumerId: null,
    producerScore: null,
    consumerScore: null,
    currentLayers: null,
    browser: null,
    error: null
  };
}

function App() {
  const [streamId, setStreamId] = useState('stream1');
  const [sourceType, setSourceType] = useState('stream');
  const [inputUrl, setInputUrl] = useState('udp://239.1.2.3:5000');
  const [videoFile, setVideoFile] = useState(null);
  const [hlsMode, setHlsMode] = useState('passthrough');
  const [webRtcMode, setWebRtcMode] = useState('auto');
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
  const [dvrTelemetryTab, setDvrTelemetryTab] = useState('map');
  const [liveTelemetryTab, setLiveTelemetryTab] = useState('map');
  const [autoAttachOnDvr, setAutoAttachOnDvr] = useState(false);
  const [hlsMediaLoaded, setHlsMediaLoaded] = useState(false);
  const [hlsQuality, setHlsQuality] = useState('auto');
  const [hlsQualityControlAvailable, setHlsQualityControlAvailable] = useState(false);
  const [dvrStatus, setDvrStatus] = useState('Idle');
  const [clipStartSeconds, setClipStartSeconds] = useState(0);
  const [clipEndSeconds, setClipEndSeconds] = useState(0);
  const [clipInFlight, setClipInFlight] = useState(false);
  const [clipResult, setClipResult] = useState(null);
  const [fileStartProgress, setFileStartProgress] = useState(null);
  const [dvrDiag, setDvrDiag] = useState({
    currentSrc: null,
    currentPlaylistUri: null,
    currentPlaylistResolvedUri: null,
    currentSegmentSequence: null,
    currentSegmentUri: null,
    currentSubtitleUri: null,
    currentTimeSec: null,
    durationSec: null,
    seekStartSec: null,
    seekEndSec: null,
    decodedVideoWidth: null,
    decodedVideoHeight: null,
    error: null
  });
  const [liveStatus, setLiveStatus] = useState('Idle');
  const [webrtcDiag, setWebrtcDiag] = useState(emptyWebRtcDiag);
  const [startRequestInFlight, setStartRequestInFlight] = useState(false);
  const [stopRequestInFlight, setStopRequestInFlight] = useState(false);
  const [serverOnline, setServerOnline] = useState(true);
  const [streamRuntime, setStreamRuntime] = useState({ streamId: 'stream1', state: 'stopped', running: false, lastError: null });
  const [sourcesList, setSourcesList] = useState([]);
  const [hostMetrics, setHostMetrics] = useState(null);
  const hlsRuntimeIsActive = !['stopped', 'stopping', 'error', 'offline'].includes(streamRuntime?.state);
  const activeHlsMode = hlsRuntimeIsActive
    ? streamRuntime?.hlsEffectiveMode || streamRuntime?.hlsMode || hlsMode
    : hlsMode;
  const activeHlsRenditions = Array.isArray(streamRuntime?.hlsRenditions) && streamRuntime.hlsRenditions.length
    ? streamRuntime.hlsRenditions
    : HLS_RENDITIONS;
  const passthroughFallbackLikely = hlsMode === 'passthrough'
    && !!inputProbe.video?.codec
    && inputProbe.video.codec.toLowerCase() !== 'h264';
  const hlsQualityOptions = activeHlsMode === 'abr'
    ? hlsQualityOptionsFor(activeHlsRenditions)
    : [{ value: 'auto', label: 'Auto (source)' }];

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
  const hlsStallTimerRef = useRef(null);
  const hlsRecoveryTimerRef = useRef(null);
  const hlsRecoveryPendingRef = useRef(false);
  const hlsQualityRef = useRef('auto');
  const appliedHlsQualityRef = useRef({ player: null, quality: null, representations: null });
  const clipRangeStreamRef = useRef(null);
  const clipDragBoundaryRef = useRef(null);
  const clipTrimShellRef = useRef(null);
  const webrtcRetryTimerRef = useRef(null);
  const webrtcRetryTokenRef = useRef(0);
  const webrtcTransportRef = useRef(null);
  const webrtcConsumerRef = useRef(null);
  const webrtcMediaStreamRef = useRef(null);
  const webrtcStreamIdRef = useRef(null);
  const webrtcBrowserStatsRef = useRef(null);
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
      currentTimeSec: null,
      durationSec: null,
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
      currentTimeSec: null,
      durationSec: null,
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
      const isBackendApiPath = /^\/(sources|uploads|webrtc|streams|probe|metrics|healthz|ogc)(\/|$)/.test(urlText);
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
    if (state === 'starting' || state === 'stopping' || state === 'finalizing') return 'yellow';
    if (state === 'ready') return 'blue';
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

  const isStartBlockedByState = ['starting', 'running', 'degraded', 'stopping', 'ready'].includes(streamRuntime?.state);
  const isStopBlockedByState = ['starting', 'stopping', 'stopped'].includes(streamRuntime?.state);
  const hasSelectedInput = sourceType === 'file' ? !!videoFile : !!String(inputUrl || '').trim();
  const canStartSource = serverOnline && hasSelectedInput && !startRequestInFlight && !stopRequestInFlight && !isStartBlockedByState;
  const canStopSource = serverOnline && !startRequestInFlight && !stopRequestInFlight && !isStopBlockedByState;
  const currentSourceIsFile = streamRuntime?.sourceType === 'file';
  const clipSourceIsActive = currentSourceIsFile && !['stopping', 'stopped', 'error', 'offline'].includes(streamRuntime?.state);
  const sourceDurationSeconds = Number(streamRuntime?.durationSeconds);
  const clipTimelineEndSeconds = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
    ? sourceDurationSeconds
    : null;
  const clipDurationSeconds = Math.max(0, clipEndSeconds - clipStartSeconds);
  const liveDvrWindowSeconds = !currentSourceIsFile
    && Number.isFinite(dvrDiag.seekStartSec)
    && Number.isFinite(dvrDiag.seekEndSec)
    ? Math.max(0, Number(dvrDiag.seekEndSec) - Number(dvrDiag.seekStartSec))
    : null;
  const liveBehindSeconds = !currentSourceIsFile
    && Number.isFinite(dvrDiag.currentTimeSec)
    && Number.isFinite(dvrDiag.seekEndSec)
    ? Math.max(0, Number(dvrDiag.seekEndSec) - Number(dvrDiag.currentTimeSec))
    : null;
  const hlsCodedDimensions = (() => {
    const sourceWidth = Number(streamRuntime?.sourceVideo?.width);
    const sourceHeight = Number(streamRuntime?.sourceVideo?.height);
    if (activeHlsMode === 'passthrough' || activeHlsMode === 'single-transcode') {
      return Number.isFinite(sourceWidth) && sourceWidth > 0 && Number.isFinite(sourceHeight) && sourceHeight > 0
        ? `${sourceWidth}×${sourceHeight}`
        : 'n/a';
    }

    const playlistUri = String(dvrDiag.currentPlaylistUri || dvrDiag.currentPlaylistResolvedUri || '');
    const rendition = activeHlsRenditions.find((item) => playlistUri.includes(item.playlist));
    return rendition?.width && rendition?.height ? `${rendition.width}×${rendition.height}` : 'n/a';
  })();
  const clipWidgetReady = Boolean(
    currentSourceIsFile
    && hlsMediaLoaded
    && Number.isFinite(clipTimelineEndSeconds)
    && clipTimelineEndSeconds >= 0.25
  );
  const clipExportReady = clipWidgetReady && streamRuntime?.state === 'ready';

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
  const webRtcBrowserStats = webrtcDiag.browser;

  const dvrBadge = (() => {
    if (dvrDiag.error) return { color: 'red', label: 'Playback Error' };
    if (/playing/i.test(dvrStatus)) return { color: 'green', label: 'Media Flowing' };
    if (/waiting|buffering|loading|connecting|seeking/i.test(dvrStatus)) return { color: 'yellow', label: 'Buffering' };
    if (/paused/i.test(dvrStatus)) return { color: 'gray', label: 'Paused' };
    if (/ended/i.test(dvrStatus)) return { color: 'orange', label: 'Ended' };
    if (hlsMediaLoaded) return { color: 'green', label: 'Media Ready' };
    return { color: 'gray', label: 'No Media' };
  })();

  const hasActiveKlvFlow = (runtime) => Boolean(runtime?.running && runtime?.klvRunning);
  // File conversion can enter finalization after HLS has stopped. Preserve the
  // latest valid cue during that phase and after the VTT sidecars are complete.
  const hasCompletedFileDvrTelemetry = (runtime) => Boolean(
    runtime?.sourceType === 'file' && ['finalizing', 'ready'].includes(runtime?.state)
  );
  const hasDvrKlvTelemetry = (runtime) => hasActiveKlvFlow(runtime) || hasCompletedFileDvrTelemetry(runtime);

  const refreshStreamState = async (targetStreamId = streamId, { updateStatus = false } = {}) => {
    if (!targetStreamId) return;
    const result = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
    if (result?.streamId) {
      streamRuntimeRef.current = result;
      setStreamRuntime(result);
      if (!hasDvrKlvTelemetry(result)) setOverlayData(null);
      if (result.running || result.state === 'ready') setAutoAttachOnDvr(true);
      if (!result.running && result.state !== 'ready') setAutoAttachOnDvr(false);
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

  const clearHlsStallTimer = () => {
    if (hlsStallTimerRef.current) {
      clearTimeout(hlsStallTimerRef.current);
      hlsStallTimerRef.current = null;
    }
  };

  const clearHlsRecoveryTimer = () => {
    if (hlsRecoveryTimerRef.current) {
      clearTimeout(hlsRecoveryTimerRef.current);
      hlsRecoveryTimerRef.current = null;
    }
    hlsRecoveryPendingRef.current = false;
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
    clearHlsStallTimer();
    clearHlsRecoveryTimer();
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
    setHlsQualityControlAvailable(false);
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
    try {
      const masterRes = await fetch(masterUrl, { cache: 'no-store' });
      if (!masterRes.ok) return false;
      const masterText = await masterRes.text();
      const masterLines = masterText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const streamInfoIndex = masterLines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
      const variantPath = streamInfoIndex >= 0
        ? masterLines.slice(streamInfoIndex + 1).find((line) => !line.startsWith('#'))
        : null;
      if (!variantPath) return false;

      // The browser plays a rendition under v*/index.m3u8, not the private
      // KLV carrier playlist. Wait until that exact rendition has a published
      // media segment so the first VHS request cannot race FFmpeg output.
      const variantUrl = new URL(variantPath, `${window.location.origin}${root}/master.m3u8`);
      variantUrl.searchParams.set('_', String(token));
      const variantRes = await fetch(variantUrl, { cache: 'no-store' });
      if (!variantRes.ok) return false;
      const variantText = await variantRes.text();
      const variantLines = variantText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const segmentInfoIndex = variantLines.reduce(
        (lastIndex, line, index) => (line.startsWith('#EXTINF') ? index : lastIndex),
        -1
      );
      const segmentPath = segmentInfoIndex >= 0
        ? variantLines.slice(segmentInfoIndex + 1).find((line) => !line.startsWith('#'))
        : null;
      if (!variantText.includes('#EXTM3U') || !segmentPath) return false;

      const segmentUrl = new URL(segmentPath, variantUrl);
      const segmentRes = await fetch(segmentUrl, { method: 'HEAD', cache: 'no-store' });
      return segmentRes.ok;
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
    webrtcBrowserStatsRef.current = null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
  };

  const clearWebRtcDiag = () => {
    webrtcBrowserStatsRef.current = null;
    setWebrtcDiag(emptyWebRtcDiag());
  };

  // XMLHttpRequest supplies upload progress; fetch does not expose it in browsers.
  const uploadVideoFile = (file) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/uploads/video');
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.setRequestHeader('x-upload-filename', encodeURIComponent(file.name));
    request.responseType = 'text';
    request.upload.onprogress = (event) => {
      setFileStartProgress({
        phase: 'uploading',
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : file.size
      });
    };
    request.onerror = () => reject(new Error('Video upload failed (network error)'));
    request.onload = () => {
      let result = null;
      try { result = JSON.parse(request.responseText || '{}'); } catch {}
      if (request.status >= 200 && request.status < 300) {
        markServerOnline();
        resolve(result || {});
        return;
      }
      reject(new Error(result?.error || `Video upload failed (HTTP ${request.status})`));
    };
    request.send(file);
  });

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
    setFileStartProgress(null);
    setHlsMediaLoaded(false);
    hlsQualityRef.current = 'auto';
    setHlsQuality('auto');
    setHlsQualityControlAvailable(false);
    setStreamRuntime({ streamId, sourceType, state: 'starting', running: false, lastError: null });
    try {
      let assetId = null;
      if (sourceType === 'file') {
        clipRangeStreamRef.current = null;
        setClipStartSeconds(0);
        setClipEndSeconds(0);
        setClipResult(null);
        setFileStartProgress({ phase: 'uploading', loadedBytes: 0, totalBytes: videoFile.size });
        setStatus(`Uploading ${videoFile.name}...`);
        const uploadResult = await uploadVideoFile(videoFile);
        if (!uploadResult?.ok || !uploadResult.assetId) {
          throw new Error(uploadResult?.error || 'Video upload failed');
        }
        assetId = uploadResult.assetId;
        setFileStartProgress({ phase: 'analyzing', loadedBytes: videoFile.size, totalBytes: videoFile.size });
        setStatus('Upload complete. Analyzing video streams and KLV metadata...');
        setActiveTab('dvr');
      }
      if (sourceType === 'file') setStatus('Starting file conversion and KLV processing...');
      const result = await api("/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamId,
          sourceType,
          inputUrl: sourceType === 'stream' ? inputUrl : undefined,
          assetId,
          hlsMode,
          webRtcMode,
          hlsSegmentSeconds,
          vttSegmentSeconds: hlsSegmentSeconds,
          maxCuesPerSecond,
          minCueDurSec,
          maxCueDurSec,
          purgeBeforeStart
        })
      });
      setFileStartProgress(null);
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
      if (result?.ok && sourceType !== 'file' && activeTab === 'live-webrtc') {
        startWebRtcAutoAttach(streamId);
      }
    } catch (error) {
      setFileStartProgress(null);
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
    clipRangeStreamRef.current = null;
    setClipStartSeconds(0);
    setClipEndSeconds(0);
    setClipResult(null);
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
        currentTimeSec: null,
        durationSec: null,
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

  const refreshHostMetrics = async () => {
    const result = await api('/metrics/runtime');
    if (result?.host) setHostMetrics(result.host);
  };

  const refreshWebRtcDebug = async (targetStreamId = streamId) => {
    if (!targetStreamId) return;
    const result = await api('/webrtc/debug');
    if (!result?.ok || !result?.snapshot) {
      const message = String(result?.error || 'debug unavailable');
      if (/SFU client not initialized|SFU worker is not running/i.test(message)) {
        setWebrtcDiag(emptyWebRtcDiag());
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
    const localConsumerId = webrtcConsumerRef.current?.id || null;
    const c = consumers.find((x) => x.consumerId === localConsumerId)
      || consumers.find((x) => x.streamId === targetStreamId)
      || null;

    setWebrtcDiag((prev) => ({
      ...prev,
      consumerId: c?.consumerId || null,
      producerScore: Number.isFinite(c?.score?.producerScore) ? c.score.producerScore : null,
      consumerScore: Number.isFinite(c?.score?.score) ? c.score.score : null,
      currentLayers: c?.currentLayers ?? null,
      error: null
    }));
  };

  const refreshWebRtcBrowserStats = async () => {
    const consumer = webrtcConsumerRef.current;
    if (!consumer || consumer.closed || typeof consumer.getStats !== 'function') return;

    try {
      const report = await consumer.getStats();
      if (webrtcConsumerRef.current !== consumer) return;
      const values = report && typeof report.values === 'function' ? Array.from(report.values()) : [];
      const inbound = values.find((stat) => (
        stat?.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')
      ));
      if (!inbound) return;

      const value = (name) => {
        const number = Number(inbound[name]);
        return Number.isFinite(number) ? number : null;
      };
      const timestamp = value('timestamp') ?? performance.now();
      const previous = webrtcBrowserStatsRef.current;
      const elapsedSec = previous && timestamp > previous.timestamp
        ? (timestamp - previous.timestamp) / 1000
        : null;
      const delta = (name) => {
        const current = value(name);
        const prior = previous?.[name];
        return current != null && prior != null ? Math.max(0, current - prior) : null;
      };
      const bytesDelta = delta('bytesReceived');
      const bitrateKbps = bytesDelta != null && elapsedSec && elapsedSec > 0
        ? Math.round((bytesDelta * 8) / elapsedSec / 1000)
        : null;

      const sample = {
        timestamp,
        bytesReceived: value('bytesReceived'),
        packetsLost: value('packetsLost'),
        packetsReceived: value('packetsReceived'),
        framesDecoded: value('framesDecoded'),
        framesRendered: value('framesRendered'),
        framesDropped: value('framesDropped'),
        freezeCount: value('freezeCount'),
        totalFreezesDuration: value('totalFreezesDuration')
      };
      webrtcBrowserStatsRef.current = sample;

      setWebrtcDiag((prev) => ({
        ...prev,
        browser: {
          frameWidth: value('frameWidth'),
          frameHeight: value('frameHeight'),
          framesPerSecond: value('framesPerSecond'),
          framesDecoded: sample.framesDecoded,
          framesRendered: sample.framesRendered,
          framesDropped: sample.framesDropped,
          decodedSinceLast: delta('framesDecoded'),
          renderedSinceLast: delta('framesRendered'),
          droppedSinceLast: delta('framesDropped'),
          packetsLost: sample.packetsLost,
          packetsReceived: sample.packetsReceived,
          lostSinceLast: delta('packetsLost'),
          jitterMs: value('jitter') != null ? Math.round(value('jitter') * 1000 * 10) / 10 : null,
          bitrateKbps,
          freezeCount: sample.freezeCount,
          freezeSeconds: sample.totalFreezesDuration != null ? Math.round(sample.totalFreezesDuration * 10) / 10 : null
        }
      }));
    } catch {
      // The receiver can disappear while the transport is reconnecting.
    }
  };

  const showOverlay = (obj, scopeTab = null) => {
    if (scopeTab && activeTabRef.current !== scopeTab) return;
    const canShow = scopeTab === 'dvr'
      ? hasDvrKlvTelemetry(streamRuntimeRef.current)
      : hasActiveKlvFlow(streamRuntimeRef.current);
    if (!canShow) return;
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

  const getActiveHlsPlayer = () => {
    if (!window.player || window.player.isDisposed?.()) return null;
    return window.player;
  };

  const getHlsRepresentations = (player = getActiveHlsPlayer()) => {
    if (!player) return [];
    try {
      const tech = player.tech?.({ IWillNotUseThisInPlugins: true });
      const representations = tech?.vhs?.representations?.();
      return Array.isArray(representations) ? representations : [];
    } catch {
      return [];
    }
  };

  const applyHlsQuality = (quality) => {
    if (activeHlsMode !== 'abr') {
      setHlsQualityControlAvailable(false);
      return quality === 'auto';
    }
    const representations = getHlsRepresentations();
    if (!representations.length) {
      setHlsQualityControlAvailable(false);
      return false;
    }

    // Enabling VHS representations can cause a rendition transition.  Do not
    // repeat that work for the same player and representation set when the
    // browser emits follow-up canplay/metadata events during the transition.
    const player = getActiveHlsPlayer();
    const representationSignature = representations
      .map((representation) => `${representation.id || ''}:${representation.width || 0}x${representation.height || 0}`)
      .sort()
      .join('|');
    const alreadyApplied = appliedHlsQualityRef.current;
    if (
      alreadyApplied.player === player
      && alreadyApplied.quality === quality
      && alreadyApplied.representations === representationSignature
    ) {
      setHlsQualityControlAvailable(true);
      return true;
    }

    const target = activeHlsRenditions.find((rendition) => rendition.id === quality);
    let matched = quality === 'auto';
    for (const representation of representations) {
      const enabled = quality === 'auto' || (
        representation.width === target?.width && representation.height === target?.height
      );
      if (enabled) matched = true;
      try { representation.enabled(enabled); } catch {}
    }
    if (!matched) {
      for (const representation of representations) {
        try { representation.enabled(true); } catch {}
      }
    }
    appliedHlsQualityRef.current = {
      player,
      quality,
      representations: representationSignature
    };
    setHlsQualityControlAvailable(true);
    return matched;
  };

  const handleHlsQualityChange = (value) => {
    const quality = value || 'auto';
    hlsQualityRef.current = quality;
    setHlsQuality(quality);
    applyHlsQuality(quality);
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

  // Live playlists retain history for DVR, so explicitly choose the live edge
  // on initial stream playback. File sources remain VOD and start at zero.
  const seekHlsToLivePosition = (player) => {
    if (!player || player.isDisposed?.()) return;
    const { start, end } = getHlsSeekBounds(player);
    const trackerTime = Number(player.liveTracker?.liveCurrentTime?.());
    const target = Number.isFinite(trackerTime)
      ? clampToBounds(trackerTime, start, end)
      : end;
    if (Number.isFinite(target)) player.currentTime(target);
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

  const previewClipTime = (seconds) => {
    const player = getActiveHlsPlayer();
    if (!player) return;
    const { start, end } = getHlsSeekBounds(player);
    player.currentTime(clampToBounds(seconds, start, end));
  };

  const updateClipBoundary = (boundary, rawValue) => {
    const timelineEnd = clipTimelineEndSeconds;
    const value = Number(rawValue);
    if (!Number.isFinite(timelineEnd) || timelineEnd <= 0 || !Number.isFinite(value)) return;
    const minDuration = 0.25;
    if (boundary === 'start') {
      const next = Math.max(0, Math.min(value, clipEndSeconds - minDuration));
      setClipStartSeconds(next);
      previewClipTime(next);
    } else {
      const next = Math.min(timelineEnd, Math.max(value, clipStartSeconds + minDuration));
      setClipEndSeconds(next);
      previewClipTime(next);
    }
  };

  const clipTimeFromPointerEvent = (event) => {
    const timelineEnd = clipTimelineEndSeconds;
    const rect = clipTrimShellRef.current?.getBoundingClientRect();
    if (!Number.isFinite(timelineEnd) || timelineEnd <= 0 || !rect || rect.width <= 0) return null;
    const position = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    return (position / rect.width) * timelineEnd;
  };

  const beginClipPointerDrag = (event, forcedBoundary = null) => {
    if (!clipWidgetReady) return;
    const time = clipTimeFromPointerEvent(event);
    if (time == null) return;
    const boundary = forcedBoundary || (Math.abs(time - clipStartSeconds) <= Math.abs(time - clipEndSeconds)
      ? 'start'
      : 'end');
    clipDragBoundaryRef.current = boundary;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateClipBoundary(boundary, time);
  };

  const moveClipPointerDrag = (event) => {
    const boundary = clipDragBoundaryRef.current;
    if (!boundary) return;
    const time = clipTimeFromPointerEvent(event);
    if (time != null) updateClipBoundary(boundary, time);
  };

  const endClipPointerDrag = (event) => {
    if (!clipDragBoundaryRef.current) return;
    clipDragBoundaryRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const setClipBoundaryAtPlayhead = (boundary) => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus('HLS player is not ready.');
      return;
    }
    updateClipBoundary(boundary, Number(player.currentTime?.() || 0));
  };

  const createClip = async () => {
    if (!currentSourceIsFile || streamRuntime?.state !== 'ready') {
      setStatus('Clipping is available only after an uploaded video is ready.');
      return;
    }
    setClipInFlight(true);
    setClipResult(null);
    try {
      const result = await api(`/sources/${encodeURIComponent(streamId)}/clips`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startSeconds: clipStartSeconds, endSeconds: clipEndSeconds })
      });
      if (!result?.ok || !result?.clip?.downloadUrl) {
        throw new Error(result?.error || 'Clip creation failed');
      }
      setClipResult(result.clip);
      setStatus(`Clip ready: ${result.clip.filename}. Video copied at keyframe boundaries; KLV embedded: ${result.clip.klvEmbedded ? 'yes' : 'not present in source'}.`);
      const download = document.createElement('a');
      download.href = result.clip.downloadUrl;
      download.download = result.clip.filename;
      document.body.appendChild(download);
      download.click();
      download.remove();
    } catch (error) {
      setStatus(`Clip creation failed: ${String(error?.message || error)}`);
    } finally {
      setClipInFlight(false);
    }
  };

  const formatPlayerTime = (seconds) => {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return 'n/a';
    return `${n.toFixed(2)}s`;
  };

  const formatConversionTime = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 'n/a';
    const totalSeconds = Math.round(value);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
      : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  const formatBytes = (bytes) => {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return 'n/a';
    return (value / (1024 ** 3)).toFixed(1) + ' GB';
  };

  const conversionProgress = (source) => {
    const percent = Number(source?.progressPercent);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  };

  const klvProbeStatus = (source) => {
    const probe = source?.klvProbe;
    if (!probe) return { color: 'gray', label: 'KLV analysis unavailable' };
    const count = Number(probe.streamCount);
    const suffix = Number.isFinite(count) && count > 0 ? ` (${count} stream${count === 1 ? '' : 's'})` : '';
    if (probe.confidence === 'high') return { color: 'teal', label: `KLV detected${suffix}` };
    if (probe.available) return { color: 'yellow', label: `Possible KLV${suffix}` };
    return { color: 'gray', label: 'No KLV found' };
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
        currentSubtitleUri: null,
        currentTimeSec: null,
        durationSec: null,
        seekStartSec: null,
        seekEndSec: null
      };
    }

    let currentPlaylistUri = null;
    let currentPlaylistResolvedUri = null;
    let currentSegmentSequence = null;
    let currentSegmentUri = null;
    let currentSubtitleUri = null;
    let currentTimeSec = null;
    let durationSec = null;
    let seekStartSec = null;
    let seekEndSec = null;
    let decodedVideoWidth = null;
    let decodedVideoHeight = null;
    try {
      const now = Number(p.currentTime?.());
      if (Number.isFinite(now)) currentTimeSec = now;
      const dur = Number(p.duration?.());
      const seekBoundsNow = getHlsSeekBounds(p);
      const seekStartNow = Number(seekBoundsNow?.start);
      const seekEndNow = Number(seekBoundsNow?.end);
      if (Number.isFinite(seekStartNow)) seekStartSec = seekStartNow;
      if (Number.isFinite(seekEndNow)) seekEndSec = seekEndNow;
      const seekWindowDur = Number.isFinite(seekStartNow) && Number.isFinite(seekEndNow)
        ? Math.max(0, seekEndNow - seekStartNow)
        : null;
      if (Number.isFinite(dur) && dur > 0) {
        durationSec = dur;
      } else if (Number.isFinite(seekWindowDur) && seekWindowDur > 0) {
        durationSec = seekWindowDur;
      } else if (Number.isFinite(now) && now > 0) {
        durationSec = now;
      }

      const tech = p.tech?.({ IWillNotUseThisInPlugins: true });
      const videoEl = tech?.el?.() || p.el?.()?.querySelector?.('video');
      const videoWidth = Number(videoEl?.videoWidth);
      const videoHeight = Number(videoEl?.videoHeight);
      if (Number.isFinite(videoWidth) && videoWidth > 0) decodedVideoWidth = videoWidth;
      if (Number.isFinite(videoHeight) && videoHeight > 0) decodedVideoHeight = videoHeight;
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
      currentSubtitleUri,
      currentTimeSec,
      durationSec,
      seekStartSec,
      seekEndSec,
      decodedVideoWidth,
      decodedVideoHeight
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
      currentSubtitleUri: info.currentSubtitleUri,
      currentTimeSec: info.currentTimeSec,
      durationSec: info.durationSec,
      seekStartSec: info.seekStartSec,
      seekEndSec: info.seekEndSec,
      decodedVideoWidth: info.decodedVideoWidth,
      decodedVideoHeight: info.decodedVideoHeight
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

  // A fresh VHS instance is required after some playlist/segment failures;
  // calling play() again on the same instance can leave it stuck buffering.
  const scheduleHlsRecovery = (targetStreamId, reason) => {
    if (streamRuntimeRef.current?.sourceType === 'file') return;
    if (activeTabRef.current !== 'dvr' || streamIdRef.current !== targetStreamId) return;
    if (hlsRecoveryPendingRef.current) return;

    hlsRecoveryPendingRef.current = true;
    clearHlsStallTimer();
    setHlsMediaLoaded(false);
    setDvrStatus(`Reconnecting HLS (${reason})...`);
    hlsRecoveryTimerRef.current = setTimeout(() => {
      hlsRecoveryTimerRef.current = null;
      hlsRecoveryPendingRef.current = false;
      if (!serverOnlineRef.current || activeTabRef.current !== 'dvr' || streamIdRef.current !== targetStreamId) return;
      clearDvrPlayerInstance();
      setDvrStatus('Reconnecting HLS...');
      startHlsAutoAttach(targetStreamId);
    }, 250);
  };

  const armHlsStallRecovery = (targetStreamId, player) => {
    if (streamRuntimeRef.current?.sourceType === 'file' || player?.paused?.()) return;
    clearHlsStallTimer();
    hlsStallTimerRef.current = setTimeout(() => {
      hlsStallTimerRef.current = null;
      if (window.player !== player || player?.isDisposed?.() || player?.paused?.()) return;
      scheduleHlsRecovery(targetStreamId, 'buffering timeout');
    }, 12_000);
  };

  const attachHlsDvr = (streamId, retryCount = 0) => {
    const maxRetries = 50; // Stop after 50 retries (~5 seconds)

    const url = `/hls/${encodeURIComponent(streamId)}/master.m3u8`;
    setHlsMediaLoaded(false);
    setHlsQualityControlAvailable(false);
    setDvrStatus('Connecting...');
    setDvrDiag({
      currentSrc: url,
      currentPlaylistUri: null,
      currentPlaylistResolvedUri: null,
      currentSegmentSequence: null,
      currentSegmentUri: null,
      currentSubtitleUri: null,
      currentTimeSec: null,
      durationSec: null,
      error: null
    });

    vttHookedRef.current = false;

    // Reuse existing player on tab switches if source is unchanged.
    if (window.player && !window.player.isDisposed?.()) {
      const currentSrc = String(window.player.currentSrc?.() || "");
      if (currentSrc.includes(url)) {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(hasLoadedHlsMedia(window.player));
        setDvrStatus(window.player.paused?.() ? 'Paused' : 'Playing');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(window.player);
        applyHlsQuality(hlsQualityRef.current);
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
        hostEl.appendChild(videoEl);
        videoRef.current = videoEl;
      }

      window.player = window.videojs(videoRef.current, {
        controls: true,
        liveui: true,
        fluid: true,
        aspectRatio: '16:9',
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
      const player = window.player;
      appliedHlsQualityRef.current = { player: null, quality: null, representations: null };

      player.src({
        src: url,
        type: 'application/x-mpegURL'
      });
      setHlsMediaLoaded(false);
      setDvrStatus('Loading playlist...');

      player.on('loadstart', () => {
        forceHideCaptionTracks(window.player);
        setHlsMediaLoaded(false);
        setDvrStatus('Loading playlist...');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(player);
      });
      player.on('loadedmetadata', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        forceHideCaptionTracks(player);
        // File-backed HLS is a VOD asset. Video.js can otherwise position at
        // the end of a full-history playlist as though it were live DVR.
        if (streamRuntimeRef.current?.sourceType === 'file') {
          const { start } = getHlsSeekBounds(player);
          player.currentTime(start);
        } else {
          seekHlsToLivePosition(player);
        }
        setHlsMediaLoaded(true);
        setDvrStatus('Ready');
        refreshDvrPlaybackInfo(player);
        applyHlsQuality(hlsQualityRef.current);
      });
      player.on('canplay', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        forceHideCaptionTracks(player);
        setHlsMediaLoaded(true);
        setDvrStatus('Ready');
        refreshDvrPlaybackInfo(player);
      });
      player.on('playing', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        setHlsMediaLoaded(true);
        setDvrStatus('Playing');
        setDvrDiag((prev) => ({ ...prev, error: null }));
        refreshDvrPlaybackInfo(player);
      });
      player.on('waiting', () => {
        if (window.player !== player) return;
        setDvrStatus('Buffering...');
        refreshDvrPlaybackInfo(player);
        armHlsStallRecovery(streamId, player);
      });
      player.on('stalled', () => {
        if (window.player !== player) return;
        setDvrStatus('Buffering...');
        armHlsStallRecovery(streamId, player);
      });
      player.on('seeking', () => {
        if (window.player !== player) return;
        setDvrStatus('Seeking...');
      });
      player.on('seeked', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        setDvrStatus(player.paused?.() ? 'Paused' : 'Playing');
        refreshDvrPlaybackInfo(player);
      });
      player.on('timeupdate', () => {
        if (window.player !== player) return;
        refreshDvrPlaybackInfo(player);
      });
      player.on('pause', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        if (!player.ended?.()) setDvrStatus('Paused');
      });
      player.on('ended', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        setDvrStatus('Ended');
      });
      player.on('emptied', () => {
        if (window.player !== player) return;
        clearHlsStallTimer();
        setHlsMediaLoaded(false);
        setDvrStatus('Idle');
      });
      player.on('dispose', () => {
        clearHlsStallTimer();
        setHlsMediaLoaded(false);
        setHlsQualityControlAvailable(false);
        setDvrStatus('Idle');
      });

      player.on('error', () => {
        if (window.player !== player) return;
        setHlsMediaLoaded(false);
        const err = player.error?.();
        const msg = err?.message || `code=${String(err?.code || 'n/a')}`;
        setDvrStatus('Playback error. Reconnecting...');
        setDvrDiag((prev) => ({ ...prev, error: msg }));
        refreshDvrPlaybackInfo(player);
        scheduleHlsRecovery(streamId, 'playback error');
      });

      player.ready(() => {
        if (window.player !== player) return;
        forceHideCaptionTracks(player);
        applyHlsQuality(hlsQualityRef.current);
        player.play().catch(() => {});
        refreshDvrPlaybackInfo(player);
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
      if (activeTabRef.current !== 'dvr') return;
      if (streamIdRef.current !== targetStreamId) return;
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
    if (streamRuntime?.sourceType === 'file' && activeTab === 'live-webrtc') {
      setActiveTab('dvr');
    }
    if (!hasDvrKlvTelemetry(streamRuntime)) {
      setOverlayData(null);
    }
    if (activeTab === 'live-webrtc' && !hasActiveKlvFlow(streamRuntime)) {
      setLiveNotConnected();
    }
  }, [streamRuntime, activeTab]);

  useEffect(() => {
    // A server restart or a new run can reuse stream1. Initialize as soon as
    // the file duration is known so trimming can begin during HLS packaging;
    // clip creation itself still waits until the source is ready.
    if (!currentSourceIsFile || !Number.isFinite(clipTimelineEndSeconds) || clipTimelineEndSeconds <= 0) {
      clipRangeStreamRef.current = null;
      return;
    }
    if (clipRangeStreamRef.current === streamId) return;
    clipRangeStreamRef.current = streamId;
    setClipStartSeconds(0);
    setClipEndSeconds(clipTimelineEndSeconds);
    setClipResult(null);
  }, [currentSourceIsFile, streamId, clipTimelineEndSeconds]);

  useEffect(() => {
    if (hlsQuality === 'auto') return;
    if (activeHlsRenditions.some((rendition) => rendition.id === hlsQuality)) return;
    hlsQualityRef.current = 'auto';
    setHlsQuality('auto');
    setHlsQualityControlAvailable(false);
  }, [activeHlsRenditions, hlsQuality]);

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
    refreshHostMetrics().catch(() => {});

    const timer = setInterval(() => {
      refreshSources({ silent: true }).catch(() => {});
      refreshStreamState(streamId).catch(() => {});
      refreshHostMetrics().catch(() => {});
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
    refreshWebRtcBrowserStats().catch(() => {});
    const timer = setInterval(() => {
      refreshWebRtcDebug(streamId).catch(() => {});
      refreshWebRtcBrowserStats().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [activeTab, streamId, serverOnline, streamRuntime?.running, streamRuntime?.ingestRunning]);

  const dvrOverlayEntries = overlayData?.mode === 'dvr-vtt'
    ? Object.entries(overlayData)
    : [];
  const liveKlvOverlayEntries = overlayData?.mode === 'live-ws'
    ? Object.entries(overlayData)
    : [];
  const activeHlsRendition = activeHlsMode === 'abr'
    ? activeHlsRenditions.find((rendition) => (
      [dvrDiag.currentPlaylistUri, dvrDiag.currentPlaylistResolvedUri]
        .filter(Boolean)
        .some((uri) => String(uri).includes(rendition.playlist))
    ))
    : null;
  const activeHlsRenditionLabel = activeHlsRendition
    ? `${activeHlsRendition.id} | ${activeHlsRendition.width}×${activeHlsRendition.height} | ${activeHlsRendition.sourceCopy ? 'source copy' : activeHlsRendition.videoBitrate}`
    : dvrDiag.currentPlaylistUri || dvrDiag.currentPlaylistResolvedUri
      ? activeHlsMode === 'single-transcode'
        ? 'single transcoded rendition'
        : 'source (single rendition)'
      : 'n/a';
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
                <Select
                  w={150}
                  label="Source type"
                  data={[{ value: 'stream', label: 'Stream URL' }, { value: 'file', label: 'Video file' }]}
                  value={sourceType}
                  onChange={(value) => setSourceType(value || 'stream')}
                  allowDeselect={false}
                />
                {sourceType === 'stream' ? <>
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
                </> : <FileInput
                  style={{ flex: 1 }}
                  label="Video file"
                  placeholder="Choose a video file"
                  value={videoFile}
                  onChange={setVideoFile}
                  accept="video/*,.ts,.m2ts"
                  clearable
                />}
              </Group>
              {sourceType === 'file' ? (
                <Text size="xs" mt="xs" c="dimmed">The file uploads to this server, then packages into HLS and segmented WebVTT. Playback is available in DVR (HLS); WebRTC is disabled.</Text>
              ) : null}
              {(inputProbe.container || inputProbe.video || inputProbe.klv || inputProbe.error) ? (
                <Text size="xs" mt="xs" c={inputProbe.error ? 'red' : 'dimmed'}>
                  {inputProbe.error
                    ? `Probe error: ${inputProbe.error}`
                    : `container: ${inputProbe.container?.longName || inputProbe.container?.name || 'unknown'} | video codec: ${inputProbe.video?.codecLongName || inputProbe.video?.codec || 'unknown'}${inputProbe.video?.width && inputProbe.video?.height ? ` | ${inputProbe.video.width}x${inputProbe.video.height}` : ''}${Number.isFinite(inputProbe.video?.fps) ? ` | ${inputProbe.video.fps} fps` : ''} | klv: ${inputProbe.klv?.available ? (inputProbe.klv?.confidence === 'high' ? 'detected' : 'possible (data stream found)') : 'not detected'}`}
                </Text>
              ) : null}
              <Group grow mt="xs">
                <Select
                  label="HLS mode"
                  description="Passthrough copies H.264 video and omits audio; other sources use one H.264 fallback stream. ABR creates three streams."
                  data={[
                    { value: 'passthrough', label: 'Passthrough (source quality)' },
                    { value: 'abr', label: 'Full ABR ladder' }
                  ]}
                  value={hlsMode}
                  onChange={(value) => {
                    const nextMode = value || 'passthrough';
                    setHlsMode(nextMode);
                    hlsQualityRef.current = 'auto';
                    setHlsQuality('auto');
                    setHlsQualityControlAvailable(false);
                  }}
                  allowDeselect={false}
                />
                <Select
                  label="Live WebRTC mode"
                  description="Auto copies H.264 when safe, otherwise it transcodes."
                  data={[
                    { value: 'auto', label: 'Auto-copy H.264 (recommended)' },
                    { value: 'copy', label: 'Force H.264 passthrough' },
                    { value: 'transcode', label: 'Force transcode' }
                  ]}
                  value={webRtcMode}
                  onChange={(value) => setWebRtcMode(value || 'auto')}
                  allowDeselect={false}
                  disabled={sourceType === 'file'}
                />
              </Group>
              {passthroughFallbackLikely ? (
                <Text size="xs" mt="xs" c="yellow">
                  Passthrough fallback: this source is not H.264, so one H.264 playback stream will be encoded. KLV remains copy-only.
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
                <Button onClick={startSource} disabled={!canStartSource} loading={startRequestInFlight}>Start Source</Button>
                <Button onClick={stopSource} color="red" disabled={!canStopSource}>Stop Source</Button>
              </Group>

              {fileStartProgress ? (
                <Stack gap={4} mt="xs">
                  {fileStartProgress.phase === 'uploading' ? (
                    <>
                      <Group justify="space-between">
                        <Text size="xs">Uploading video file…</Text>
                        <Text size="xs" c="dimmed">
                          {Number.isFinite(Number(fileStartProgress.totalBytes)) && fileStartProgress.totalBytes > 0
                            ? `${((fileStartProgress.loadedBytes / fileStartProgress.totalBytes) * 100).toFixed(1)}%`
                            : 'Starting…'}
                        </Text>
                      </Group>
                      <Progress
                        value={Number.isFinite(Number(fileStartProgress.totalBytes)) && fileStartProgress.totalBytes > 0
                          ? (fileStartProgress.loadedBytes / fileStartProgress.totalBytes) * 100
                          : 0}
                        animated
                      />
                      <Text size="xs" c="dimmed">
                        {formatBytes(fileStartProgress.loadedBytes)} / {formatBytes(fileStartProgress.totalBytes)} · Source setup starts once this transfer completes.
                      </Text>
                    </>
                  ) : (
                    <Group gap="xs">
                      <Badge color="yellow" variant="light">Preparing file</Badge>
                      <Text size="xs" c="dimmed">Upload complete. Analyzing video streams and KLV metadata…</Text>
                    </Group>
                  )}
                </Stack>
              ) : null}

              <Group mt="md" align="center">
                <Text size="sm">Current Stream State:</Text>
                <Badge color={stateColor(streamRuntime?.state)} variant="filled">
                  {streamRuntime?.state || 'unknown'}
                </Badge>
                {hlsRuntimeIsActive && streamRuntime?.encoder ? (
                  <Text size="sm" c={streamRuntime?.usingGpu ? 'teal' : 'orange'}>
                    Encoding: {streamRuntime.usingGpu ? 'GPU' : 'CPU'} ({streamRuntime.encoder})
                  </Text>
                  ) : null}
                <Text size="sm" c="dimmed">
                  HLS: {activeHlsMode} ({hlsRuntimeIsActive ? streamRuntime?.hlsEncoderMode || 'pending' : 'pending'})
                  {hlsRuntimeIsActive && streamRuntime?.hlsEffectiveMode && streamRuntime.hlsEffectiveMode !== streamRuntime.hlsMode
                    ? ` → ${streamRuntime.hlsEffectiveMode}`
                    : ''}
                  {(hlsRuntimeIsActive ? streamRuntime?.sourceType : sourceType) !== 'file'
                    ? ` | WebRTC: ${hlsRuntimeIsActive ? streamRuntime?.webRtcMode || webRtcMode : webRtcMode} (${hlsRuntimeIsActive ? streamRuntime?.webRtcEncoderMode || 'pending' : 'pending'})`
                    : ''}
                </Text>
              </Group>
              {streamRuntime?.sourceType === 'file' && streamRuntime?.state !== 'stopped' ? (
                <Stack gap={4} mt="xs">
                  <Group gap="xs">
                    {(() => {
                      const klvStatus = klvProbeStatus(streamRuntime);
                      return <Badge color={klvStatus.color} variant="light">{klvStatus.label}</Badge>;
                    })()}
                    <Text size="xs" c="dimmed">Based on the uploaded file&apos;s stream probe.</Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="xs">Conversion ({streamRuntime?.state || 'preparing'}): {conversionProgress(streamRuntime) != null ? `${conversionProgress(streamRuntime).toFixed(1)}%` : 'Preparing...'}</Text>
                    <Text size="xs" c="dimmed">
                      {formatConversionTime(streamRuntime.processedSeconds)} / {formatConversionTime(streamRuntime.durationSeconds)}
                      {Number.isFinite(Number(streamRuntime.encodeSpeed)) ? ` · ${Number(streamRuntime.encodeSpeed).toFixed(2)}x` : ''}
                      {Number.isFinite(Number(streamRuntime.etaSeconds)) ? ` · ETA ${formatConversionTime(streamRuntime.etaSeconds)}` : ''}
                    </Text>
                  </Group>
                  <Progress value={conversionProgress(streamRuntime) || 0} animated={streamRuntime?.state === 'running'} />
                </Stack>
              ) : null}
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
                      </Group>
                    </Group>
                    <Group mt="xs" align="flex-start" wrap="nowrap">
                      {s.posterUrl ? (
                        <img className="source-poster" src={s.posterUrl} alt={`Preview of ${s.streamId}`} />
                      ) : (
                        <div className="source-poster source-poster-placeholder">Preview pending</div>
                      )}
                      <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
                        <Text size="xs" c="dimmed">
                          type: {s.sourceType || 'stream'} | hls: {s.hlsRunning ? 'up' : 'down'} | klv: {s.klvRunning ? 'up' : 'down'} | ingest: {s.ingestRunning ? 'up' : 'down'}
                          {s.hlsMode ? ` | HLS mode: ${s.hlsMode}` : ''}
                          {s.hlsEffectiveMode && s.hlsEffectiveMode !== s.hlsMode ? ` → ${s.hlsEffectiveMode}` : ''}
                          {s.webRtcMode && s.sourceType !== 'file' ? ` | WebRTC mode: ${s.webRtcMode}` : ''}
                          {s.encoder ? ` | encoder: ${s.usingGpu ? 'GPU' : 'CPU'} (${s.encoder})` : ''}
                        </Text>
                        {s.sourceType === 'file' ? (
                          <>
                            {(() => {
                              const klvStatus = klvProbeStatus(s);
                              return <Badge color={klvStatus.color} variant="light" w="fit-content">{klvStatus.label}</Badge>;
                            })()}
                            <Text size="xs" c="dimmed">
                              conversion: {conversionProgress(s) != null ? `${conversionProgress(s).toFixed(1)}%` : 'preparing'} · {formatConversionTime(s.processedSeconds)} / {formatConversionTime(s.durationSeconds)}
                              {Number.isFinite(Number(s.encodeSpeed)) ? ` · ${Number(s.encodeSpeed).toFixed(2)}x` : ''}
                              {Number.isFinite(Number(s.etaSeconds)) ? ` · ETA ${formatConversionTime(s.etaSeconds)}` : ''}
                            </Text>
                            <Progress value={conversionProgress(s) || 0} animated={s.state === 'running'} size="sm" />
                          </>
                        ) : null}
                      </Stack>
                    </Group>
                  </Paper>
                )) : <Text size="sm" c="dimmed">No active sources</Text>}
              </Stack>
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Playback</Text>
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  <Tabs.Tab value="dvr">DVR (HLS)</Tabs.Tab>
                  <Tabs.Tab value="live-webrtc" disabled={currentSourceIsFile}>Live (WebRTC)</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="dvr" pt="xs">
                  <Text>DVR HLS playback with synchronized WebVTT telemetry.</Text>
                  <Group mt="xs" align="flex-start" grow wrap="wrap">
                    <Paper p="sm" withBorder style={{ flex: 2, minWidth: 320 }}>
                      <Group gap="xs" mb="xs">
                        <Text size="sm" c="dimmed">Status: {dvrStatus}</Text>
                        <Badge color={dvrBadge.color} variant="light">{dvrBadge.label}</Badge>
                      </Group>
                      <Group gap="xs" mb="xs" align="flex-end">
                        <Select
                          label="Video quality"
                          data={hlsQualityOptions}
                          value={hlsQuality}
                          onChange={handleHlsQualityChange}
                          allowDeselect={false}
                          disabled={activeHlsMode !== 'abr' || (hlsMediaLoaded && !hlsQualityControlAvailable)}
                          w={180}
                        />
                        <Text size="xs" c="dimmed" pb={6}>
                          {activeHlsMode === 'passthrough'
                            ? 'Passthrough uses the source rendition.'
                            : activeHlsMode === 'single-transcode'
                              ? 'A single browser-compatible H.264 rendition is available.'
                              : activeHlsMode !== 'abr'
                                ? 'A single rendition is available.'
                            : hlsQualityControlAvailable
                            ? 'Auto switches based on network conditions.'
                            : hlsMediaLoaded
                              ? 'Manual selection is unavailable with native HLS playback.'
                              : 'Manual selection becomes available when the HLS player is ready.'}
                        </Text>
                      </Group>
                      <Text size="xs" c="dimmed" mb="xs">
                        source: {dvrDiag.currentSrc || 'n/a'} | playlist: {dvrDiag.currentPlaylistUri || dvrDiag.currentPlaylistResolvedUri || 'n/a'}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        active rendition: {activeHlsRenditionLabel} | coded: {hlsCodedDimensions} | display: {dvrDiag.decodedVideoWidth && dvrDiag.decodedVideoHeight
                          ? `${dvrDiag.decodedVideoWidth}×${dvrDiag.decodedVideoHeight}`
                          : 'n/a'}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        segment: {dvrDiag.currentSegmentSequence != null ? dvrDiag.currentSegmentSequence : 'n/a'}{dvrDiag.currentSegmentUri ? ` (${dvrDiag.currentSegmentUri})` : ''} | subtitle: {dvrDiag.currentSubtitleUri || 'n/a'}
                      </Text>
                      {dvrDiag.error ? (
                        <Text size="xs" c="red" mb="xs">error: {dvrDiag.error}</Text>
                      ) : null}
                      <div ref={dvrVideoHostRef} style={{ width: '100%', minHeight: '180px' }} />
                       <Text size="xs" c="dimmed" mt="xs">
                         {currentSourceIsFile
                           ? `player time: ${formatPlayerTime(dvrDiag.currentTimeSec)} / ${formatPlayerTime(dvrDiag.durationSec)}`
                           : `Playback delay: ${formatPlayerTime(liveBehindSeconds)} behind HLS edge · DVR window: ${formatPlayerTime(liveDvrWindowSeconds)}`}
                       </Text>
                       {clipSourceIsActive ? (
                         <div className="clip-widget" aria-label="Video clip selection">
                           <Group justify="space-between" align="center" mb={4}>
                             <div>
                               <Text size="sm" fw={700}>Create video clip</Text>
                               <Text size="xs" c="dimmed">Drag either edge to preview a point in HLS. Exports snap to source keyframes without re-encoding.</Text>
                             </div>
                             <Badge color={streamRuntime?.klvProbe?.available ? 'teal' : 'gray'} variant="light">
                               {streamRuntime?.klvProbe?.available ? 'KLV preserved' : 'No KLV detected'}
                             </Badge>
                           </Group>
                           <div
                             ref={clipTrimShellRef}
                             className={`clip-trim-shell${clipWidgetReady ? '' : ' is-disabled'}`}
                             onPointerDown={beginClipPointerDrag}
                             onPointerMove={moveClipPointerDrag}
                             onPointerUp={endClipPointerDrag}
                             onPointerCancel={endClipPointerDrag}
                            >
                              <div className="clip-filmstrip" aria-hidden="true">
                               {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
                             </div>
                             {clipWidgetReady ? (
                               <>
                                 <div
                                   className="clip-selection"
                                   style={{
                                     left: `${(clipStartSeconds / clipTimelineEndSeconds) * 100}%`,
                                     width: `${(clipDurationSeconds / clipTimelineEndSeconds) * 100}%`
                                   }}
                                 />
                                  <button
                                    type="button"
                                    className="clip-drag-handle clip-drag-handle-start"
                                    style={{ left: `calc(${(clipStartSeconds / clipTimelineEndSeconds) * 100}% - 9px)` }}
                                    onPointerDown={(event) => beginClipPointerDrag(event, 'start')}
                                    aria-label="Clip start time"
                                  />
                                  <button
                                    type="button"
                                    className="clip-drag-handle clip-drag-handle-end"
                                    style={{ left: `calc(${(clipEndSeconds / clipTimelineEndSeconds) * 100}% - 9px)` }}
                                    onPointerDown={(event) => beginClipPointerDrag(event, 'end')}
                                    aria-label="Clip end time"
                                  />
                               </>
                             ) : null}
                           </div>
                           <Group justify="space-between" className="clip-time-readout">
                             <span><b>Start</b> {formatPlayerTime(clipStartSeconds)}</span>
                             <span><b>Length</b> {formatPlayerTime(clipDurationSeconds)}</span>
                             <span><b>End</b> {formatPlayerTime(clipEndSeconds)}</span>
                           </Group>
                           <Group mt="xs" gap="xs" wrap="wrap">
                             <Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('start')} disabled={!clipWidgetReady || clipInFlight}>Set start at playhead</Button>
                             <Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('end')} disabled={!clipWidgetReady || clipInFlight}>Set end at playhead</Button>
                             <Button size="xs" color="dark" onClick={createClip} loading={clipInFlight} disabled={!clipExportReady || clipDurationSeconds < 0.25}>
                               Create &amp; download clip
                             </Button>
                           </Group>
                           {!clipExportReady ? (
                             <Text size="xs" c="yellow" mt="xs">You can set clip boundaries now. Download becomes available when file packaging completes.</Text>
                           ) : null}
                           <Text size="xs" c="dimmed" mt="xs">
                             Downloads as MPEG-TS with copied video, audio, and KLV. Start positions snap to source keyframes; live streams cannot be clipped.
                           </Text>
                           {clipResult ? (
                             <Text size="xs" c="teal" mt={4}>Ready: {clipResult.filename} · keyframe copied · embedded KLV: {clipResult.klvEmbedded ? 'yes' : 'not present in source'}</Text>
                           ) : null}
                         </div>
                       ) : (
                         <Text size="xs" c="dimmed" mt="sm">Clip creation is available only for uploaded, file-backed video. Live streams remain view-only.</Text>
                       )}
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
                      <Text size="sm" fw={600}>VTT with KLV Telemetry</Text>
                      <Tabs value={dvrTelemetryTab} onChange={setDvrTelemetryTab} mt="xs">
                        <Tabs.List grow>
                          <Tabs.Tab value="data">Data</Tabs.Tab>
                          <Tabs.Tab value="map">Map</Tabs.Tab>
                        </Tabs.List>
                        <Tabs.Panel value="data" pt="xs">
                          {dvrOverlayEntries.length ? (
                            <Stack gap={4}>
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
                            <Text size="sm" c="dimmed">
                              No VTT overlay data yet.
                            </Text>
                          )}
                        </Tabs.Panel>
                        <Tabs.Panel value="map" pt="xs">
                          <Text size="xs" c="dimmed" mb="xs">Following the active WebVTT cue.</Text>
                          <KlvMap
                            telemetry={overlayData?.mode === 'dvr-vtt' ? overlayData : null}
                            active={activeTab === 'dvr' && dvrTelemetryTab === 'map'}
                          />
                          <Text size="xs" c="dimmed" mt="xs">
                            Mission timestamp: {overlayData?.mode === 'dvr-vtt' && overlayData.timestampIso ? overlayData.timestampIso : 'n/a'}
                          </Text>
                        </Tabs.Panel>
                      </Tabs>
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
                        producerScore: {webrtcDiag.producerScore ?? 'n/a'} | consumerScore: {webrtcDiag.consumerScore ?? 'n/a'} | resolution: {webRtcBrowserStats?.frameWidth && webRtcBrowserStats?.frameHeight ? `${webRtcBrowserStats.frameWidth}×${webRtcBrowserStats.frameHeight}` : 'n/a'} | bitrate: {webRtcBrowserStats?.bitrateKbps != null ? `${webRtcBrowserStats.bitrateKbps} kbps` : 'n/a'}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        receiver: fps: {webRtcBrowserStats?.framesPerSecond ?? 'n/a'} | decoded: {webRtcBrowserStats?.framesDecoded ?? 'n/a'}{webRtcBrowserStats?.decodedSinceLast != null ? ` (+${webRtcBrowserStats.decodedSinceLast}/2s)` : ''} | rendered: {webRtcBrowserStats?.framesRendered ?? 'n/a'}{webRtcBrowserStats?.renderedSinceLast != null ? ` (+${webRtcBrowserStats.renderedSinceLast}/2s)` : ''}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        network: loss: {webRtcBrowserStats?.packetsLost ?? 'n/a'}{webRtcBrowserStats?.lostSinceLast != null ? ` (+${webRtcBrowserStats.lostSinceLast})` : ''} | jitter: {webRtcBrowserStats?.jitterMs != null ? `${webRtcBrowserStats.jitterMs} ms` : 'n/a'} | dropped: {webRtcBrowserStats?.framesDropped ?? 'n/a'}{webRtcBrowserStats?.droppedSinceLast != null ? ` (+${webRtcBrowserStats.droppedSinceLast})` : ''}
                      </Text>
                      <Text size="xs" c="dimmed" mb="xs">
                        browser freezes: {webRtcBrowserStats?.freezeCount ?? 'n/a'}{webRtcBrowserStats?.freezeSeconds != null ? ` (${webRtcBrowserStats.freezeSeconds}s total)` : ''}
                      </Text>
                      <video ref={liveVideoRef} muted playsInline autoPlay style={{ width: '100%', maxHeight: '400px' }}></video>
                    </Paper>
                    <Paper p="sm" withBorder style={{ flex: 1, minWidth: 280 }}>
                      <Text size="sm" fw={600}>Live KLV Telemetry</Text>
                      <Tabs value={liveTelemetryTab} onChange={setLiveTelemetryTab} mt="xs">
                        <Tabs.List grow>
                          <Tabs.Tab value="data">Data</Tabs.Tab>
                          <Tabs.Tab value="map">Map</Tabs.Tab>
                        </Tabs.List>
                        <Tabs.Panel value="data" pt="xs">
                          {liveKlvOverlayEntries.length ? (
                            <Stack gap={4}>
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
                            <Text size="sm" c="dimmed">
                              No live KLV overlay data yet.
                            </Text>
                          )}
                        </Tabs.Panel>
                        <Tabs.Panel value="map" pt="xs">
                          <Text size="xs" c="dimmed" mb="xs">Following the live WebSocket KLV feed.</Text>
                          <KlvMap
                            telemetry={overlayData?.mode === 'live-ws' ? overlayData : null}
                            active={activeTab === 'live-webrtc' && liveTelemetryTab === 'map'}
                          />
                          <Text size="xs" c="dimmed" mt="xs">
                            Mission timestamp: {overlayData?.mode === 'live-ws' && overlayData.timestampIso ? overlayData.timestampIso : 'n/a'}
                          </Text>
                        </Tabs.Panel>
                      </Tabs>
                    </Paper>
                  </Group>
                </Tabs.Panel>
              </Tabs>
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>System Utilization</Text>
              <Group mt="xs" grow align="flex-start">
                <Stack gap={2}>
                  <Text size="sm">CPU: {hostMetrics?.cpuPercent != null ? String(hostMetrics.cpuPercent) + '%' : 'Sampling...'}</Text>
                  <Text size="sm">RAM: {hostMetrics?.memory ? formatBytes(hostMetrics.memory.usedBytes) + ' / ' + formatBytes(hostMetrics.memory.totalBytes) + ' (' + hostMetrics.memory.usedPercent + '%)' : 'n/a'}</Text>
                </Stack>
                <Stack gap={2}>
                  {hostMetrics?.gpu?.available ? hostMetrics.gpu.gpus.map((gpu) => (
                    <Text key={gpu.name} size="sm">
                      GPU: {gpu.name} · {gpu.utilizationPercent ?? 'n/a'}% · {gpu.memoryUsedMiB ?? 'n/a'} / {gpu.memoryTotalMiB ?? 'n/a'} MiB{gpu.temperatureC != null ? ' · ' + gpu.temperatureC + '°C' : ''}
                    </Text>
                  )) : <Text size="sm" c="dimmed">GPU metrics unavailable</Text>}
                </Stack>
              </Group>
            </Paper>
          </Stack>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
