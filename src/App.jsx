import '@mantine/core/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Accordion, ActionIcon, AppShell, Text, Tabs, TextInput, NumberInput, Button, Group, Stack, Paper, Badge, Collapse, Select, FileInput, Progress, Tooltip, Menu, Loader, Modal, Textarea, Checkbox, Slider } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import '@mantine/dates/styles.css';
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
      label: rendition.playlist === 'v0/index.m3u8'
        ? 'Low (360p)'
        : `High (${rendition.id}${rendition.sourceCopy ? ', source copy' : ''})`
  }))
  ];
}

const HLS_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const formatHlsPlaybackRate = (rate) => `${rate}×`;
const RESUMABLE_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const PLAYBACK_ZOOM_MIN = 1;
const PLAYBACK_ZOOM_MAX = 4;
const PLAYBACK_ZOOM_STEP = 0.25;
const INITIAL_PLAYBACK_VIEW = { zoom: 1, panX: 0.5, panY: 0.5 };
const IMAGE_ADJUSTMENT_MIN = 50;
const IMAGE_ADJUSTMENT_MAX = 150;
const DEFAULT_IMAGE_ADJUSTMENT = 100;
const MIN_CLIP_DURATION_SECONDS = 0.25;
const PLATFORM_HISTORY_MAX_POINTS = 5000;
const LIVE_PLATFORM_HISTORY_WINDOW_MS = 15 * 60 * 1000;
const PLATFORM_HISTORY_REFRESH_MS = 5000;

function clampPlaybackZoom(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Math.min(PLAYBACK_ZOOM_MAX, Math.max(PLAYBACK_ZOOM_MIN, rounded));
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value)));
}

/**
 * Updates a scaled viewport while retaining the source pixel below `focus`.
 * Pan is normalized, so a resized player keeps its chosen area in view.
 */
function zoomPlaybackView(view, requestedZoom, focus = { x: 0.5, y: 0.5 }) {
  const zoom = clampPlaybackZoom(requestedZoom);
  if (zoom <= PLAYBACK_ZOOM_MIN) return { ...INITIAL_PLAYBACK_VIEW };

  const previousZoom = Math.max(PLAYBACK_ZOOM_MIN, Number(view?.zoom) || PLAYBACK_ZOOM_MIN);
  const previousPanX = clampUnit(view?.panX ?? 0.5);
  const previousPanY = clampUnit(view?.panY ?? 0.5);
  const focusX = clampUnit(focus.x);
  const focusY = clampUnit(focus.y);
  const denominator = zoom - 1;

  const panAtFocus = (previousPan, focalPoint) => clampUnit(
    (previousPan * (previousZoom - 1) - focalPoint * (1 - zoom / previousZoom)) / denominator
  );

  return {
    zoom,
    panX: panAtFocus(previousPanX, focusX),
    panY: panAtFocus(previousPanY, focusY)
  };
}

function playbackViewTransform(view) {
  const zoom = Number(view?.zoom) || 1;
  if (zoom <= 1) return undefined;
  const translateX = -clampUnit(view?.panX ?? 0.5) * (zoom - 1) * 100;
  const translateY = -clampUnit(view?.panY ?? 0.5) * (zoom - 1) * 100;
  return `translate(${translateX}%, ${translateY}%) scale(${zoom})`;
}

function sameMapPointerPosition(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7
    && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;
}

function formatMapPointerPosition(position) {
  const lat = Number(position?.lat);
  const lon = Number(position?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? `Map pointer: Lat ${lat.toFixed(6)}°, Lon ${lon.toFixed(6)}°`
    : 'Map pointer: —';
}

/** Parses ffprobe's display/sample aspect-ratio form, e.g. "16:9". */
function parseAspectRatio(value) {
  const match = String(value || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, value: width / height };
}

/**
 * WebRTC commonly presents H.264 frames as square pixels.  Use the source
 * probe's DAR (or its coded size multiplied by SAR) to preserve the intended
 * shape in the browser without changing the RTP video bitstream.
 */
function resolveDisplayAspectRatio(sourceVideo) {
  const declaredDar = parseAspectRatio(sourceVideo?.displayAspectRatio);
  if (declaredDar) return declaredDar;

  const sourceWidth = Number(sourceVideo?.width);
  const sourceHeight = Number(sourceVideo?.height);
  const sampleAspect = parseAspectRatio(sourceVideo?.sampleAspectRatio);
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) return null;

  const value = (sourceWidth / sourceHeight) * (sampleAspect?.value || 1);
  return Number.isFinite(value) && value > 0
    ? { width: value, height: 1, value }
    : null;
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

/** Shared display-only digital zoom controls for either playback path. */
function PlaybackZoomControls({ zoom, onZoomChange, disabled = false }) {
  const zoomLabel = `${Number(zoom).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}×`;
  return <Group gap={4} wrap="nowrap">
    <Tooltip label="Zoom out" withArrow>
      <ActionIcon
        variant="light"
        size="lg"
        onClick={() => onZoomChange((current) => clampPlaybackZoom(current - PLAYBACK_ZOOM_STEP))}
        disabled={disabled || zoom <= PLAYBACK_ZOOM_MIN}
        aria-label="Zoom out"
      >
        <Text size="lg" fw={700}>−</Text>
      </ActionIcon>
    </Tooltip>
    <Tooltip label="Reset zoom" withArrow>
      <ActionIcon
        variant={zoom === 1 ? 'light' : 'filled'}
        size="lg"
        onClick={() => onZoomChange(1)}
        disabled={disabled || zoom === 1}
        aria-label={`Reset zoom (currently ${zoomLabel})`}
      >
        <Text size="xs" fw={700}>{zoomLabel}</Text>
      </ActionIcon>
    </Tooltip>
    <Tooltip label="Zoom in" withArrow>
      <ActionIcon
        variant="light"
        size="lg"
        onClick={() => onZoomChange((current) => clampPlaybackZoom(current + PLAYBACK_ZOOM_STEP))}
        disabled={disabled || zoom >= PLAYBACK_ZOOM_MAX}
        aria-label="Zoom in"
      >
        <Text size="lg" fw={700}>+</Text>
      </ActionIcon>
    </Tooltip>
  </Group>;
}

/** Browser-only image controls; values are CSS percentages. */
function ImageAdjustmentMenu({ brightness, contrast, onBrightnessChange, onContrastChange }) {
  const isDefault = brightness === DEFAULT_IMAGE_ADJUSTMENT && contrast === DEFAULT_IMAGE_ADJUSTMENT;
  return <Menu shadow="md" width={235} position="top" withArrow closeOnItemClick={false}>
    <Menu.Target>
      <Tooltip label="Brightness and contrast" withArrow>
        <ActionIcon variant={isDefault ? 'light' : 'filled'} size="lg" aria-label="Brightness and contrast">
          <Text size="xs" fw={700}>B/C</Text>
        </ActionIcon>
      </Tooltip>
    </Menu.Target>
    <Menu.Dropdown>
      <Stack gap="xs" p="xs">
        <Text size="xs" fw={600}>Brightness: {brightness}%</Text>
        <Slider
          min={IMAGE_ADJUSTMENT_MIN}
          max={IMAGE_ADJUSTMENT_MAX}
          step={1}
          value={brightness}
          onChange={onBrightnessChange}
          label={(value) => `${value}%`}
          aria-label="Brightness"
        />
        <Text size="xs" fw={600}>Contrast: {contrast}%</Text>
        <Slider
          min={IMAGE_ADJUSTMENT_MIN}
          max={IMAGE_ADJUSTMENT_MAX}
          step={1}
          value={contrast}
          onChange={onContrastChange}
          label={(value) => `${value}%`}
          aria-label="Contrast"
        />
        <Button
          size="xs"
          variant="light"
          onClick={() => {
            onBrightnessChange(DEFAULT_IMAGE_ADJUSTMENT);
            onContrastChange(DEFAULT_IMAGE_ADJUSTMENT);
          }}
          disabled={isDefault}
        >
          Reset image
        </Button>
      </Stack>
    </Menu.Dropdown>
  </Menu>;
}

/** Startup FFmpeg diagnostics, reused both with and without an active viewer source. */
function MediaToolsStatus({ mediaTools }) {
  return <Stack gap="sm">
    <Group gap="xs">
      <Text size="lg" fw={500}>Media Tools</Text>
      <Badge color={mediaTools?.ok ? 'green' : mediaTools ? 'red' : 'gray'} variant="light">
        {mediaTools?.ok ? 'Ready' : mediaTools ? 'Missing tools' : 'Checking...'}
      </Badge>
    </Group>
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      FFmpeg version: {mediaTools?.ffmpeg?.available ? mediaTools.ffmpeg.versionNumber || mediaTools.ffmpeg.version : mediaTools?.ffmpeg?.error || 'Not checked'}
    </Text>
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      FFprobe version: {mediaTools?.ffprobe?.available ? mediaTools.ffprobe.versionNumber || mediaTools.ffprobe.version : mediaTools?.ffprobe?.error || 'Not checked'}
    </Text>
    <Text size="sm" c={mediaTools?.gpu?.available === false ? 'red' : undefined} style={{ overflowWrap: 'anywhere' }}>
      GPU encoder ({mediaTools?.gpu?.encoder || 'not configured'}): {mediaTools?.gpu?.available ? 'Available' : mediaTools?.gpu?.error || 'Not checked'}
    </Text>
  </Stack>;
}

/** Compact SVG icons for video transport and capture actions. */
function PlaybackControlIcon({ name }) {
  const common = { fill: 'currentColor' };
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (name === 'start') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14" {...stroke} /><path d="m9 6 10 6-10 6z" {...common} /></svg>;
  if (name === 'rewind') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 6-7 6 7 6zM20 6l-7 6 7 6z" {...common} /></svg>;
  if (name === 'playPause') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l8-7zM16 6v12M20 6v12" {...stroke} /></svg>;
  if (name === 'forward') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 6 7 6-7 6zM13 6l7 6-7 6z" {...common} /></svg>;
  if (name === 'end') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14" {...stroke} /><path d="m15 6-10 6 10 6z" {...common} /></svg>;
  if (name === 'clipStart') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M9 7h8l-3 5 3 5H9z" {...stroke} /></svg>;
  if (name === 'clipEnd') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M15 7H7l3 5-3 5h8z" {...stroke} /></svg>;
  if (name === 'targetMark') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 10a6 6 0 1 0-12 0c0 4.5 6 10 6 10s6-5.5 6-10Z" {...stroke} /><circle cx="12" cy="10" r="2" {...stroke} /></svg>;
  if (name === 'exportCsv') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v3h14v-3" {...stroke} /><path d="M7 5h3" {...stroke} /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h3l1.5-2h5L16 8h3v11H5z" {...stroke} /><circle cx="12" cy="13" r="3" {...stroke} /></svg>;
}

function App() {
  const [streamId, setStreamId] = useState('stream1');
  const [sourceType, setSourceType] = useState('stream');
  const [inputUrl, setInputUrl] = useState('udp://239.1.2.3:5000');
  const [videoFile, setVideoFile] = useState(null);
  const [localServerPath, setLocalServerPath] = useState('');
  const [localServerFiles, setLocalServerFiles] = useState([]);
  const [localServerFilesLoading, setLocalServerFilesLoading] = useState(false);
  const [hlsMode, setHlsMode] = useState('passthrough');
  const [webRtcMode, setWebRtcMode] = useState('auto');
  const [hlsSegmentSeconds, setHlsSegmentSeconds] = useState(5);
  const [maxCuesPerSecond, setMaxCuesPerSecond] = useState(10);
  const [minCueDurSec, setMinCueDurSec] = useState(0.10);
  const [maxCueDurSec, setMaxCueDurSec] = useState(0.50);
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
  const [status, setStatus] = useState('Ready. Start a source to begin playback. Telemetry is from segmented WebVTT.');
  const [overlayData, setOverlayData] = useState(null);
  const [dvrPlatformHistory, setDvrPlatformHistory] = useState(null);
  const [livePlatformHistory, setLivePlatformHistory] = useState(null);
  const [dvrPlatformHistoryEnabled, setDvrPlatformHistoryEnabled] = useState(false);
  const [livePlatformHistoryEnabled, setLivePlatformHistoryEnabled] = useState(false);
  const [dvrPlatformHistoryLoading, setDvrPlatformHistoryLoading] = useState(false);
  const [livePlatformHistoryLoading, setLivePlatformHistoryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('dvr');
  const [dvrTelemetryTab, setDvrTelemetryTab] = useState('map');
  const [liveTelemetryTab, setLiveTelemetryTab] = useState('map');
  const [dvrMapPointerPosition, setDvrMapPointerPosition] = useState(null);
  const [liveMapPointerPosition, setLiveMapPointerPosition] = useState(null);
  const [autoAttachOnDvr, setAutoAttachOnDvr] = useState(false);
  const [hlsMediaLoaded, setHlsMediaLoaded] = useState(false);
  const [hlsQuality, setHlsQuality] = useState('auto');
  const [hlsPlaybackRate, setHlsPlaybackRate] = useState(1);
  const [hlsView, setHlsView] = useState(INITIAL_PLAYBACK_VIEW);
  const [webRtcView, setWebRtcView] = useState(INITIAL_PLAYBACK_VIEW);
  const [hlsPanning, setHlsPanning] = useState(false);
  const [webRtcPanning, setWebRtcPanning] = useState(false);
  const [hlsBrightness, setHlsBrightness] = useState(DEFAULT_IMAGE_ADJUSTMENT);
  const [hlsContrast, setHlsContrast] = useState(DEFAULT_IMAGE_ADJUSTMENT);
  const [webRtcBrightness, setWebRtcBrightness] = useState(DEFAULT_IMAGE_ADJUSTMENT);
  const [webRtcContrast, setWebRtcContrast] = useState(DEFAULT_IMAGE_ADJUSTMENT);
  const [hlsQualityControlAvailable, setHlsQualityControlAvailable] = useState(false);
  const [dvrStatus, setDvrStatus] = useState('Idle');
  const [clipStartSeconds, setClipStartSeconds] = useState(0);
  const [clipEndSeconds, setClipEndSeconds] = useState(0);
  const [clipInFlight, setClipInFlight] = useState(false);
  const [clipResult, setClipResult] = useState(null);
  const [clipThumbnailFrames, setClipThumbnailFrames] = useState([]);
  const [clipThumbnailLoading, setClipThumbnailLoading] = useState(false);
  const [authoritativeSnapshotInFlight, setAuthoritativeSnapshotInFlight] = useState(false);
  const [klvExportInFlight, setKlvExportInFlight] = useState(null);
  const [targetLogEntries, setTargetLogEntries] = useState([]);
  const [targetLogFields, setTargetLogFields] = useState([]);
  const [targetLogLoading, setTargetLogLoading] = useState(false);
  const [targetLogInFlight, setTargetLogInFlight] = useState(false);
  const [selectedTargetLogId, setSelectedTargetLogId] = useState(null);
  const [targetLogEditor, setTargetLogEditor] = useState(null);
  const [targetLogSchemaOpen, setTargetLogSchemaOpen] = useState(false);
  const [targetLogFieldDraft, setTargetLogFieldDraft] = useState({ key: '', label: '', dataType: 'text', required: false });
  const [manualVideoStartUtcText, setManualVideoStartUtcText] = useState('');
  const [manualVideoAnchorInFlight, setManualVideoAnchorInFlight] = useState(false);
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
  const [processMetrics, setProcessMetrics] = useState([]);
  const [mediaTools, setMediaTools] = useState(null);
  const hlsRuntimeIsActive = !['stopped', 'stopping', 'error', 'offline'].includes(streamRuntime?.state);
  const updateDvrMapPointerPosition = (position) => {
    setDvrMapPointerPosition((previous) => sameMapPointerPosition(previous, position) ? previous : position);
  };
  const updateLiveMapPointerPosition = (position) => {
    setLiveMapPointerPosition((previous) => sameMapPointerPosition(previous, position) ? previous : position);
  };
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
  const liveVideoViewportRef = useRef(null);
  const hlsPanGestureRef = useRef(null);
  const webRtcPanGestureRef = useRef(null);
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
  const startRequestInFlightRef = useRef(false);
  const hlsStallTimerRef = useRef(null);
  const hlsRecoveryTimerRef = useRef(null);
  const hlsRecoveryPendingRef = useRef(false);
  const hlsQualityRef = useRef('auto');
  const hlsPlaybackRateRef = useRef(1);
  const appliedHlsQualityRef = useRef({ player: null, quality: null, representations: null });
  const clipRangeStreamRef = useRef(null);
  const clipAvailableEndRef = useRef(null);
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
  const dvrPlatformHistoryUntilMsRef = useRef(null);
  const livePlatformHistoryUntilMsRef = useRef(null);
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
    setDvrPlatformHistory(null);
    setLivePlatformHistory(null);
    setDvrPlatformHistoryEnabled(false);
    setLivePlatformHistoryEnabled(false);
    setDvrPlatformHistoryLoading(false);
    setLivePlatformHistoryLoading(false);
    setSourcesList([]);
    setAutoAttachOnDvr(false);
    setFileStartProgress(null);
    setClipThumbnailFrames([]);
    setClipThumbnailLoading(false);
    setClipResult(null);
    setClipStartSeconds(0);
    setClipEndSeconds(0);
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
    setStreamRuntime((prev) => ({
      streamId: prev?.streamId || streamId,
      state: 'offline',
      running: false,
      hlsRunning: false,
      klvRunning: false,
      ingestRunning: false,
      sourceType: null,
      klvProbe: null,
      integrity: null,
      sourceVideo: null,
      durationSeconds: null,
      processedSeconds: null,
      progressPercent: null,
      encodeSpeed: null,
      etaSeconds: null,
      finalizationProgressPercent: null,
      finalizationProcessedSegments: null,
      finalizationTotalSegments: null,
      finalizationEtaSeconds: null,
      manualVideoStartUtcMs: null,
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

  // File finalization is still active work: KLV batches and VTT sidecars must
  // finish before another start can reset this stream's recording directory.
  const isStartBlockedByState = ['starting', 'running', 'degraded', 'stopping', 'finalizing', 'ready'].includes(streamRuntime?.state);
  const isStopBlockedByState = ['starting', 'stopping', 'stopped'].includes(streamRuntime?.state);
  const selectedFileSource = sourceType === 'file' || sourceType === 'local-file';
  const hasSelectedInput = sourceType === 'file'
    ? !!videoFile
    : sourceType === 'local-file'
      ? !!String(localServerPath || '').trim()
      : !!String(inputUrl || '').trim();
  const canStartSource = serverOnline && hasSelectedInput && !startRequestInFlight && !stopRequestInFlight && !isStartBlockedByState;
  const canStopSource = serverOnline && !startRequestInFlight && !stopRequestInFlight && !isStopBlockedByState;
  const currentSourceIsFile = streamRuntime?.sourceType === 'file';
  const rawManualVideoStartUtcMs = streamRuntime?.manualVideoStartUtcMs;
  const manualVideoStartUtcMs = Number(rawManualVideoStartUtcMs);
  const hasManualVideoStartUtc = rawManualVideoStartUtcMs != null
    && Number.isFinite(manualVideoStartUtcMs)
    && manualVideoStartUtcMs >= 0;
  const hasConfirmedNoKlvFile = currentSourceIsFile && streamRuntime?.klvProbe?.available === false;
  const manualVideoUtcMs = hasManualVideoStartUtc && Number.isFinite(Number(dvrDiag.currentTimeSec))
    ? Math.round(manualVideoStartUtcMs + (Number(dvrDiag.currentTimeSec) * 1000))
    : null;
  const canEditManualVideoAnchor = hasConfirmedNoKlvFile
    && hlsMediaLoaded
    && ['running', 'finalizing', 'ready'].includes(streamRuntime?.state);
  const hasActiveViewerSource = !['stopped', 'error', 'offline'].includes(streamRuntime?.state);
  const playbackTitle = currentSourceIsFile ? 'Post Mission Playback' : 'Time Shifted Playback (HLS)';
  const playbackDescription = currentSourceIsFile
    ? 'Post Mission Playback with synchronized WebVTT telemetry.'
    : 'Time Shifted Playback via HLS with synchronized WebVTT telemetry.';
  const playbackPlayerName = currentSourceIsFile ? 'playback player' : 'HLS player';
  const clipSourceIsActive = currentSourceIsFile && !['stopping', 'stopped', 'error', 'offline'].includes(streamRuntime?.state);
  const sourceDurationSeconds = Number(streamRuntime?.durationSeconds);
  const clipTimelineEndSeconds = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
    ? sourceDurationSeconds
    : null;
  // While packaging, use the server's completed browser-HLS boundary rather
  // than FFmpeg progress. The full source duration remains the visual timeline
  // so the unavailable future filmstrip can be clearly dimmed.
  const reportedClipAvailableEndSeconds = Number(streamRuntime?.availableClipEndSeconds);
  const clipAvailableEndSeconds = currentSourceIsFile && Number.isFinite(clipTimelineEndSeconds)
    ? streamRuntime?.state === 'ready'
      ? clipTimelineEndSeconds
      : Number.isFinite(reportedClipAvailableEndSeconds)
        ? Math.max(0, Math.min(clipTimelineEndSeconds, reportedClipAvailableEndSeconds))
        : 0
    : null;
  const clipAvailabilityPercent = Number.isFinite(clipTimelineEndSeconds) && clipTimelineEndSeconds > 0
    && Number.isFinite(clipAvailableEndSeconds)
    ? Math.max(0, Math.min(100, (clipAvailableEndSeconds / clipTimelineEndSeconds) * 100))
    : 0;
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
  const liveDisplayAspect = resolveDisplayAspectRatio(streamRuntime?.sourceVideo);
  const liveDisplayAspectLabel = liveDisplayAspect
    ? `${Math.round(liveDisplayAspect.value * 1080)}×1080`
    : null;
  const liveVideoFrameStyle = liveDisplayAspect
    ? {
      width: `min(100%, ${400 * liveDisplayAspect.value}px)`,
      aspectRatio: `${liveDisplayAspect.width} / ${liveDisplayAspect.height}`,
      margin: '0 auto'
    }
    : { width: '100%' };
  const liveVideoStyle = liveDisplayAspect
    ? { width: '100%', height: '100%', objectFit: 'fill', transform: playbackViewTransform(webRtcView), transformOrigin: 'top left', filter: `brightness(${webRtcBrightness}%) contrast(${webRtcContrast}%)` }
    : { width: '100%', maxHeight: '400px', transform: playbackViewTransform(webRtcView), transformOrigin: 'top left', filter: `brightness(${webRtcBrightness}%) contrast(${webRtcContrast}%)` };
  const clipWidgetReady = Boolean(
    currentSourceIsFile
    && hlsMediaLoaded
    && Number.isFinite(clipTimelineEndSeconds)
    && Number.isFinite(clipAvailableEndSeconds)
    && clipAvailableEndSeconds >= MIN_CLIP_DURATION_SECONDS
  );
  const clipExportReady = clipWidgetReady && streamRuntime?.state === 'ready';
  const liveVideoStreaming = liveStatus === 'Playing';
  // File processing intentionally stops its FFmpeg workers after packaging and
  // reports `ready`, while its HLS artifacts remain playable. Treat every
  // playable lifecycle state as active for target-log actions.
  const targetLogSourceActive = serverOnline && (
    streamRuntime?.running === true
    || ['running', 'degraded', 'finalizing', 'ready'].includes(streamRuntime?.state)
  );
  const rawKlvTelemetryEventCount = streamRuntime?.klvTelemetryEventCount;
  const klvTelemetryEventCount = Number(rawKlvTelemetryEventCount);
  const fileKlvTelemetryCountKnown = rawKlvTelemetryEventCount != null
    && Number.isFinite(klvTelemetryEventCount)
    && klvTelemetryEventCount >= 0;
  const klvExportAvailable = serverOnline && (currentSourceIsFile
    ? streamRuntime?.state === 'ready' && fileKlvTelemetryCountKnown && klvTelemetryEventCount > 0
    : streamRuntime?.state === 'running');
  const klvExportUnavailableMessage = !serverOnline
    ? 'Server is offline'
    : currentSourceIsFile && streamRuntime?.state !== 'ready'
      ? 'KLV export is available after post-mission processing completes'
      : currentSourceIsFile && fileKlvTelemetryCountKnown && klvTelemetryEventCount === 0
        ? 'No KLV telemetry available for this video'
        : currentSourceIsFile
          ? 'Checking KLV telemetry availability'
          : 'KLV export is available while the live stream is running';
  const canAddTargetMark = targetLogSourceActive && !targetLogInFlight;
  const canManageTargetLogFields = targetLogSourceActive && !targetLogInFlight;
  const showTargetMarkAction = activeTab !== 'live-webrtc' || liveVideoStreaming;

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
      // A file upload is part of the Start Source workflow, but the server
      // cannot create its source runtime until the upload has completed. Keep
      // the in-progress `starting` state rather than briefly displaying the
      // stale stopped state returned during that interval.
      if (startRequestInFlightRef.current
        && streamRuntimeRef.current?.state === 'starting'
        && result.state === 'stopped') return;
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

  const uploadResumeStorageKey = (file, targetStreamId) => `midas-resumable-upload:${encodeURIComponent(`${targetStreamId}:${file.name}:${file.size}:${file.lastModified}`)}`;

  const readSavedUpload = (file, targetStreamId) => {
    try {
      const raw = window.localStorage.getItem(uploadResumeStorageKey(file, targetStreamId));
      const saved = raw ? JSON.parse(raw) : null;
      return saved?.uploadUrl && saved?.uploadId ? saved : null;
    } catch {
      return null;
    }
  };

  const refreshLocalServerFiles = async () => {
    if (!serverOnlineRef.current) return;
    setLocalServerFilesLoading(true);
    try {
      const result = await api('/uploads/video/local-files');
      if (!result?.ok || !Array.isArray(result.files)) {
        throw new Error(result?.error || 'Could not list local server video files.');
      }
      setLocalServerFiles(result.files);
    } catch (error) {
      setLocalServerFiles([]);
      setStatus(`Local server file list failed: ${String(error?.message || error)}`);
    } finally {
      setLocalServerFilesLoading(false);
    }
  };

  const saveUpload = (file, targetStreamId, session) => {
    try { window.localStorage.setItem(uploadResumeStorageKey(file, targetStreamId), JSON.stringify(session)); } catch {}
  };

  const clearSavedUpload = (file, targetStreamId) => {
    try { window.localStorage.removeItem(uploadResumeStorageKey(file, targetStreamId)); } catch {}
  };

  const resumableJsonRequest = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `Upload request failed (HTTP ${response.status})`);
      error.status = response.status;
      error.uploadOffset = Number(response.headers.get('Upload-Offset'));
      throw error;
    }
    markServerOnline();
    return payload || {};
  };

  const getResumableUploadOffset = async (uploadUrl) => {
    const response = await fetch(uploadUrl, { method: 'HEAD' });
    if (!response.ok) throw new Error(`Saved upload is unavailable (HTTP ${response.status})`);
    markServerOnline();
    const offset = Number(response.headers.get('Upload-Offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Server returned an invalid upload offset.');
    return offset;
  };

  // XMLHttpRequest supplies progress events for each resumable upload chunk.
  const uploadVideoChunk = (uploadUrl, file, offset, chunk) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PATCH', uploadUrl);
    request.setRequestHeader('content-type', 'application/offset+octet-stream');
    request.setRequestHeader('Upload-Offset', String(offset));
    request.responseType = 'text';
    request.upload.onprogress = (event) => {
      setFileStartProgress({
        phase: 'uploading',
        loadedBytes: Math.min(file.size, offset + event.loaded),
        totalBytes: file.size
      });
    };
    request.onerror = () => reject(new Error('Video upload chunk failed (network error)'));
    request.onload = () => {
      let result = null;
      try { result = JSON.parse(request.responseText || '{}'); } catch {}
      const nextOffset = Number(request.getResponseHeader('Upload-Offset'));
      if (request.status >= 200 && request.status < 300 && Number.isSafeInteger(nextOffset)) {
        markServerOnline();
        resolve({ offset: nextOffset });
        return;
      }
      const error = new Error(result?.error || `Video upload chunk failed (HTTP ${request.status})`);
      error.status = request.status;
      error.uploadOffset = nextOffset;
      reject(error);
    };
    request.send(chunk);
  });

  const uploadVideoFile = async (file, targetStreamId) => {
    let session = readSavedUpload(file, targetStreamId);
    let offset = 0;

    try {
      if (session) {
        try {
          offset = await getResumableUploadOffset(session.uploadUrl);
          if (offset > file.size) throw new Error('Saved upload offset exceeds the selected file size.');
        } catch {
          clearSavedUpload(file, targetStreamId);
          session = null;
        }
      }

      if (!session) {
        const created = await resumableJsonRequest('/uploads/video/resumable', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ streamId: targetStreamId, filename: file.name, sizeBytes: file.size })
        });
        if (!created?.ok || !created.uploadId || !created.uploadUrl) {
          throw new Error(created?.error || 'Could not create a resumable upload.');
        }
        session = { uploadId: created.uploadId, uploadUrl: created.uploadUrl };
        offset = Number(created.offset || 0);
        saveUpload(file, targetStreamId, session);
      }

      setFileStartProgress({ phase: 'uploading', loadedBytes: offset, totalBytes: file.size });
      let retries = 0;
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(file.size, offset + RESUMABLE_UPLOAD_CHUNK_BYTES));
        try {
          const result = await uploadVideoChunk(session.uploadUrl, file, offset, chunk);
          if (result.offset <= offset || result.offset > file.size) {
            throw new Error('Server returned an invalid next upload offset.');
          }
          offset = result.offset;
          retries = 0;
          saveUpload(file, targetStreamId, session);
          setFileStartProgress({ phase: 'uploading', loadedBytes: offset, totalBytes: file.size });
        } catch (error) {
          const serverOffset = Number(error?.uploadOffset);
          if (Number.isSafeInteger(serverOffset) && serverOffset > offset && serverOffset <= file.size) {
            offset = serverOffset;
            retries = 0;
            saveUpload(file, targetStreamId, session);
            continue;
          }
          retries += 1;
          if (retries > 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, retries * 750));
          offset = await getResumableUploadOffset(session.uploadUrl);
          if (offset > file.size) throw new Error('Server returned an invalid upload offset.');
          saveUpload(file, targetStreamId, session);
        }
      }

      const completed = await resumableJsonRequest(`${session.uploadUrl}/complete`, { method: 'POST' });
      if (!completed?.ok || !completed.assetId) throw new Error(completed?.error || 'Video upload could not be completed.');
      clearSavedUpload(file, targetStreamId);
      return completed;
    } catch (error) {
      throw error;
    }
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
    startRequestInFlightRef.current = true;
    setStartRequestInFlight(true);
    setOverlayData(null);
    setDvrPlatformHistory(null);
    setLivePlatformHistory(null);
    setDvrPlatformHistoryEnabled(false);
    setLivePlatformHistoryEnabled(false);
    setFileStartProgress(null);
    setHlsMediaLoaded(false);
    hlsQualityRef.current = 'auto';
    setHlsQuality('auto');
    setHlsQualityControlAvailable(false);
    const startingRuntime = { streamId, sourceType: selectedFileSource ? 'file' : sourceType, state: 'starting', running: false, lastError: null };
    streamRuntimeRef.current = startingRuntime;
    setStreamRuntime(startingRuntime);
    try {
      setStatus('Clearing previous recording artifacts...');
      await api(`/sources/${encodeURIComponent(streamId)}/reset`, { method: 'POST' });
      let assetId = null;
      if (selectedFileSource) {
        clipRangeStreamRef.current = null;
        setClipStartSeconds(0);
        setClipEndSeconds(0);
        setClipResult(null);
      }
      if (sourceType === 'file') {
        setFileStartProgress({ phase: 'uploading', loadedBytes: 0, totalBytes: videoFile.size });
        setStatus(`Uploading ${videoFile.name}...`);
        const uploadResult = await uploadVideoFile(videoFile, streamId);
        if (!uploadResult?.ok || !uploadResult.assetId) {
          throw new Error(uploadResult?.error || 'Video upload failed');
        }
        assetId = uploadResult.assetId;
        setFileStartProgress({ phase: 'analyzing', loadedBytes: videoFile.size, totalBytes: videoFile.size });
        setStatus('Upload complete. Analyzing video streams and KLV metadata...');
        setActiveTab('dvr');
      } else if (sourceType === 'local-file') {
        setStatus('Copying local server video into the authoritative source folder...');
        const copyResult = await api('/uploads/video/local-copy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ streamId, inputPath: localServerPath.trim() })
        });
        if (!copyResult?.ok || !copyResult.assetId) {
          throw new Error(copyResult?.error || 'Local server video copy failed');
        }
        assetId = copyResult.assetId;
        setStatus(`Copied ${copyResult.sourceFilename || 'local server video'}. Analyzing video streams and KLV metadata...`);
        setActiveTab('dvr');
      }
      if (selectedFileSource) setStatus('Starting file conversion and KLV processing...');
      const result = await api("/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          streamId,
          sourceType: selectedFileSource ? 'file' : sourceType,
          inputUrl: sourceType === 'stream' ? inputUrl : undefined,
          assetId,
          hlsMode,
          webRtcMode,
          hlsSegmentSeconds,
          vttSegmentSeconds: hlsSegmentSeconds,
          maxCuesPerSecond,
          minCueDurSec,
          maxCueDurSec
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
      if (result?.ok && !selectedFileSource && activeTab === 'live-webrtc') {
        startWebRtcAutoAttach(streamId);
      }
    } catch (error) {
      setFileStartProgress(null);
      setStatus(`Start source failed: ${String(error?.message || error)}`);
      setStreamRuntime((prev) => ({
        ...prev,
        streamId,
        // A rejected create request has no published source runtime to stop.
        // Keep the diagnostic but return the controls to their retryable state.
        state: serverOnlineRef.current ? 'stopped' : 'offline',
        running: false,
        lastError: String(error?.message || error)
      }));
    } finally {
      startRequestInFlightRef.current = false;
      setStartRequestInFlight(false);
    }
  };

  const stopSource = async () => {
    if (!canStopSource) return;
    setStopRequestInFlight(true);
    setOverlayData(null);
    setDvrPlatformHistory(null);
    setLivePlatformHistory(null);
    setDvrPlatformHistoryEnabled(false);
    setLivePlatformHistoryEnabled(false);
    setDvrPlatformHistoryLoading(false);
    setLivePlatformHistoryLoading(false);
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
      if (result?.ok) {
        // Stopping closes this mission's playback context. Keep no stale marks
        // visible in the UI; SQLite data remains available until a reset/new source.
        setTargetLogEntries([]);
        setTargetLogFields([]);
        setSelectedTargetLogId(null);
        setTargetLogEditor(null);
        setTargetLogSchemaOpen(false);
      }
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
    if (Array.isArray(result?.processes)) setProcessMetrics(result.processes);
    if (result?.mediaTools) setMediaTools(result.mediaTools);
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

  const refreshTargetLog = async (targetStreamId = streamId, { silent = false } = {}) => {
    if (!targetStreamId || !serverOnlineRef.current) return;
    setTargetLogLoading(true);
    try {
      const result = await api(`/streams/${encodeURIComponent(targetStreamId)}/target-log`);
      if (!result?.ok) throw new Error(result?.error || 'Could not load the target log.');
      setTargetLogEntries(Array.isArray(result.entries) ? result.entries : []);
      setTargetLogFields(Array.isArray(result.fields) ? result.fields : []);
      setSelectedTargetLogId((current) => result.entries?.some((entry) => entry.id === current) ? current : null);
    } catch (error) {
      if (!silent) setStatus(`Target log load failed: ${String(error?.message || error)}`);
    } finally {
      setTargetLogLoading(false);
    }
  };

  const isTargetLogCoordinate = (lat, lon) => (
    Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))
    && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180
  );

  const capturedTargetPosition = (telemetry) => {
    if (isTargetLogCoordinate(telemetry?.frameCenterLat, telemetry?.frameCenterLon)) {
      return {
        position: { lat: Number(telemetry.frameCenterLat), lon: Number(telemetry.frameCenterLon) },
        positionSource: 'FRAME_CENTER'
      };
    }
    if (isTargetLogCoordinate(telemetry?.sensorLat, telemetry?.sensorLon)) {
      return {
        position: { lat: Number(telemetry.sensorLat), lon: Number(telemetry.sensorLon) },
        positionSource: 'PLATFORM'
      };
    }
    return { position: null, positionSource: 'UNAVAILABLE' };
  };

  const klvMissionTimeMs = (telemetry) => {
    const micros = telemetry?.timestampUnixMicros;
    if (micros != null && String(micros).trim()) {
      try {
        const value = Number(BigInt(String(micros).trim()) / 1000n);
        if (Number.isSafeInteger(value) && value >= 0) return value;
      } catch {}
    }
    const isoMs = Date.parse(String(telemetry?.timestampIso || ''));
    return Number.isFinite(isoMs) && isoMs >= 0 ? isoMs : null;
  };

  const dvrPlatformHistoryUntilMs = overlayData?.mode === 'dvr-vtt'
    ? klvMissionTimeMs(overlayData)
    : null;
  const livePlatformHistoryUntilMs = overlayData?.mode === 'live-ws'
    ? klvMissionTimeMs(overlayData)
    : null;
  const canLoadDvrPlatformHistory = serverOnline && hasDvrKlvTelemetry(streamRuntime);
  const canLoadLivePlatformHistory = serverOnline && !currentSourceIsFile && hasActiveKlvFlow(streamRuntime);
  const dvrPlatformHistoryTimeAvailable = Number.isFinite(dvrPlatformHistoryUntilMs);
  const livePlatformHistoryTimeAvailable = Number.isFinite(livePlatformHistoryUntilMs);

  /**
   * Fetches the compact segment-sampled route, never the full decoded KLV
   * collection. `fromMs`/`toMs` are mission timestamps from the active cue.
   */
  const fetchPlatformHistory = async ({ fromMs = null, toMs = null } = {}) => {
    const query = new URLSearchParams({ maxPoints: String(PLATFORM_HISTORY_MAX_POINTS) });
    if (Number.isFinite(fromMs)) query.set('fromMs', String(Math.round(fromMs)));
    if (Number.isFinite(toMs)) query.set('toMs', String(Math.round(toMs)));
    const result = await api(`/streams/${encodeURIComponent(streamId)}/klv/platform-history.geojson?${query.toString()}`);
    if (result?.type !== 'Feature') {
      throw new Error(result?.error || 'Platform history response was not GeoJSON');
    }
    return result;
  };

  const openNewTargetLogEntry = (mapPosition = null) => {
    if (!targetLogSourceActive) {
      setStatus('Start a source before adding a target mark.');
      return;
    }
    const telemetry = overlayData?.mode === 'dvr-vtt' || overlayData?.mode === 'live-ws' ? overlayData : null;
    const missionTimeMs = klvMissionTimeMs(telemetry) ?? manualVideoUtcMs;
    const capture = isTargetLogCoordinate(mapPosition?.lat, mapPosition?.lon)
      ? { position: { lat: Number(mapPosition.lat), lon: Number(mapPosition.lon) }, positionSource: 'UNAVAILABLE' }
      : capturedTargetPosition(telemetry);
    setTargetLogEditor({
      mode: 'create',
      missionTimeMs,
      missionTimeText: missionTimeMs == null ? '' : formatMissionTime(missionTimeMs),
      missionId: telemetry?.missionId || null,
      position: capture.position,
      positionSource: capture.positionSource,
      observation: '',
      customFields: Object.fromEntries(targetLogFields.filter((field) => field.active).map((field) => [field.key, '']))
    });
  };

  const openEditTargetLogEntry = (entry) => {
    setSelectedTargetLogId(entry.id);
    setTargetLogEditor({ ...entry, mode: 'edit', missionTimeText: formatMissionTime(entry.missionTimeMs), customFields: { ...(entry.customFields || {}) } });
  };

  const updateTargetLogDraftField = (key, value) => {
    setTargetLogEditor((current) => current ? {
      ...current,
      customFields: { ...(current.customFields || {}), [key]: value }
    } : current);
  };

  const updateTargetLogPosition = (axis, value) => {
    setTargetLogEditor((current) => {
      if (!current) return current;
      const rawValue = value === '' || value == null ? null : Number(value);
      return {
        ...current,
        position: { ...(current.position || { lat: null, lon: null }), [axis]: rawValue }
      };
    });
  };

  const normalizedTargetLogDraftPosition = (position) => {
    const latEmpty = position?.lat === null || position?.lat === undefined || position?.lat === '';
    const lonEmpty = position?.lon === null || position?.lon === undefined || position?.lon === '';
    if (latEmpty && lonEmpty) return null;
    if (!isTargetLogCoordinate(position?.lat, position?.lon)) {
      throw new Error('Enter a valid latitude (-90 to 90) and longitude (-180 to 180) in decimal degrees.');
    }
    return { lat: Number(position.lat), lon: Number(position.lon) };
  };

  const parseTargetLogMissionTime = (value) => {
    const text = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
    if (!match) {
      throw new Error('Use ISO 8601 with a UTC offset, for example 2026-07-29T16:51:25.000Z.');
    }

    const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText, offsetText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const milliseconds = Number((millisecondsText || '').padEnd(3, '0') || 0);
    const offsetParts = offsetText === 'Z' ? null : /^([+-])(\d{2}):(\d{2})$/.exec(offsetText);
    const offsetHours = offsetParts ? Number(offsetParts[2]) : 0;
    const offsetMinutes = offsetParts ? Number(offsetParts[3]) : 0;
    const validDay = day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || !validDay || hour > 23 || minute > 59 || second > 59 || milliseconds > 999 || offsetHours > 23 || offsetMinutes > 59) {
      throw new Error('Enter a real calendar date and time in ISO 8601 UTC format.');
    }

    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('Enter a valid mission time with a UTC offset, for example 2026-07-29T16:51:25.000Z.');
    }
    return parsed;
  };

  const targetLogMissionTimeError = (value) => {
    try {
      parseTargetLogMissionTime(value);
      return null;
    } catch (error) {
      return String(error?.message || error);
    }
  };

  const saveManualVideoTimeAnchor = async () => {
    if (!canEditManualVideoAnchor || manualVideoAnchorInFlight) return;
    setManualVideoAnchorInFlight(true);
    try {
      const firstFrameUtcMs = parseTargetLogMissionTime(manualVideoStartUtcText);
      const result = await api(`/sources/${encodeURIComponent(streamId)}/manual-video-time-anchor`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstFrameUtcMs })
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not save mission timestamp.');
      if (result?.state?.streamId) setStreamRuntime(result.state);
      setStatus('Mission timestamp saved for the first video frame.');
    } catch (error) {
      setStatus(`Mission timestamp save failed: ${String(error?.message || error)}`);
    } finally {
      setManualVideoAnchorInFlight(false);
    }
  };

  const clearManualVideoTimeAnchor = async () => {
    if (!hasConfirmedNoKlvFile || manualVideoAnchorInFlight) return;
    setManualVideoAnchorInFlight(true);
    try {
      const result = await api(`/sources/${encodeURIComponent(streamId)}/manual-video-time-anchor`, { method: 'DELETE' });
      if (!result?.ok) throw new Error(result?.error || 'Could not clear mission timestamp.');
      if (result?.state?.streamId) setStreamRuntime(result.state);
      setStatus('Mission timestamp cleared.');
    } catch (error) {
      setStatus(`Mission timestamp clear failed: ${String(error?.message || error)}`);
    } finally {
      setManualVideoAnchorInFlight(false);
    }
  };

  const saveTargetLogEditor = async () => {
    if (!targetLogEditor || targetLogInFlight) return;
    setTargetLogInFlight(true);
    try {
      const isCreate = targetLogEditor.mode === 'create';
      const missionTimeMs = parseTargetLogMissionTime(targetLogEditor.missionTimeText);
      const position = normalizedTargetLogDraftPosition(targetLogEditor.position);
      const positionSource = position ? targetLogEditor.positionSource : 'UNAVAILABLE';
      const url = isCreate
        ? `/streams/${encodeURIComponent(streamId)}/target-log/entries`
        : `/streams/${encodeURIComponent(streamId)}/target-log/entries/${encodeURIComponent(targetLogEditor.id)}`;
      const result = await api(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isCreate ? {
          missionTimeMs,
          missionId: targetLogEditor.missionId,
          position,
          positionSource,
          observation: targetLogEditor.observation,
          customFields: targetLogEditor.customFields
        } : {
          observation: targetLogEditor.observation,
          customFields: targetLogEditor.customFields,
          missionTimeMs,
          position,
          positionSource
        })
      });
      if (!result?.ok || !result?.entry) throw new Error(result?.error || 'Could not save target-log entry.');
      setSelectedTargetLogId(result.entry.id);
      setTargetLogEditor(null);
      await refreshTargetLog(streamId, { silent: true });
      setStatus(isCreate ? 'Target mark added.' : 'Target mark updated.');
    } catch (error) {
      setStatus(`Target mark save failed: ${String(error?.message || error)}`);
    } finally {
      setTargetLogInFlight(false);
    }
  };

  const deleteTargetLogEntry = async (entry) => {
    if (!entry || targetLogInFlight) return;
    setTargetLogInFlight(true);
    try {
      const result = await api(`/streams/${encodeURIComponent(streamId)}/target-log/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (!result?.ok) throw new Error(result?.error || 'Could not remove target-log entry.');
      if (selectedTargetLogId === entry.id) setSelectedTargetLogId(null);
      await refreshTargetLog(streamId, { silent: true });
      setStatus('Target mark removed.');
    } catch (error) {
      setStatus(`Target mark removal failed: ${String(error?.message || error)}`);
    } finally {
      setTargetLogInFlight(false);
    }
  };

  const seekTargetLogEntry = (entry) => {
    if (selectedTargetLogId === entry.id) {
      setSelectedTargetLogId(null);
      return;
    }
    if (activeTabRef.current === 'live-webrtc') {
      setSelectedTargetLogId(entry.id);
      setStatus('Target mark selected. Live WebRTC playback cannot seek to a prior mission time.');
      return;
    }
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus(`The ${playbackPlayerName} is not ready.`);
      return;
    }
    const videoTimeSeconds = targetLogVideoTimeSeconds(entry);
    if (videoTimeSeconds == null) {
      setStatus('This target mark has no video alignment time.');
      return;
    }
    const { start, end } = getHlsSeekBounds(player);
    player.currentTime(clampToBounds(videoTimeSeconds, start, end));
    setSelectedTargetLogId(entry.id);
  };

  const selectTargetLogEntryById = (entryId) => {
    const entry = targetLogEntries.find((item) => item.id === entryId);
    if (entry) seekTargetLogEntry(entry);
  };

  const createTargetLogField = async () => {
    const draft = targetLogFieldDraft;
    if (targetLogInFlight) return;
    setTargetLogInFlight(true);
    try {
      const result = await api(`/streams/${encodeURIComponent(streamId)}/target-log/fields`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft)
      });
      if (!result?.ok) throw new Error(result?.error || 'Could not add target-log field.');
      setTargetLogFieldDraft({ key: '', label: '', dataType: 'text', required: false });
      await refreshTargetLog(streamId, { silent: true });
      setStatus('Target-log field added.');
    } catch (error) {
      setStatus(`Target-log field add failed: ${String(error?.message || error)}`);
    } finally {
      setTargetLogInFlight(false);
    }
  };

  const deactivateTargetLogField = async (field) => {
    if (!field || targetLogInFlight) return;
    if (!window.confirm(`Deactivate “${field.label}”? Existing target-log values will be retained.`)) return;
    setTargetLogInFlight(true);
    try {
      const result = await api(`/streams/${encodeURIComponent(streamId)}/target-log/fields/${encodeURIComponent(field.id)}`, { method: 'DELETE' });
      if (!result?.ok) throw new Error(result?.error || 'Could not deactivate target-log field.');
      await refreshTargetLog(streamId, { silent: true });
      setStatus('Target-log field deactivated; historical values were retained.');
    } catch (error) {
      setStatus(`Target-log field change failed: ${String(error?.message || error)}`);
    } finally {
      setTargetLogInFlight(false);
    }
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
      setStatus(`The ${playbackPlayerName} is not ready.`);
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
      setStatus(`The ${playbackPlayerName} is not ready.`);
      return;
    }
    const { start } = getHlsSeekBounds(player);
    player.currentTime(start);
  };

  const seekHlsToEnd = () => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus(`The ${playbackPlayerName} is not ready.`);
      return;
    }
    const { end } = getHlsSeekBounds(player);
    player.currentTime(end);
  };

  const seekHlsToClipMarker = (marker) => {
    if (!clipWidgetReady) {
      setStatus('Set a valid clip range before seeking to its markers.');
      return;
    }
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus(`The ${playbackPlayerName} is not ready.`);
      return;
    }
    const target = marker === 'start' ? clipStartSeconds : clipEndSeconds;
    const { start, end } = getHlsSeekBounds(player);
    player.currentTime(clampToBounds(target, start, end));
  };

  const toggleHlsPlayPause = () => {
    const player = getActiveHlsPlayer();
    if (!player) {
      setStatus(`The ${playbackPlayerName} is not ready.`);
      return;
    }
    if (player.paused?.()) {
      player.play().catch(() => {});
    } else {
      player.pause?.();
    }
  };

  const setHlsPlaybackSpeed = (value) => {
    const rate = Number(value);
    if (!HLS_PLAYBACK_RATES.includes(rate)) return;
    hlsPlaybackRateRef.current = rate;
    setHlsPlaybackRate(rate);
    const player = getActiveHlsPlayer();
    try { player?.playbackRate?.(rate); } catch {}
    setStatus(`${currentSourceIsFile ? 'Playback' : 'HLS playback'} speed set to ${rate}×.`);
  };

  const changePlaybackZoomAtCenter = (setView, change) => {
    setView((current) => {
      const requested = typeof change === 'function' ? change(current.zoom) : change;
      return zoomPlaybackView(current, requested);
    });
  };

  const changeHlsZoom = (change) => changePlaybackZoomAtCenter(setHlsView, change);
  const changeWebRtcZoom = (change) => changePlaybackZoomAtCenter(setWebRtcView, change);

  const handlePlaybackZoomWheel = (event, setView) => {
    // Preserve the browser's Ctrl+wheel page-zoom shortcut.
    if (event.ctrlKey || event.deltaY === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (event.cancelable) event.preventDefault();
    const focus = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    };
    // This gives a natural response for both mouse wheels and trackpads.
    const multiplier = Math.exp(-event.deltaY * 0.0015);
    setView((current) => zoomPlaybackView(current, current.zoom * multiplier, focus));
  };

  const handleHlsZoomWheel = (event) => handlePlaybackZoomWheel(event, setHlsView);
  const handleWebRtcZoomWheel = (event) => handlePlaybackZoomWheel(event, setWebRtcView);

  const beginPlaybackPan = (event, view, gestureRef, setPanning, { ignoreVideoJsControls = false } = {}) => {
    if (event.button !== 0 || view.zoom <= 1) return;
    if (ignoreVideoJsControls && event.target instanceof Element && event.target.closest('.vjs-control-bar')) return;
    const viewport = event.currentTarget;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    gestureRef.current = {
      pointerId: event.pointerId,
      viewport,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      view
    };
    try { viewport.setPointerCapture(event.pointerId); } catch {}
    setPanning(true);
    event.preventDefault();
    event.stopPropagation();
  };

  const movePlaybackPan = (event, setView, gestureRef) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const zoomRange = gesture.view.zoom - 1;
    if (zoomRange <= 0) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    setView({
      ...gesture.view,
      panX: clampUnit(gesture.view.panX - deltaX / (gesture.width * zoomRange)),
      panY: clampUnit(gesture.view.panY - deltaY / (gesture.height * zoomRange))
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const endPlaybackPan = (event, gestureRef, setPanning) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    try { gesture.viewport.releasePointerCapture(event.pointerId); } catch {}
    gestureRef.current = null;
    setPanning(false);
    event.preventDefault();
    event.stopPropagation();
  };

  const beginHlsPan = (event) => beginPlaybackPan(event, hlsView, hlsPanGestureRef, setHlsPanning, { ignoreVideoJsControls: true });
  const moveHlsPan = (event) => movePlaybackPan(event, setHlsView, hlsPanGestureRef);
  const endHlsPan = (event) => endPlaybackPan(event, hlsPanGestureRef, setHlsPanning);
  const beginWebRtcPan = (event) => beginPlaybackPan(event, webRtcView, webRtcPanGestureRef, setWebRtcPanning);
  const moveWebRtcPan = (event) => movePlaybackPan(event, setWebRtcView, webRtcPanGestureRef);
  const endWebRtcPan = (event) => endPlaybackPan(event, webRtcPanGestureRef, setWebRtcPanning);

  useEffect(() => {
    const hlsViewport = dvrVideoHostRef.current;
    const webRtcViewport = liveVideoViewportRef.current;
    if (!hlsViewport && !webRtcViewport) return undefined;

    // React may install delegated wheel handlers as passive in some browser
    // paths. Native non-passive listeners are required to reliably suppress
    // document scrolling while the pointer is over a zoomable video frame.
    if (hlsViewport) hlsViewport.addEventListener('wheel', handleHlsZoomWheel, { passive: false });
    if (webRtcViewport) webRtcViewport.addEventListener('wheel', handleWebRtcZoomWheel, { passive: false });
    return () => {
      if (hlsViewport) hlsViewport.removeEventListener('wheel', handleHlsZoomWheel);
      if (webRtcViewport) webRtcViewport.removeEventListener('wheel', handleWebRtcZoomWheel);
    };
  }, [hasActiveViewerSource, activeTab]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    videoEl.style.transform = playbackViewTransform(hlsView) || '';
    videoEl.style.transformOrigin = 'top left';
    videoEl.style.filter = `brightness(${hlsBrightness}%) contrast(${hlsContrast}%)`;
  }, [hlsView, hlsBrightness, hlsContrast]);

  /** Captures the currently displayed video view and downloads it as a PNG. */
  const downloadVideoSnapshot = (video, playbackKind, {
    displayAspect = null,
    view = INITIAL_PLAYBACK_VIEW,
    brightness = DEFAULT_IMAGE_ADJUSTMENT,
    contrast = DEFAULT_IMAGE_ADJUSTMENT
  } = {}) => {
    const width = Number(video?.videoWidth);
    const height = Number(video?.videoHeight);
    if (!video || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      setStatus(`${playbackKind} snapshot is unavailable until video frames are flowing.`);
      return;
    }

    try {
      const canvas = document.createElement('canvas');
      // A WebRTC decoder can expose coded dimensions (1440×1080) even when
      // the source's DAR is 16:9.  Stretch only the exported image, matching
      // the player presentation; the live video itself is never re-encoded.
      const outputWidth = displayAspect && Number.isFinite(displayAspect.value)
        ? Math.max(1, Math.round(height * displayAspect.value))
        : width;
      canvas.width = outputWidth;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('browser did not provide a canvas context');
      // The player transforms around its top-left corner, then clips the
      // result to its viewport. Reproduce that view by cropping the same
      // normalized source region and scaling it back to the displayed frame.
      const zoom = clampPlaybackZoom(view?.zoom ?? PLAYBACK_ZOOM_MIN);
      const sourceWidth = width / zoom;
      const sourceHeight = height / zoom;
      const sourceX = (width - sourceWidth) * clampUnit(view?.panX ?? 0.5);
      const sourceY = (height - sourceHeight) * clampUnit(view?.panY ?? 0.5);
      const snapshotBrightness = Math.min(IMAGE_ADJUSTMENT_MAX, Math.max(IMAGE_ADJUSTMENT_MIN, Number(brightness) || DEFAULT_IMAGE_ADJUSTMENT));
      const snapshotContrast = Math.min(IMAGE_ADJUSTMENT_MAX, Math.max(IMAGE_ADJUSTMENT_MIN, Number(contrast) || DEFAULT_IMAGE_ADJUSTMENT));
      context.filter = `brightness(${snapshotBrightness}%) contrast(${snapshotContrast}%)`;
      context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, height);
      canvas.toBlob((blob) => {
        if (!blob) {
          setStatus(`${playbackKind} snapshot could not be encoded.`);
          return;
        }
        const safeStreamId = String(streamIdRef.current || 'stream').replace(/[^a-z0-9_-]+/gi, '_');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const href = URL.createObjectURL(blob);
        const download = document.createElement('a');
        download.href = href;
        download.download = `${safeStreamId}-${playbackKind.toLowerCase()}-${timestamp}.png`;
        document.body.appendChild(download);
        download.click();
        download.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        setStatus(`${playbackKind} snapshot downloaded.`);
      }, 'image/png');
    } catch (error) {
      setStatus(`${playbackKind} snapshot failed: ${String(error?.message || error)}`);
    }
  };

  const downloadHlsSnapshot = () => downloadVideoSnapshot(videoRef.current, 'HLS', {
    view: hlsView,
    brightness: hlsBrightness,
    contrast: hlsContrast
  });
  const downloadWebRtcSnapshot = () => downloadVideoSnapshot(liveVideoRef.current, 'WebRTC', {
    displayAspect: liveDisplayAspect,
    view: webRtcView,
    brightness: webRtcBrightness,
    contrast: webRtcContrast
  });

  const downloadKlvExport = async (format) => {
    if (!klvExportAvailable || klvExportInFlight) return;
    const normalizedFormat = format === 'kml' ? 'kml' : 'csv';
    setKlvExportInFlight(normalizedFormat);
    let response = null;
    try {
      response = await fetch(`/streams/${encodeURIComponent(streamId)}/klv/export.${normalizedFormat}`);
      markServerOnline();
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `KLV ${normalizedFormat.toUpperCase()} export failed (HTTP ${response.status})`);
      }
      const blob = await response.blob();
      const safeStreamId = String(streamId || 'stream').replace(/[^a-z0-9_-]+/gi, '_');
      const href = URL.createObjectURL(blob);
      const download = document.createElement('a');
      download.href = href;
      download.download = `${safeStreamId}-klv-telemetry.${normalizedFormat}`;
      document.body.appendChild(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setStatus(`KLV telemetry ${normalizedFormat.toUpperCase()} downloaded.`);
    } catch (error) {
      if (!response) markServerOffline(error);
      setStatus(`KLV ${normalizedFormat.toUpperCase()} export failed: ${String(error?.message || error)}`);
    } finally {
      setKlvExportInFlight(null);
    }
  };

  const downloadAuthoritativeSnapshot = async () => {
    if (!currentSourceIsFile || authoritativeSnapshotInFlight) return;
    const player = getActiveHlsPlayer();
    const timeSeconds = Number(player?.currentTime?.());
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      setStatus('The player must be ready before creating an authoritative snapshot.');
      return;
    }

    setAuthoritativeSnapshotInFlight(true);
    setStatus('Creating authoritative source snapshot…');
    let response = null;
    try {
      response = await fetch(`/sources/${encodeURIComponent(streamId)}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeSeconds })
      });
      markServerOnline();
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Snapshot request failed (HTTP ${response.status})`);
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('The authoritative snapshot was empty.');
      const safeStreamId = String(streamId || 'stream').replace(/[^a-z0-9_-]+/gi, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const href = URL.createObjectURL(blob);
      const download = document.createElement('a');
      download.href = href;
      download.download = `${safeStreamId}-authoritative-snapshot-${timestamp}.jpg`;
      document.body.appendChild(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setStatus('Authoritative source snapshot downloaded.');
    } catch (error) {
      if (!response) markServerOffline(error);
      setStatus(`Authoritative snapshot failed: ${String(error?.message || error)}`);
    } finally {
      setAuthoritativeSnapshotInFlight(false);
    }
  };

  const previewClipTime = (seconds) => {
    const player = getActiveHlsPlayer();
    if (!player) return;
    const { start, end } = getHlsSeekBounds(player);
    player.currentTime(clampToBounds(seconds, start, end));
  };

  const updateClipBoundary = (boundary, rawValue) => {
    const timelineEnd = clipAvailableEndSeconds;
    const value = Number(rawValue);
    if (!Number.isFinite(timelineEnd) || timelineEnd <= 0 || !Number.isFinite(value)) return;
    const minDuration = MIN_CLIP_DURATION_SECONDS;
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
      setStatus(`The ${playbackPlayerName} is not ready.`);
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
      setStatus(`Clip ready: ${result.clip.filename}. Video copied directly from the uploaded source near a keyframe boundary; KLV embedded: ${result.clip.klvEmbedded ? 'yes' : 'not present in source'}.`);
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
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 'n/a';

    // Keep sub-minute clip boundaries precise, but use compact clock notation
    // once the value is long enough for seconds alone to be hard to scan.
    if (value < 60) return `${value.toFixed(2)}s`;

    const wholeSeconds = Math.floor(value);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainingSeconds = wholeSeconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
      : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  const formatMissionTime = (milliseconds) => {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return 'n/a';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString();
  };

  const targetLogVideoTimeSeconds = (entry) => {
    const value = Number(entry?.videoTimeMs);
    return Number.isFinite(value) && value >= 0 ? value / 1000 : null;
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
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)) - 1);
    const scaled = value / (1024 ** (unitIndex + 1));
    return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${units[unitIndex]}`;
  };

  const formatBytesPerSecond = (bytes) => {
    const value = Number(bytes);
    return Number.isFinite(value) && value >= 0 ? `${formatBytes(value)}/s` : 'n/a';
  };

  const conversionProgress = (source) => {
    const percent = Number(source?.progressPercent);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  };

  const finalizationProgress = (source) => {
    const percent = Number(source?.finalizationProgressPercent);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  };

  const finalizationStatus = (source) => {
    const processed = Number(source?.finalizationProcessedSegments);
    const total = Number(source?.finalizationTotalSegments);
    const etaSeconds = Number(source?.finalizationEtaSeconds);
    const parts = [];
    if (Number.isFinite(processed) && Number.isFinite(total) && total >= 0) {
      parts.push(`${Math.min(processed, total)} / ${total} segments`);
    }
    if (Number.isFinite(etaSeconds) && etaSeconds > 0) {
      parts.push(`ETA ${formatConversionTime(etaSeconds)}`);
    }
    return parts.join(' · ');
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

  const fileIntegrityStatus = (source) => {
    const integrity = source?.integrity;
    if (!integrity) return null;
    const containerLabel = integrity.containerLabel || 'File';
    if (integrity.status === 'pending' || integrity.status === 'scanning') {
      return {
        color: 'yellow',
        label: `Scanning ${containerLabel} integrity`,
        detail: 'Full-file scan running in the background; media packaging continues.'
      };
    }
    if (integrity.status === 'clean') {
      return {
        color: 'green',
        label: `${containerLabel} integrity: clean`,
        detail: 'FFprobe read the full file without corruption warnings.'
      };
    }
    if (integrity.status === 'corrupt') {
      const findingText = Array.isArray(integrity.findings)
        ? integrity.findings.map((finding) => finding?.message).filter(Boolean).join(' ')
        : '';
      return {
        color: 'red',
        label: `${containerLabel} corruption detected`,
        detail: `${findingText ? `${findingText} ` : ''}Valid media will be salvaged when possible; KLV may be incomplete when present.`
      };
    }
    return {
      color: 'yellow',
      label: `${containerLabel} integrity unavailable`,
      detail: integrity.error || 'The full-file integrity scan could not complete.'
    };
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
        try { window.player.playbackRate?.(hlsPlaybackRateRef.current); } catch {}
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
        videoEl.style.transform = playbackViewTransform(hlsView) || "";
        videoEl.style.transformOrigin = "top left";
        videoEl.style.filter = `brightness(${hlsBrightness}%) contrast(${hlsContrast}%)`;
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
        try { player.playbackRate?.(hlsPlaybackRateRef.current); } catch {}
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
        try { player.playbackRate?.(hlsPlaybackRateRef.current); } catch {}
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
        setStatus(`Bound time-shifted text track: label=${String(track.label || 'n/a')} kind=${String(track.kind || 'n/a')} language=${String(track.language || 'n/a')}`);
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
      setLivePlatformHistory(null);
      setLivePlatformHistoryLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    streamIdRef.current = streamId;
    setDvrPlatformHistory(null);
    setLivePlatformHistory(null);
    setDvrPlatformHistoryEnabled(false);
    setLivePlatformHistoryEnabled(false);
    setDvrPlatformHistoryLoading(false);
    setLivePlatformHistoryLoading(false);
  }, [streamId]);

  useEffect(() => {
    setManualVideoStartUtcText(hasManualVideoStartUtc ? new Date(manualVideoStartUtcMs).toISOString() : '');
  }, [hasManualVideoStartUtc, manualVideoStartUtcMs]);

  useEffect(() => {
    serverOnlineRef.current = serverOnline;
  }, [serverOnline]);

  useEffect(() => {
    dvrPlatformHistoryUntilMsRef.current = dvrPlatformHistoryUntilMs;
  }, [dvrPlatformHistoryUntilMs]);

  useEffect(() => {
    livePlatformHistoryUntilMsRef.current = livePlatformHistoryUntilMs;
  }, [livePlatformHistoryUntilMs]);

  useEffect(() => {
    // File playback can cache its full compact route and trim it locally to
    // the cue. Time-shifted live HLS instead requests the current rolling
    // window, just like the WebRTC view, so old DVR history is never loaded.
    const needsRollingWindow = !currentSourceIsFile;
    if (!dvrPlatformHistoryEnabled || activeTab !== 'dvr' || !canLoadDvrPlatformHistory
      || (needsRollingWindow && !dvrPlatformHistoryTimeAvailable)) {
      if (!dvrPlatformHistoryEnabled) setDvrPlatformHistory(null);
      setDvrPlatformHistoryLoading(false);
      return undefined;
    }

    let cancelled = false;
    const refresh = async () => {
      const toMs = dvrPlatformHistoryUntilMsRef.current;
      if (needsRollingWindow && !Number.isFinite(toMs)) return;
      setDvrPlatformHistoryLoading(true);
      try {
        const history = needsRollingWindow
          ? await fetchPlatformHistory({ fromMs: toMs - LIVE_PLATFORM_HISTORY_WINDOW_MS, toMs })
          : await fetchPlatformHistory();
        if (!cancelled) setDvrPlatformHistory(history);
      } catch {
        if (!cancelled) setDvrPlatformHistory(null);
      } finally {
        if (!cancelled) setDvrPlatformHistoryLoading(false);
      }
    };
    void refresh();
    // A file can be viewed during processing. Refresh it until its finite HLS
    // playlist and KLV sidecars finish; live HLS always refreshes its window.
    const isStillProcessing = ['starting', 'running', 'finalizing'].includes(streamRuntime?.state);
    const timer = (needsRollingWindow || isStillProcessing)
      ? setInterval(() => { void refresh(); }, PLATFORM_HISTORY_REFRESH_MS)
      : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [dvrPlatformHistoryEnabled, activeTab, canLoadDvrPlatformHistory, currentSourceIsFile, dvrPlatformHistoryTimeAvailable, streamId, streamRuntime?.state]);

  useEffect(() => {
    if (!livePlatformHistoryEnabled || activeTab !== 'live-webrtc' || !canLoadLivePlatformHistory || !livePlatformHistoryTimeAvailable) {
      if (!livePlatformHistoryEnabled) setLivePlatformHistory(null);
      setLivePlatformHistoryLoading(false);
      return undefined;
    }

    let cancelled = false;
    const refresh = async () => {
      const toMs = livePlatformHistoryUntilMsRef.current;
      if (!Number.isFinite(toMs)) return;
      setLivePlatformHistoryLoading(true);
      try {
        const history = await fetchPlatformHistory({
          fromMs: toMs - LIVE_PLATFORM_HISTORY_WINDOW_MS,
          toMs
        });
        if (!cancelled) setLivePlatformHistory(history);
      } catch {
        if (!cancelled) setLivePlatformHistory(null);
      } finally {
        if (!cancelled) setLivePlatformHistoryLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, PLATFORM_HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [livePlatformHistoryEnabled, activeTab, canLoadLivePlatformHistory, livePlatformHistoryTimeAvailable, streamId]);

  useEffect(() => {
    if (sourceType !== 'local-file' || !serverOnline) return;
    void refreshLocalServerFiles();
  }, [sourceType, serverOnline]);

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
    // A new file begins with no completed segment. Initialize only after the
    // backend has verified a playable HLS boundary, never at full source time.
    if (!currentSourceIsFile || !Number.isFinite(clipTimelineEndSeconds) || !Number.isFinite(clipAvailableEndSeconds)
      || clipAvailableEndSeconds < MIN_CLIP_DURATION_SECONDS) {
      clipRangeStreamRef.current = null;
      clipAvailableEndRef.current = null;
      return;
    }
    if (clipRangeStreamRef.current === streamId) return;
    clipRangeStreamRef.current = streamId;
    setClipStartSeconds(0);
    setClipEndSeconds(clipAvailableEndSeconds);
    setClipResult(null);
  }, [currentSourceIsFile, streamId, clipTimelineEndSeconds, clipAvailableEndSeconds]);

  useEffect(() => {
    // Segment availability normally advances, but clamping also keeps handles
    // safe if a source is reset or a transient playlist read reports less data.
    if (!Number.isFinite(clipAvailableEndSeconds) || clipAvailableEndSeconds < MIN_CLIP_DURATION_SECONDS) return;
    const previousAvailableEnd = clipAvailableEndRef.current;
    if (!Number.isFinite(previousAvailableEnd)) {
      // The range-initialization effect in this render owns the first end
      // value. Record its availability without racing that state update.
      clipAvailableEndRef.current = clipAvailableEndSeconds;
      return;
    }
    const endFollowsAvailableEdge = Number.isFinite(previousAvailableEnd)
      && Math.abs(clipEndSeconds - previousAvailableEnd) < 0.01;
    clipAvailableEndRef.current = clipAvailableEndSeconds;
    const maximumStart = Math.max(0, clipAvailableEndSeconds - MIN_CLIP_DURATION_SECONDS);
    setClipStartSeconds((previous) => Math.min(Math.max(0, previous), maximumStart));
    setClipEndSeconds((previous) => Math.min(
      clipAvailableEndSeconds,
      Math.max(
        clipStartSeconds + MIN_CLIP_DURATION_SECONDS,
        endFollowsAvailableEdge ? clipAvailableEndSeconds : previous
      )
    ));
  }, [clipAvailableEndSeconds, clipStartSeconds, clipEndSeconds]);

  useEffect(() => {
    let cancelled = false;
    if (!clipWidgetReady) {
      setClipThumbnailFrames([]);
      setClipThumbnailLoading(false);
      return () => { cancelled = true; };
    }
    setClipThumbnailLoading(true);
    void api(`/sources/${encodeURIComponent(streamId)}/clip-thumbnails`)
      .then((result) => {
        if (cancelled || !result?.ok || !Array.isArray(result.thumbnails)) return;
        setClipThumbnailFrames(result.thumbnails);
      })
      .catch(() => {
        if (!cancelled) setClipThumbnailFrames([]);
      })
      .finally(() => {
        if (!cancelled) setClipThumbnailLoading(false);
      });
    return () => { cancelled = true; };
  }, [clipWidgetReady, streamId, clipTimelineEndSeconds]);

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
    setTargetLogEntries([]);
    setTargetLogFields([]);
    setSelectedTargetLogId(null);
    setTargetLogEditor(null);
    if (serverOnline) void refreshTargetLog(streamId, { silent: true });
  }, [streamId, serverOnline]);

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
  const targetLogActiveFields = targetLogFields.filter((field) => field.active);
  const selectedTargetLogEntry = targetLogEntries.find((entry) => entry.id === selectedTargetLogId) || null;
  const missionTimeValidationError = targetLogEditor ? targetLogMissionTimeError(targetLogEditor.missionTimeText) : null;
  const missionTimePickerValue = targetLogEditor && !missionTimeValidationError
    ? new Date(parseTargetLogMissionTime(targetLogEditor.missionTimeText))
    : null;
  const manualVideoAnchorPickerValue = (() => {
    const parsed = Date.parse(manualVideoStartUtcText);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  })();
  const activeHlsRendition = activeHlsMode === 'abr'
    ? activeHlsRenditions.find((rendition) => (
      [dvrDiag.currentPlaylistUri, dvrDiag.currentPlaylistResolvedUri]
        .filter(Boolean)
        .some((uri) => String(uri).includes(rendition.playlist))
    ))
    : null;
  const activeHlsRenditionLabel = activeHlsRendition
    ? `${activeHlsRendition.id} | ${activeHlsRendition.width}×${activeHlsRendition.height} | ${activeHlsRendition.processing === 'source-copy' ? 'source copy' : `encoded ${activeHlsRendition.videoBitrate || ''}`.trim()}`
    : dvrDiag.currentPlaylistUri || dvrDiag.currentPlaylistResolvedUri
      ? activeHlsMode === 'single-transcode'
        ? 'single transcoded rendition'
        : 'source (single rendition)'
      : 'n/a';
  const hlsRenditionPlanLabel = activeHlsMode === 'abr'
    ? activeHlsRenditions.map((rendition) => `${rendition.id}: ${rendition.processing === 'source-copy' ? 'source copy' : `encoded ${rendition.videoBitrate || ''}`.trim()}`).join(' · ')
    : null;
  return (
    <MantineProvider theme={theme}>
      <AppShell
        header={{ height: 60 }}
        padding="md"
      >
        <AppShell.Header>
          <Group justify="space-between" align="center" px="md" h="100%">
            <Text size="lg" fw={700}>FMV PED 0-1 PoC</Text>
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
                  w={180}
                  label="Stream ID"
                  value={streamId}
                  onChange={(e) => setStreamId(e.target.value)}
                />
                <Select
                  w={230}
                  label="Source type"
                  data={[
                    { value: 'stream', label: 'Stream URL' },
                    { value: 'file', label: 'Upload video file' },
                    { value: 'local-file', label: 'Select server video' }
                  ]}
                  value={sourceType}
                  onChange={(value) => setSourceType(value || 'stream')}
                  allowDeselect={false}
                />
                {sourceType === 'stream' ? <>
                  <TextInput
                    style={{ flex: 1, minWidth: 0 }}
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
                </> : sourceType === 'file' ? <FileInput
                  style={{ flex: 1, minWidth: 0 }}
                  label="Video file"
                  placeholder="Choose a video file"
                  value={videoFile}
                  onChange={setVideoFile}
                  accept="video/*,.ts,.m2ts"
                  clearable
                /> : <>
                  <Select
                    style={{ flex: 1, minWidth: 0 }}
                    label="Local server video"
                    placeholder={localServerFilesLoading ? 'Loading local videos...' : 'Choose a video from the server videos folder'}
                    value={localServerPath || null}
                    onChange={(value) => setLocalServerPath(value || '')}
                    data={localServerFiles.map((file) => ({
                      value: file.inputPath,
                      label: `${file.relativePath} (${formatBytes(file.sizeBytes)})`
                    }))}
                    searchable
                    clearable
                    nothingFoundMessage={localServerFilesLoading ? 'Loading...' : 'No supported video files found'}
                    disabled={localServerFilesLoading}
                  />
                  <Button variant="light" onClick={refreshLocalServerFiles} loading={localServerFilesLoading} disabled={!serverOnline}>
                    Refresh files
                  </Button>
                </>}
              </Group>
              {sourceType === 'file' ? (
                <Text size="xs" mt="xs" c="dimmed">The file uploads to this server, then packages into HLS and segmented WebVTT. Playback is available in Post Mission Playback; WebRTC is disabled.</Text>
              ) : sourceType === 'local-file' ? (
                <Text size="xs" mt="xs" c="dimmed">Choose a supported file from the server&apos;s videos folder. The server copies it directly into the authoritative source folder without a browser upload. Playback is available in Post Mission Playback; WebRTC is disabled.</Text>
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
                  description="Passthrough copies H.264 video (no audio); ABR creates three streams."
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
                  disabled={selectedFileSource}
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
                  {(hlsRuntimeIsActive ? streamRuntime?.sourceType !== 'file' : !selectedFileSource)
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
                  {(() => {
                    const integrityStatus = fileIntegrityStatus(streamRuntime);
                    return integrityStatus ? (
                      <Group gap="xs" align="flex-start">
                        <Badge color={integrityStatus.color} variant="light">{integrityStatus.label}</Badge>
                        <Text size="xs" c={integrityStatus.color === 'red' ? 'red' : 'dimmed'} style={{ flex: 1 }}>
                          {integrityStatus.detail}
                        </Text>
                      </Group>
                    ) : null;
                  })()}
                  <Group justify="space-between">
                    <Text size="xs">Conversion ({streamRuntime?.state || 'preparing'}): {conversionProgress(streamRuntime) != null ? `${conversionProgress(streamRuntime).toFixed(1)}%` : 'Preparing...'}</Text>
                    <Text size="xs" c="dimmed">
                      {formatConversionTime(streamRuntime.processedSeconds)} / {formatConversionTime(streamRuntime.durationSeconds)}
                      {Number.isFinite(Number(streamRuntime.encodeSpeed)) ? ` · ${Number(streamRuntime.encodeSpeed).toFixed(2)}x` : ''}
                      {Number.isFinite(Number(streamRuntime.etaSeconds)) ? ` · ETA ${formatConversionTime(streamRuntime.etaSeconds)}` : ''}
                    </Text>
                  </Group>
                  <Progress value={conversionProgress(streamRuntime) || 0} animated={streamRuntime?.state === 'running'} />
                  {streamRuntime?.state === 'finalizing' ? (
                    <>
                      <Group justify="space-between">
                        <Text size="xs">Finalizing KLV/VTT: {finalizationProgress(streamRuntime) != null ? `${finalizationProgress(streamRuntime).toFixed(1)}%` : 'Starting...'}</Text>
                        <Text size="xs" c="dimmed">{finalizationStatus(streamRuntime) || 'Preparing final segment data...'}</Text>
                      </Group>
                      <Progress value={finalizationProgress(streamRuntime) || 0} color="yellow" animated />
                    </>
                  ) : null}
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
                              const integrityStatus = fileIntegrityStatus(s);
                              return <>
                                <Group gap="xs" wrap="wrap">
                                  <Badge color={klvStatus.color} variant="light">{klvStatus.label}</Badge>
                                  {integrityStatus ? <Badge color={integrityStatus.color} variant="light">{integrityStatus.label}</Badge> : null}
                                </Group>
                                {integrityStatus ? (
                                  <Text size="xs" c={integrityStatus.color === 'red' ? 'red' : 'dimmed'}>{integrityStatus.detail}</Text>
                                ) : null}
                              </>;
                            })()}
                            <Text size="xs" c="dimmed">
                              conversion: {conversionProgress(s) != null ? `${conversionProgress(s).toFixed(1)}%` : 'preparing'} · {formatConversionTime(s.processedSeconds)} / {formatConversionTime(s.durationSeconds)}
                              {Number.isFinite(Number(s.encodeSpeed)) ? ` · ${Number(s.encodeSpeed).toFixed(2)}x` : ''}
                              {Number.isFinite(Number(s.etaSeconds)) ? ` · ETA ${formatConversionTime(s.etaSeconds)}` : ''}
                            </Text>
                            <Progress value={conversionProgress(s) || 0} animated={s.state === 'running'} size="sm" />
                            {s.state === 'finalizing' ? (
                              <>
                                <Text size="xs" c="dimmed">
                                  finalizing KLV/VTT: {finalizationProgress(s) != null ? `${finalizationProgress(s).toFixed(1)}%` : 'starting'}
                                  {finalizationStatus(s) ? ` · ${finalizationStatus(s)}` : ''}
                                </Text>
                                <Progress value={finalizationProgress(s) || 0} color="yellow" animated size="sm" />
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </Stack>
                    </Group>
                  </Paper>
                )) : <Text size="sm" c="dimmed">No active sources</Text>}
              </Stack>
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>FMV Viewer</Text>
              {hasActiveViewerSource ? <>
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  <Tabs.Tab value="dvr">{playbackTitle}</Tabs.Tab>
                  {!currentSourceIsFile ? <Tabs.Tab value="live-webrtc">Live (WebRTC)</Tabs.Tab> : null}
                </Tabs.List>

                <Tabs.Panel value="dvr" pt="xs">
                  <Text>{playbackDescription}</Text>
                  <Group mt="xs" align="flex-start" grow wrap="wrap">
                    <Paper p="sm" withBorder style={{ flex: 2, minWidth: 320 }}>
                      <Group gap="xs" mb="xs">
                        <Text size="sm" c="dimmed">Status: {dvrStatus}</Text>
                        <Badge color={dvrBadge.color} variant="light">{dvrBadge.label}</Badge>
                      </Group>
                      <Accordion defaultValue="quality-details" variant="contained" mb="xs">
                        <Accordion.Item value="quality-details">
                          <Accordion.Control>Video Quality &amp; Stream Details</Accordion.Control>
                          <Accordion.Panel>
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
                              : `Manual selection becomes available when the ${playbackPlayerName} is ready.`}
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
                      {hlsRenditionPlanLabel ? (
                        <Text size="xs" c="dimmed" mb="xs">ABR processing: {hlsRenditionPlanLabel}</Text>
                      ) : null}
                      <Text size="xs" c="dimmed" mb="xs">
                        segment: {dvrDiag.currentSegmentSequence != null ? dvrDiag.currentSegmentSequence : 'n/a'}{dvrDiag.currentSegmentUri ? ` (${dvrDiag.currentSegmentUri})` : ''} | subtitle: {dvrDiag.currentSubtitleUri || 'n/a'}
                      </Text>
                      {dvrDiag.error ? (
                        <Text size="xs" c="red" mb="xs">error: {dvrDiag.error}</Text>
                      ) : null}
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                      <div
                        ref={dvrVideoHostRef}
                        style={{ width: '100%', minHeight: '180px', overflow: 'hidden', cursor: hlsPanning ? 'grabbing' : hlsView.zoom > 1 ? 'grab' : undefined }}
                        onPointerDownCapture={beginHlsPan}
                        onPointerMoveCapture={moveHlsPan}
                        onPointerUpCapture={endHlsPan}
                        onPointerCancelCapture={endHlsPan}
                      />
                       <Text size="xs" c="dimmed" mt="xs">
                         {currentSourceIsFile
                           ? `player time: ${formatPlayerTime(dvrDiag.currentTimeSec)} / ${formatPlayerTime(dvrDiag.durationSec)}`
                          : `Playback delay: ${formatPlayerTime(liveBehindSeconds)} behind HLS edge · playback window: ${formatPlayerTime(liveDvrWindowSeconds)}`}
                       </Text>
                      {canEditManualVideoAnchor ? (
                        <Paper p="xs" withBorder mt="xs">
                          <Text size="sm" fw={600}>Mission Timestamp</Text>
                          <Text size="xs" c="dimmed" mb="xs">
                            Set the UTC mission timestamp of the first presentation frame. Playback time is derived from the HLS presentation timeline; this is manually assigned, not KLV telemetry.
                          </Text>
                          <Group align="end" gap="xs" wrap="wrap">
                            <DateTimePicker
                              label="First video frame"
                              description="Choose in your local time zone; it is saved and displayed as UTC."
                              value={manualVideoAnchorPickerValue}
                              onChange={(value) => setManualVideoStartUtcText(value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : '')}
                              valueFormat="YYYY-MM-DD HH:mm:ss"
                              withSeconds
                              clearable
                              style={{ flex: '1 1 300px' }}
                            />
                            <Button size="xs" onClick={saveManualVideoTimeAnchor} loading={manualVideoAnchorInFlight} disabled={!manualVideoStartUtcText.trim()}>Save UTC</Button>
                            {hasManualVideoStartUtc ? <Button size="xs" variant="default" onClick={clearManualVideoTimeAnchor} loading={manualVideoAnchorInFlight}>Clear</Button> : null}
                          </Group>
                          <Text size="xs" c={hasManualVideoStartUtc ? 'teal' : 'dimmed'} mt="xs">
                            {hasManualVideoStartUtc && Number.isFinite(manualVideoUtcMs)
                              ? `Current video UTC: ${new Date(manualVideoUtcMs).toISOString()} (PTS-backed playback time)`
                              : 'No mission timestamp is set.'}
                          </Text>
                        </Paper>
                      ) : null}
                      {activeTab === 'dvr' && hlsMediaLoaded ? (
                        <Group mt="xs" gap="xs" justify="center">
                          <Tooltip label="Play from start" withArrow><ActionIcon variant="light" size="lg" onClick={seekHlsToStart} aria-label="Play from start"><PlaybackControlIcon name="start" /></ActionIcon></Tooltip>
                          <Tooltip label="Rewind 15 seconds" withArrow><ActionIcon variant="light" size="lg" onClick={() => seekHlsBySeconds(-15)} aria-label="Rewind 15 seconds"><PlaybackControlIcon name="rewind" /></ActionIcon></Tooltip>
                          {clipSourceIsActive ? <Tooltip label="Seek to clip start marker" withArrow><ActionIcon variant="light" size="lg" onClick={() => seekHlsToClipMarker('start')} disabled={!clipWidgetReady} aria-label="Seek to clip start marker"><PlaybackControlIcon name="clipStart" /></ActionIcon></Tooltip> : null}
                          <Tooltip label="Pause or play" withArrow><ActionIcon variant="light" size="lg" onClick={toggleHlsPlayPause} aria-label="Pause or play"><PlaybackControlIcon name="playPause" /></ActionIcon></Tooltip>
                          {clipSourceIsActive ? <Tooltip label="Seek to clip end marker" withArrow><ActionIcon variant="light" size="lg" onClick={() => seekHlsToClipMarker('end')} disabled={!clipWidgetReady} aria-label="Seek to clip end marker"><PlaybackControlIcon name="clipEnd" /></ActionIcon></Tooltip> : null}
                          <Tooltip label="Fast-forward 15 seconds" withArrow><ActionIcon variant="light" size="lg" onClick={() => seekHlsBySeconds(15)} aria-label="Fast-forward 15 seconds"><PlaybackControlIcon name="forward" /></ActionIcon></Tooltip>
                          <Tooltip label="Go to end" withArrow><ActionIcon variant="light" size="lg" onClick={seekHlsToEnd} aria-label="Go to end"><PlaybackControlIcon name="end" /></ActionIcon></Tooltip>
                          <PlaybackZoomControls zoom={hlsView.zoom} onZoomChange={changeHlsZoom} />
                          <ImageAdjustmentMenu
                            brightness={hlsBrightness}
                            contrast={hlsContrast}
                            onBrightnessChange={setHlsBrightness}
                            onContrastChange={setHlsContrast}
                          />
                          <Menu shadow="md" width={152} position="top" withArrow>
                            <Menu.Target>
                              <Tooltip label="Playback speed" withArrow>
                                <ActionIcon variant="light" size="lg" aria-label={currentSourceIsFile ? 'Playback speed' : 'HLS playback speed'}>
                                  <Text size="xs" fw={700}>{formatHlsPlaybackRate(hlsPlaybackRate)}</Text>
                                </ActionIcon>
                              </Tooltip>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>Playback speed</Menu.Label>
                              {HLS_PLAYBACK_RATES.map((rate) => (
                                <Menu.Item
                                  key={rate}
                                  onClick={() => setHlsPlaybackSpeed(rate)}
                                  rightSection={rate === hlsPlaybackRate ? '✓' : null}
                                >
                                  {formatHlsPlaybackRate(rate)}
                                </Menu.Item>
                              ))}
                            </Menu.Dropdown>
                          </Menu>
                          {currentSourceIsFile ? (
                            <Menu shadow="md" width={235} position="top" withArrow>
                              <Menu.Target>
                                <Tooltip label={authoritativeSnapshotInFlight ? 'Creating authoritative snapshot…' : 'Download snapshot'} withArrow>
                                  <ActionIcon
                                    variant="light"
                                    size="lg"
                                    aria-label={authoritativeSnapshotInFlight ? 'Creating authoritative snapshot' : 'Download snapshot'}
                                    aria-busy={authoritativeSnapshotInFlight}
                                    disabled={authoritativeSnapshotInFlight}
                                  >
                                    {authoritativeSnapshotInFlight ? <Loader size={16} /> : <PlaybackControlIcon name="snapshot" />}
                                  </ActionIcon>
                                </Tooltip>
                              </Menu.Target>
                              <Menu.Dropdown>
                                <Menu.Label>Download snapshot</Menu.Label>
                                <Menu.Item onClick={downloadAuthoritativeSnapshot} disabled={!hlsMediaLoaded || authoritativeSnapshotInFlight}>
                                  {authoritativeSnapshotInFlight ? 'Creating authoritative snapshot…' : 'Authoritative uploaded source (FFmpeg)'}
                                </Menu.Item>
                                <Menu.Item onClick={downloadHlsSnapshot} disabled={!hlsMediaLoaded}>Displayed playback frame (with adjustments)</Menu.Item>
                              </Menu.Dropdown>
                            </Menu>
                          ) : <Tooltip label="Download snapshot" withArrow><ActionIcon variant="light" size="lg" onClick={downloadHlsSnapshot} aria-label="Download HLS snapshot"><PlaybackControlIcon name="snapshot" /></ActionIcon></Tooltip>}
                          <Tooltip label="Add target mark" withArrow><ActionIcon variant="light" size="lg" onClick={openNewTargetLogEntry} disabled={!canAddTargetMark} aria-label="Add target mark"><PlaybackControlIcon name="targetMark" /></ActionIcon></Tooltip>
                        </Group>
                      ) : null}
                       {clipSourceIsActive ? (
                         <div className="clip-widget" aria-label="Video clip selection">
                           <Group justify="space-between" align="center" mb={4}>
                             <div>
                               <Text size="sm" fw={700}>Create video clip</Text>
                              <Text size="xs" c="dimmed">Drag either edge to preview a playable point. Exports stream-copy the uploaded source and may begin at a preceding keyframe.</Text>
                             </div>
                             <Group gap="xs">
                               {clipThumbnailLoading ? <Badge color="blue" variant="light">Building thumbnails…</Badge> : null}
                               {streamRuntime?.state !== 'ready' ? (
                                 <Badge color={clipWidgetReady ? 'yellow' : 'gray'} variant="light">
                                   {clipWidgetReady ? `Playable through ${formatPlayerTime(clipAvailableEndSeconds)}` : 'Waiting for first segment…'}
                                 </Badge>
                               ) : null}
                               <Badge color={streamRuntime?.klvProbe?.available ? 'teal' : 'gray'} variant="light">
                                 {streamRuntime?.klvProbe?.available ? 'KLV preserved' : 'No KLV detected'}
                               </Badge>
                             </Group>
                           </Group>
                           <div
                             ref={clipTrimShellRef}
                             className={`clip-trim-shell${clipWidgetReady ? '' : ' is-disabled'}`}
                             onPointerDown={beginClipPointerDrag}
                             onPointerMove={moveClipPointerDrag}
                             onPointerUp={endClipPointerDrag}
                             onPointerCancel={endClipPointerDrag}
                            >
                             <div className={`clip-filmstrip${clipThumbnailFrames.length ? ' has-thumbnails' : ''}`} aria-hidden="true">
                               {clipThumbnailFrames.length
                                 ? clipThumbnailFrames.map((thumbnail, index) => <img key={thumbnail.url || index} src={thumbnail.url} alt="" />)
                                 : Array.from({ length: 12 }, (_, index) => <span key={index} />)}
                             </div>
                             {clipAvailabilityPercent < 100 ? (
                               <div
                                 className="clip-unavailable-tail"
                                 style={{ left: `${clipAvailabilityPercent}%` }}
                                 aria-hidden="true"
                               />
                             ) : null}
                             {clipWidgetReady ? (
                               <>
                                 {targetLogEntries.filter((entry) => {
                                   const seconds = targetLogVideoTimeSeconds(entry);
                                   return Number.isFinite(seconds) && seconds >= 0 && seconds <= clipAvailableEndSeconds;
                                 }).map((entry, index) => {
                                   const left = (targetLogVideoTimeSeconds(entry) / clipTimelineEndSeconds) * 100;
                                   const positionText = entry.position
                                     ? `${entry.position.lat.toFixed(5)}, ${entry.position.lon.toFixed(5)}`
                                     : 'Position unavailable';
                                   return <Tooltip key={entry.id} multiline w={280} label={`${formatMissionTime(entry.missionTimeMs)} · ${entry.observation || 'No observation'} · ${positionText}`} withArrow>
                                     <button
                                       type="button"
                                       className={`clip-target-log-marker${entry.id === selectedTargetLogId ? ' is-selected' : ''}`}
                                       style={{ left: `calc(${left}% - 6px)`, transform: `translateX(${((index % 3) - 1) * 4}px)` }}
                                       onPointerDown={(event) => event.stopPropagation()}
                                       onClick={() => seekTargetLogEntry(entry)}
                                       aria-label={`Seek to target mark at mission time ${formatMissionTime(entry.missionTimeMs)}`}
                                     />
                                   </Tooltip>;
                                 })}
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
                             {streamRuntime?.state !== 'ready' ? <span><b>Playable</b> {formatPlayerTime(clipAvailableEndSeconds)}</span> : null}
                           </Group>
                           <Group mt="xs" gap="xs" wrap="wrap">
                             <Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('start')} disabled={!clipWidgetReady || clipInFlight}>Set start at playhead</Button>
                             <Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('end')} disabled={!clipWidgetReady || clipInFlight}>Set end at playhead</Button>
                             <Button size="xs" color="dark" onClick={createClip} loading={clipInFlight} disabled={!clipExportReady || clipDurationSeconds < 0.25}>
                               Create &amp; download clip
                             </Button>
                           </Group>
                           {!clipExportReady ? (
                             <Text size="xs" c="yellow" mt="xs">Future source time is grayed out. Clip handles cannot move past the last completed HLS segment; download becomes available when file packaging completes.</Text>
                           ) : null}
                           <Text size="xs" c="dimmed" mt="xs">
                             Downloads directly from the uploaded source as MPEG-TS with copied video, audio, and KLV. Starts may move to a preceding keyframe; live streams cannot be clipped.
                           </Text>
                           {clipResult ? (
                             <Text size="xs" c="teal" mt={4}>Ready: {clipResult.filename} · uploaded source copied · embedded KLV: {clipResult.klvEmbedded ? 'yes' : 'not present in source'}</Text>
                           ) : null}
                         </div>
                       ) : (
                         <Text size="xs" c="dimmed" mt="sm">Clip creation is available only for uploaded, file-backed video. Live streams remain view-only.</Text>
                       )}
                    </Paper>
                    <Paper p="sm" withBorder style={{ flex: 1, minWidth: 280 }}>
                      <Group justify="space-between" align="center">
                        <Text size="sm" fw={600}>VTT with KLV Telemetry</Text>
                        <Menu shadow="md" width={190} position="bottom-end" withArrow>
                          <Menu.Target>
                            <Tooltip label={klvExportAvailable ? "Export KLV data" : klvExportUnavailableMessage} withArrow><ActionIcon variant="light" size="sm" disabled={!klvExportAvailable || !!klvExportInFlight} loading={!!klvExportInFlight} aria-label="Export KLV data"><PlaybackControlIcon name="exportCsv" /></ActionIcon></Tooltip>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Label>Export KLV data</Menu.Label>
                            <Menu.Item onClick={() => downloadKlvExport('csv')} disabled={!klvExportAvailable || !!klvExportInFlight}>Export as CSV</Menu.Item>
                            <Menu.Item onClick={() => downloadKlvExport('kml')} disabled={!klvExportAvailable || !!klvExportInFlight}>Export as KML</Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
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
                          <Text size="xs" c="dimmed" mb="xs">Following the active WebVTT cue. Click an empty map area to place a target mark; select an existing target pin to seek to it.</Text>
                          <KlvMap
                            telemetry={overlayData?.mode === 'dvr-vtt' ? overlayData : null}
                            active={activeTab === 'dvr' && dvrTelemetryTab === 'map'}
                            platformHistory={Number.isFinite(dvrPlatformHistoryUntilMs) ? dvrPlatformHistory : null}
                            platformHistoryUntilMs={dvrPlatformHistoryUntilMs}
                            showPlatformHistory={dvrPlatformHistoryEnabled}
                            onPlatformHistoryToggle={setDvrPlatformHistoryEnabled}
                            platformHistoryLoading={dvrPlatformHistoryLoading}
                            onPositionSelect={openNewTargetLogEntry}
                            onPointerCoordinate={updateDvrMapPointerPosition}
                            targetLogEntries={targetLogEntries}
                            selectedTargetLogId={selectedTargetLogId}
                            onTargetLogSelect={selectTargetLogEntryById}
                          />
                          <Group mt="xs" justify="space-between" gap="xs" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                              Mission timestamp: {overlayData?.mode === 'dvr-vtt' && overlayData.timestampIso ? overlayData.timestampIso : 'n/a'}
                            </Text>
                            <Text size="xs" c="dimmed" style={{ textAlign: 'right' }}>
                              {formatMapPointerPosition(dvrMapPointerPosition)}
                            </Text>
                          </Group>
                        </Tabs.Panel>
                      </Tabs>
                    </Paper>
                  </Group>
                </Tabs.Panel>

                <Tabs.Panel value="live-webrtc" pt="xs">
                  <Text>Live video via WebRTC with synchronized KLV metadata via WebSocket.
                  </Text>
                  <Group mt="xs" align="flex-start" grow wrap="wrap">
                    <Paper p="sm" withBorder style={{ flex: 2, minWidth: 320 }}>
                      <Group gap="xs" mb="xs">
                        <Text size="sm" c="dimmed">Status: {liveStatus}</Text>
                        <Badge color={webrtcBadge.color} variant="light">{webrtcBadge.label}</Badge>
                      </Group>
                      <Accordion defaultValue="webrtc-details" variant="contained" mb="xs">
                        <Accordion.Item value="webrtc-details">
                          <Accordion.Control>Live Video Stream Details</Accordion.Control>
                          <Accordion.Panel>
                      <Text size="xs" c="dimmed" mb="xs">
                        producerScore: {webrtcDiag.producerScore ?? 'n/a'} | consumerScore: {webrtcDiag.consumerScore ?? 'n/a'} | coded: {webRtcBrowserStats?.frameWidth && webRtcBrowserStats?.frameHeight ? `${webRtcBrowserStats.frameWidth}×${webRtcBrowserStats.frameHeight}` : 'n/a'} | display: {liveDisplayAspectLabel || 'source default'} | bitrate: {webRtcBrowserStats?.bitrateKbps != null ? `${webRtcBrowserStats.bitrateKbps} kbps` : 'n/a'}
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
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                      <div
                        ref={liveVideoViewportRef}
                        style={{ ...liveVideoFrameStyle, overflow: 'hidden', cursor: webRtcPanning ? 'grabbing' : webRtcView.zoom > 1 ? 'grab' : undefined }}
                        onPointerDownCapture={beginWebRtcPan}
                        onPointerMoveCapture={moveWebRtcPan}
                        onPointerUpCapture={endWebRtcPan}
                        onPointerCancelCapture={endWebRtcPan}
                      >
                        <video ref={liveVideoRef} muted playsInline autoPlay style={liveVideoStyle}></video>
                      </div>
                      {liveVideoStreaming ? <Group mt="xs" justify="center">
                        <PlaybackZoomControls zoom={webRtcView.zoom} onZoomChange={changeWebRtcZoom} />
                        <ImageAdjustmentMenu
                          brightness={webRtcBrightness}
                          contrast={webRtcContrast}
                          onBrightnessChange={setWebRtcBrightness}
                          onContrastChange={setWebRtcContrast}
                        />
                        <Tooltip label="Download snapshot" withArrow>
                          <ActionIcon variant="light" size="lg" onClick={downloadWebRtcSnapshot} aria-label="Download WebRTC snapshot">
                            <PlaybackControlIcon name="snapshot" />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Add target mark" withArrow><ActionIcon variant="light" size="lg" onClick={openNewTargetLogEntry} disabled={!canAddTargetMark} aria-label="Add target mark"><PlaybackControlIcon name="targetMark" /></ActionIcon></Tooltip>
                      </Group> : null}
                    </Paper>
                    <Paper p="sm" withBorder style={{ flex: 1, minWidth: 280 }}>
                      <Group justify="space-between" align="center">
                        <Text size="sm" fw={600}>Live KLV Telemetry</Text>
                        <Menu shadow="md" width={190} position="bottom-end" withArrow>
                          <Menu.Target>
                            <Tooltip label={klvExportAvailable ? "Export KLV data" : klvExportUnavailableMessage} withArrow><ActionIcon variant="light" size="sm" disabled={!klvExportAvailable || !!klvExportInFlight} loading={!!klvExportInFlight} aria-label="Export KLV data"><PlaybackControlIcon name="exportCsv" /></ActionIcon></Tooltip>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Label>Export KLV data</Menu.Label>
                            <Menu.Item onClick={() => downloadKlvExport('csv')} disabled={!klvExportAvailable || !!klvExportInFlight}>Export as CSV</Menu.Item>
                            <Menu.Item onClick={() => downloadKlvExport('kml')} disabled={!klvExportAvailable || !!klvExportInFlight}>Export as KML</Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
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
                          <Text size="xs" c="dimmed" mb="xs">Following the live WebSocket KLV feed. Click an empty map area to place a target mark; select an existing target pin to select it.</Text>
                          <KlvMap
                            telemetry={overlayData?.mode === 'live-ws' ? overlayData : null}
                            active={activeTab === 'live-webrtc' && liveTelemetryTab === 'map'}
                            platformHistory={Number.isFinite(livePlatformHistoryUntilMs) ? livePlatformHistory : null}
                            platformHistoryUntilMs={livePlatformHistoryUntilMs}
                            showPlatformHistory={livePlatformHistoryEnabled}
                            onPlatformHistoryToggle={setLivePlatformHistoryEnabled}
                            platformHistoryLoading={livePlatformHistoryLoading}
                            onPositionSelect={openNewTargetLogEntry}
                            onPointerCoordinate={updateLiveMapPointerPosition}
                            targetLogEntries={targetLogEntries}
                            selectedTargetLogId={selectedTargetLogId}
                            onTargetLogSelect={selectTargetLogEntryById}
                          />
                          <Group mt="xs" justify="space-between" gap="xs" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                              Mission timestamp: {overlayData?.mode === 'live-ws' && overlayData.timestampIso ? overlayData.timestampIso : 'n/a'}
                            </Text>
                            <Text size="xs" c="dimmed" style={{ textAlign: 'right' }}>
                              {formatMapPointerPosition(liveMapPointerPosition)}
                            </Text>
                          </Group>
                        </Tabs.Panel>
                      </Tabs>
                    </Paper>
                  </Group>
                </Tabs.Panel>
              </Tabs>
              <div className="target-log-panel">
                <Group justify="space-between" align="center" mt="md" mb="xs">
                  <div>
                    <Text size="sm" fw={700}>Mission Target Log</Text>
                    <Text size="xs" c="dimmed">
                      {currentSourceIsFile
                        ? 'Target marks for post-mission playback are pinned on the clip filmstrip.'
                        : `Shared across live and time-shifted playback for stream ${streamId}.`}
                    </Text>
                  </div>
                  <Group gap="xs">
                    {targetLogLoading ? <Loader size="xs" /> : <Badge variant="light">{targetLogEntries.length} mark{targetLogEntries.length === 1 ? '' : 's'}</Badge>}
                    <Button size="xs" variant="default" onClick={() => setTargetLogSchemaOpen(true)} disabled={!canManageTargetLogFields}>User-Defined Metadata</Button>
                    {showTargetMarkAction ? <Button size="xs" onClick={openNewTargetLogEntry} disabled={!canAddTargetMark}>Add Mark</Button> : null}
                  </Group>
                </Group>
                {targetLogEntries.length ? (
                  <div className="target-log-grid-scroll">
                    <table className="target-log-grid">
                      <thead>
                        <tr>
                          <th scope="col">Mission time (UTC)</th>
                          <th scope="col">Latitude</th>
                          <th scope="col">Longitude</th>
                          <th scope="col">Observation</th>
                          {targetLogActiveFields.map((field) => <th scope="col" key={field.id}>{field.label}</th>)}
                          <th scope="col" className="target-log-grid-actions">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targetLogEntries.map((entry) => (
                          <tr
                            key={entry.id}
                            className={`target-log-grid-row${entry.id === selectedTargetLogId ? ' is-selected' : ''}`}
                            onClick={() => seekTargetLogEntry(entry)}
                            onDoubleClick={() => openEditTargetLogEntry(entry)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                seekTargetLogEntry(entry);
                              }
                            }}
                            tabIndex={0}
                            aria-label={`Select target mark at ${formatMissionTime(entry.missionTimeMs)}`}
                          >
                            <td>{formatMissionTime(entry.missionTimeMs)}</td>
                            <td>{entry.position ? entry.position.lat.toFixed(6) : '—'}</td>
                            <td>{entry.position ? entry.position.lon.toFixed(6) : '—'}</td>
                            <td className={!entry.observation ? 'target-log-empty' : undefined}>{entry.observation || 'No observation'}</td>
                            {targetLogActiveFields.map((field) => (
                              <td key={field.id}>{entry.customFields?.[field.key] == null || entry.customFields?.[field.key] === '' ? '—' : String(entry.customFields[field.key])}</td>
                            ))}
                            <td className="target-log-grid-actions">
                              <Button size="compact-xs" variant="subtle" onClick={(event) => { event.stopPropagation(); openEditTargetLogEntry(entry); }} onKeyDown={(event) => event.stopPropagation()}>Edit</Button>
                              <Button size="compact-xs" color="red" variant="subtle" onClick={(event) => { event.stopPropagation(); deleteTargetLogEntry(entry); }} onKeyDown={(event) => event.stopPropagation()} disabled={targetLogInFlight}>Remove</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <Text size="sm" c="dimmed">No target marks for this stream yet. Add a mark from either playback mode.</Text>}
                {selectedTargetLogEntry ? <Text size="xs" c="dimmed" mt="xs">Selected mission time: {formatMissionTime(selectedTargetLogEntry.missionTimeMs)}</Text> : null}
              </div>
              </> : <Stack align="center" gap={4} py="xl">
                <Text fw={600}>No Active Stream Source</Text>
                <Text size="sm" c="dimmed">Start a stream or select a video file to begin playback.</Text>
              </Stack>}
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>System</Text>
              <Tabs defaultValue="utilization" mt="xs">
                <Tabs.List>
                  <Tabs.Tab value="status">Status</Tabs.Tab>
                  <Tabs.Tab value="utilization">Utilization</Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="status" pt="md">
                  <MediaToolsStatus mediaTools={mediaTools} />
                </Tabs.Panel>
                <Tabs.Panel value="utilization" pt="md">
                  <Group grow align="flex-start">
                    <Stack gap={2}>
                      <Text size="sm">CPU: {hostMetrics?.cpuPercent != null ? String(hostMetrics.cpuPercent) + '%' : 'Sampling...'}</Text>
                      <Text size="sm">RAM: {hostMetrics?.memory ? formatBytes(hostMetrics.memory.usedBytes) + ' / ' + formatBytes(hostMetrics.memory.totalBytes) + ' (' + hostMetrics.memory.usedPercent + '%)' : 'n/a'}</Text>
                    </Stack>
                    <Stack gap={2}>
                      <Text size="sm">Disk I/O: read {formatBytesPerSecond(hostMetrics?.disk?.readBytesPerSec)} · write {formatBytesPerSecond(hostMetrics?.disk?.writeBytesPerSec)}</Text>
                      <Text size="sm">Network: down {formatBytesPerSecond(hostMetrics?.network?.receiveBytesPerSec)} · up {formatBytesPerSecond(hostMetrics?.network?.transmitBytesPerSec)}</Text>
                    </Stack>
                    <Stack gap={2}>
                      {hostMetrics?.gpu?.available ? hostMetrics.gpu.gpus.map((gpu) => (
                        <Text key={gpu.name} size="sm">
                          GPU: {gpu.name} · {gpu.utilizationPercent ?? 'n/a'}% · {gpu.memoryUsedMiB ?? 'n/a'} / {gpu.memoryTotalMiB ?? 'n/a'} MiB{gpu.temperatureC != null ? ' · ' + gpu.temperatureC + '°C' : ''}
                        </Text>
                      )) : <Text size="sm" c="dimmed">GPU metrics unavailable</Text>}
                    </Stack>
                  </Group>
                  <Stack gap={2} mt="sm">
                    <Text size="sm" fw={500}>Process CPU</Text>
                    {processMetrics.length ? processMetrics.map((processInfo) => (
                      <Text key={`${processInfo.role}-${processInfo.streamId || ''}-${processInfo.pid}`} size="sm">
                        {processInfo.role}{processInfo.streamId ? ` (${processInfo.streamId})` : ''} · PID {processInfo.pid}: {processInfo.cpuPercent != null ? `${processInfo.cpuPercent}%` : 'n/a'}
                      </Text>
                    )) : <Text size="sm" c="dimmed">Process CPU metrics are unavailable.</Text>}
                  </Stack>
                </Tabs.Panel>
              </Tabs>
            </Paper>
          </Stack>
        </AppShell.Main>
        <Modal
          opened={!!targetLogEditor}
          onClose={() => !targetLogInFlight && setTargetLogEditor(null)}
          title={targetLogEditor?.mode === 'create' ? 'Add target mark' : 'Edit target mark'}
          centered
        >
          {targetLogEditor ? <Stack gap="sm">
            <Paper p="xs" withBorder>
              <DateTimePicker
                label="Mission date and time"
                description="Choose in your local time zone; it is converted to UTC below. Seconds are supported."
                value={missionTimePickerValue}
                onChange={(value) => setTargetLogEditor((current) => current ? {
                  ...current,
                  missionTimeText: value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : ''
                } : current)}
                valueFormat="YYYY-MM-DD HH:mm:ss"
                withSeconds
                clearable
              />
              <TextInput
                label="Mission time (UTC)"
                description="KLV mission time; editable. Must be a valid ISO 8601 date/time with UTC offset."
                placeholder="2026-07-29T16:51:25.000Z"
                value={targetLogEditor.missionTimeText || ''}
                onChange={(event) => setTargetLogEditor((current) => current ? { ...current, missionTimeText: event.currentTarget.value } : current)}
                error={missionTimeValidationError || undefined}
              />
              {targetLogEditor.missionId ? <Text size="xs" c="dimmed">Mission: {targetLogEditor.missionId}</Text> : null}
            </Paper>
            <Group grow>
              <TextInput
                label="Latitude"
                description="Decimal degrees (−90 to 90)"
                type="number"
                min={-90}
                max={90}
                step="any"
                inputMode="decimal"
                value={targetLogEditor.position?.lat == null ? '' : String(targetLogEditor.position.lat)}
                onChange={(event) => updateTargetLogPosition('lat', event.currentTarget.value)}
              />
              <TextInput
                label="Longitude"
                description="Decimal degrees (−180 to 180)"
                type="number"
                min={-180}
                max={180}
                step="any"
                inputMode="decimal"
                value={targetLogEditor.position?.lon == null ? '' : String(targetLogEditor.position.lon)}
                onChange={(event) => updateTargetLogPosition('lon', event.currentTarget.value)}
              />
            </Group>
            <Text size="xs" c="dimmed">Coordinates are editable and can be pasted in decimal degrees for Google Maps or Google Earth. Leave both fields blank to save a mark without a position.</Text>
            <Textarea
              label="Observation"
              autosize
              minRows={3}
              placeholder="Describe the target or observation"
              value={targetLogEditor.observation || ''}
              onChange={(event) => setTargetLogEditor((current) => current ? { ...current, observation: event.currentTarget.value } : current)}
            />
            {targetLogActiveFields.length ? targetLogActiveFields.map((field) => field.dataType === 'boolean' ? (
              <Select
                key={field.id}
                label={field.label}
                required={field.required}
                placeholder="Not set"
                clearable={!field.required}
                data={[{ value: 'true', label: 'True' }, { value: 'false', label: 'False' }]}
                value={targetLogEditor.customFields?.[field.key] === true ? 'true' : targetLogEditor.customFields?.[field.key] === false ? 'false' : null}
                onChange={(value) => updateTargetLogDraftField(field.key, value == null ? '' : value === 'true')}
              />
            ) : (
              <TextInput
                key={field.id}
                label={field.label}
                required={field.required}
                type={field.dataType === 'number' ? 'number' : 'text'}
                value={targetLogEditor.customFields?.[field.key] == null ? '' : String(targetLogEditor.customFields[field.key])}
                onChange={(event) => updateTargetLogDraftField(field.key, event.currentTarget.value)}
              />
            )) : <Text size="xs" c="dimmed">No user-defined metadata. Select User-Defined Metadata to add optional fields.</Text>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setTargetLogEditor(null)} disabled={targetLogInFlight}>Cancel</Button>
              <Button onClick={saveTargetLogEditor} loading={targetLogInFlight}>{targetLogEditor.mode === 'create' ? 'Add Mark' : 'Save changes'}</Button>
            </Group>
          </Stack> : null}
        </Modal>
        <Modal
          opened={targetLogSchemaOpen}
          onClose={() => !targetLogInFlight && setTargetLogSchemaOpen(false)}
          title="User-Defined Metadata"
          centered
        >
          <Stack gap="sm">
            <Text size="sm" c="dimmed">Define additional metadata for target marks on stream {streamId}. Deactivating a field keeps existing values but removes it from future entries.</Text>
            {targetLogFields.length ? <Stack gap={4}>
              {targetLogFields.map((field) => (
                <Paper key={field.id} p="xs" withBorder>
                  <Group justify="space-between" wrap="nowrap">
                    <div>
                      <Text size="sm" fw={600}>{field.label} {!field.active ? <Badge size="xs" color="gray">Inactive</Badge> : null}</Text>
                      <Text size="xs" c="dimmed">{field.key} · {field.dataType}{field.required ? ' · required' : ''}</Text>
                    </div>
                    {field.active ? <Button size="compact-xs" color="red" variant="subtle" onClick={() => deactivateTargetLogField(field)} disabled={targetLogInFlight}>Deactivate</Button> : null}
                  </Group>
                </Paper>
              ))}
            </Stack> : <Text size="sm" c="dimmed">No user-defined metadata has been defined for this stream.</Text>}
            <Paper p="sm" withBorder>
              <Text size="sm" fw={600} mb="xs">Add metadata field</Text>
              <Stack gap="xs">
                <Group grow align="end">
                  <TextInput label="Field key" description="Used internally; use lowercase letters, numbers, _ or -." placeholder="priority" value={targetLogFieldDraft.key} onChange={(event) => setTargetLogFieldDraft((draft) => ({ ...draft, key: event.currentTarget.value }))} />
                  <TextInput label="Display label" description="Shown to users on target marks." placeholder="Priority" value={targetLogFieldDraft.label} onChange={(event) => setTargetLogFieldDraft((draft) => ({ ...draft, label: event.currentTarget.value }))} />
                </Group>
                <Group justify="space-between" align="end">
                  <Select
                    w={170}
                    label="Value type"
                    data={[{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Boolean' }]}
                    value={targetLogFieldDraft.dataType}
                    onChange={(value) => setTargetLogFieldDraft((draft) => ({ ...draft, dataType: value || 'text' }))}
                    allowDeselect={false}
                  />
                  <Checkbox label="Required for new marks" checked={targetLogFieldDraft.required} onChange={(event) => setTargetLogFieldDraft((draft) => ({ ...draft, required: event.currentTarget.checked }))} />
                  <Button onClick={createTargetLogField} loading={targetLogInFlight}>Add metadata field</Button>
                </Group>
              </Stack>
            </Paper>
          </Stack>
        </Modal>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
