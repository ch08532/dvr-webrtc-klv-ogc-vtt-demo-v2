import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Accordion, ActionIcon, Badge, Button, Group, NumberInput, Paper, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import MultiKlvMap from './MultiKlvMap.jsx';

const request = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status})`);
  return data;
};

const missionTime = (telemetry) => {
  const micros = telemetry?.timestampUnixMicros;
  if (micros != null) {
    try { return Number(BigInt(micros) / 1000n); } catch {}
  }
  const parsed = Date.parse(telemetry?.timestampIso || '');
  return Number.isFinite(parsed) ? parsed : null;
};

const clipTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - (minutes * 60);
  return `${minutes}:${remainder.toFixed(2).padStart(5, '0')}`;
};

const bounded = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function FmvTile({ item, focused, mapPosition, onFocus, onRemove, onTelemetry, onStatus }) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const thumbnailRequestedForRef = useRef(null);
  const [telemetry, setTelemetry] = useState(null);
  const [duration, setDuration] = useState(0);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(10);
  const [observation, setObservation] = useState('');
  const [busy, setBusy] = useState(false);
  const [playbackRate, setPlaybackRate] = useState('1');
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [quality, setQuality] = useState('auto');
  const [qualityOptions, setQualityOptions] = useState([{ value: 'auto', label: 'Auto quality' }]);
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [diagnostics, setDiagnostics] = useState({ source: '', playlist: '', rendition: 'n/a', coded: 'n/a', display: 'n/a', segment: 'n/a', subtitle: 'n/a' });
  const [zoom, setZoom] = useState(1);
  const [thumbnails, setThumbnails] = useState([]);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [targetEntries, setTargetEntries] = useState([]);

  const hlsUrl = item.hlsUrl || `/hls/${encodeURIComponent(item.sourceStreamId)}/master.m3u8`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window.videojs !== 'function') return undefined;
    const video = document.createElement('video');
    video.className = 'video-js vjs-default-skin vjs-fluid';
    video.setAttribute('playsinline', '');
    host.appendChild(video);
    const player = window.videojs(video, { controls: true, fluid: true, aspectRatio: '16:9', liveui: true, html5: { hls: { overrideNative: !window.videojs.browser?.IS_SAFARI } } });
    playerRef.current = player;
    player.src({ src: hlsUrl, type: 'application/x-mpegURL' });
    const updateDuration = () => {
      const value = Number(player.duration?.());
      if (Number.isFinite(value) && value > 0) { setDuration(value); setClipEnd((current) => current > 0 && current <= value ? current : Math.min(value, 10)); }
    };
    const updatePlaybackDiagnostics = () => {
      const nativeVideo = host.querySelector('video');
      const tech = player.tech?.({ IWillNotUseThisInPlugins: true });
      const media = tech?.vhs?.playlists?.media?.();
      const segmentIndex = Math.floor(Number(player.currentTime?.()) / 5);
      setCurrentTime(Number(player.currentTime?.()) || 0);
      setPaused(Boolean(player.paused?.()));
      setDiagnostics({
        source: player.currentSrc?.() || hlsUrl,
        playlist: media?.uri || media?.resolvedUri || 'n/a',
        rendition: media?.attributes?.RESOLUTION ? `${media.attributes.RESOLUTION.width || '?'} × ${media.attributes.RESOLUTION.height || '?'}` : 'auto/source',
        coded: nativeVideo?.videoWidth && nativeVideo?.videoHeight ? `${nativeVideo.videoWidth}×${nativeVideo.videoHeight}` : 'n/a',
        display: nativeVideo?.clientWidth && nativeVideo?.clientHeight ? `${nativeVideo.clientWidth}×${nativeVideo.clientHeight}` : 'n/a',
        segment: Number.isFinite(segmentIndex) ? String(segmentIndex) : 'n/a',
        subtitle: 'WebVTT metadata track'
      });
    };
    const bindCue = () => {
      const lists = [video.textTracks, player.textTracks?.(), player.remoteTextTracks?.()].filter(Boolean);
      for (const list of lists) for (let index = 0; index < Number(list.length || 0); index += 1) {
        const track = list[index];
        if (!track || !['subtitles', 'captions'].includes(String(track.kind || '').toLowerCase())) continue;
        try { track.mode = 'hidden'; } catch {}
        const update = () => {
          const cue = track.activeCues?.[track.activeCues.length - 1];
          if (!cue) return;
          let next;
          try { next = JSON.parse(cue.text); } catch { next = { raw: cue.text }; }
          setTelemetry(next);
        };
        track.addEventListener?.('cuechange', update);
        update();
        return () => track.removeEventListener?.('cuechange', update);
      }
      return undefined;
    };
    let unbind = null;
    const bind = () => { unbind?.(); unbind = bindCue(); };
    player.on('loadedmetadata', () => { updateDuration(); bind(); updatePlaybackDiagnostics(); });
    player.on('loadedmetadata', () => {
      try {
        const tech = player.tech?.({ IWillNotUseThisInPlugins: true });
        const representations = tech?.vhs?.representations?.() || [];
        const options = representations.map((representation) => ({ value: `${representation.width}x${representation.height}`, label: `${representation.width} × ${representation.height}` }));
        if (options.length) setQualityOptions([{ value: 'auto', label: 'Auto quality' }, ...options]);
      } catch {}
    });
    player.on('loadeddata', bind);
    player.on('loadeddata', updatePlaybackDiagnostics);
    player.on('timeupdate', updatePlaybackDiagnostics);
    player.on('play', updatePlaybackDiagnostics);
    player.on('pause', updatePlaybackDiagnostics);
    return () => {
      unbind?.();
      player.off?.('loadeddata', updatePlaybackDiagnostics);
      player.off?.('timeupdate', updatePlaybackDiagnostics);
      player.off?.('play', updatePlaybackDiagnostics);
      player.off?.('pause', updatePlaybackDiagnostics);
      try { player.dispose(); } catch {}
      playerRef.current = null;
    };
  }, [hlsUrl]);

  useEffect(() => {
    const video = hostRef.current?.querySelector('video');
    if (video) {
      video.style.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
      video.style.transform = `scale(${zoom})`;
      video.style.transformOrigin = 'center center';
    }
  }, [brightness, contrast, saturation, zoom]);

  const setTilePlaybackRate = (value) => {
    const rate = Number(value) || 1;
    setPlaybackRate(String(rate));
    try { playerRef.current?.playbackRate?.(rate); } catch {}
  };

  const setTileQuality = (value) => {
    const next = value || 'auto';
    setQuality(next);
    try {
      const tech = playerRef.current?.tech?.({ IWillNotUseThisInPlugins: true });
      for (const representation of tech?.vhs?.representations?.() || []) {
        representation.enabled(next === 'auto' || `${representation.width}x${representation.height}` === next);
      }
    } catch {}
  };

  useEffect(() => {
    const streamId = item.sourceStreamId;
    if (!streamId) return;
    let cancelled = false;
    Promise.all([
      request(`/streams/${encodeURIComponent(streamId)}/klv/platform-history.geojson?maxPoints=5000`),
      request(`/streams/${encodeURIComponent(streamId)}/klv/frame-center-history.geojson?maxPoints=5000`),
      request(`/streams/${encodeURIComponent(streamId)}/target-log`)
    ]).then(([platformHistory, frameCenterHistory, targetLog]) => {
      if (!cancelled) {
        const entries = targetLog.entries || [];
        setTargetEntries(entries);
        onTelemetry(item.productId, { platformHistory, frameCenterHistory, targetLogEntries: entries });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [item.productId, item.sourceStreamId, onTelemetry]);

  useEffect(() => { onTelemetry(item.productId, { telemetry, missionTimeMs: missionTime(telemetry) }); }, [item.productId, telemetry, onTelemetry]);

  useEffect(() => {
    if (!duration || thumbnails.length || thumbnailLoading || thumbnailRequestedForRef.current === item.sourceStreamId) return;
    let cancelled = false;
    thumbnailRequestedForRef.current = item.sourceStreamId;
    setThumbnailLoading(true);
    request(`/sources/${encodeURIComponent(item.sourceStreamId)}/clip-thumbnails`)
      .then((result) => { if (!cancelled) setThumbnails(Array.isArray(result.thumbnails) ? result.thumbnails : []); })
      .catch(() => { if (!cancelled) setThumbnails([]); })
      .finally(() => { if (!cancelled) setThumbnailLoading(false); });
    return () => { cancelled = true; };
  }, [duration, item.sourceStreamId, thumbnailLoading, thumbnails.length]);

  const createClip = async (createProduct) => {
    setBusy(true);
    try {
      const clip = await request(`/sources/${encodeURIComponent(item.sourceStreamId)}/clips`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startSeconds: clipStart, endSeconds: clipEnd, createProduct }) });
      const downloadUrl = clip?.clip?.downloadUrl;
      if (downloadUrl) window.open(downloadUrl, '_blank', 'noopener');
      onStatus(createProduct ? `Clip product created for ${item.title}.` : `Clip download created for ${item.title}.`);
    } catch (error) { onStatus(`Clip export failed: ${error.message}`); } finally { setBusy(false); }
  };

  const snapshot = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/sources/${encodeURIComponent(item.sourceStreamId)}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeSeconds: Number(playerRef.current?.currentTime?.() || 0) }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Snapshot failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onStatus(`Snapshot created for ${item.title}.`);
    } catch (error) { onStatus(`Snapshot failed: ${error.message}`); } finally { setBusy(false); }
  };

  const addTarget = async () => {
    const missionTimeMs = missionTime(telemetry);
    if (!Number.isFinite(missionTimeMs)) return onStatus(`No KLV mission time is available for ${item.title}.`);
    setBusy(true);
    try {
      const clickedPosition = Number.isFinite(Number(mapPosition?.lat)) && Number.isFinite(Number(mapPosition?.lon)) ? { lat: Number(mapPosition.lat), lon: Number(mapPosition.lon) } : null;
      const frameCenter = Number.isFinite(Number(telemetry?.frameCenterLat)) && Number.isFinite(Number(telemetry?.frameCenterLon)) ? { lat: Number(telemetry.frameCenterLat), lon: Number(telemetry.frameCenterLon) } : null;
      await request(`/streams/${encodeURIComponent(item.sourceStreamId)}/target-log/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ missionTimeMs, videoProductId: item.productId, observation, position: clickedPosition || frameCenter, positionSource: clickedPosition ? 'MAP_CLICK' : 'FRAME_CENTER' }) });
      const targetLog = await request(`/streams/${encodeURIComponent(item.sourceStreamId)}/target-log`);
      const entries = targetLog.entries || [];
      setTargetEntries(entries);
      onTelemetry(item.productId, { targetLogEntries: entries });
      setObservation(''); onStatus(`Target mark added to ${item.title}.`);
    } catch (error) { onStatus(`Target mark failed: ${error.message}`); } finally { setBusy(false); }
  };

  const seek = (time) => {
    const player = playerRef.current;
    if (!player) return;
    player.currentTime(bounded(time, 0, duration || Math.max(0, time)));
  };

  const togglePlayback = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused?.()) player.play?.().catch(() => {}); else player.pause?.();
  };

  const setClipBoundaryAtPlayhead = (boundary) => {
    const time = bounded(Number(playerRef.current?.currentTime?.()) || 0, 0, duration || 0);
    if (boundary === 'start') setClipStart(Math.min(time, Math.max(0, clipEnd - 0.25)));
    else setClipEnd(Math.max(time, clipStart + 0.25));
  };

  const setTrimFromPointer = (event, boundary) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!duration || rect.width <= 0) return;
    const time = bounded(((event.clientX - rect.left) / rect.width) * duration, 0, duration);
    const nextBoundary = boundary || (Math.abs(time - clipStart) <= Math.abs(time - clipEnd) ? 'start' : 'end');
    if (nextBoundary === 'start') setClipStart(Math.min(time, clipEnd - 0.25));
    else setClipEnd(Math.max(time, clipStart + 0.25));
  };

  const clipLength = Math.max(0, clipEnd - clipStart);
  const playheadPercent = duration > 0 ? bounded((currentTime / duration) * 100, 0, 100) : 0;

  return <Paper className={`multi-fmv-tile${focused ? ' is-focused' : ''}`} withBorder p="sm" onPointerDown={onFocus}>
    <Group justify="space-between" wrap="nowrap" mb="xs"><div><Text fw={600} lineClamp={1}>{item.title}</Text><Text size="xs" c="dimmed">{item.missionTitle || 'Mission'} · {item.sourceStreamId}</Text></div><Tooltip label="Remove from Playback" withArrow><ActionIcon color="red" variant="light" onClick={onRemove} aria-label={`Remove ${item.title} from Playback`}>×</ActionIcon></Tooltip></Group>
    <Group gap="xs" mb="xs"><Text size="sm" c="dimmed">Status: {paused ? 'Paused' : 'Playing'}</Text><Badge color={paused ? 'gray' : 'teal'} variant="light">{paused ? 'PAUSED' : 'PLAYING'}</Badge></Group>
    <Accordion defaultValue="details" variant="contained" className="multi-fmv-details" mb="xs"><Accordion.Item value="details"><Accordion.Control>Video Quality &amp; Stream Details</Accordion.Control><Accordion.Panel><Group gap="xs" align="end" wrap="wrap"><Select size="xs" label="Video quality" value={quality} onChange={setTileQuality} data={qualityOptions} w={160} /><Text size="xs" c="dimmed" pb={5}>{qualityOptions.length > 1 ? 'Select a rendition or let HLS adapt.' : 'A single browser-compatible rendition is available.'}</Text></Group><Text className="multi-fmv-diagnostic" mt="xs">source: {diagnostics.source} | playlist: {diagnostics.playlist}</Text><Text className="multi-fmv-diagnostic">active rendition: {diagnostics.rendition} | coded: {diagnostics.coded} | display: {diagnostics.display}</Text><Text className="multi-fmv-diagnostic">segment: {diagnostics.segment} | subtitle: {diagnostics.subtitle}</Text></Accordion.Panel></Accordion.Item></Accordion>
    <div ref={hostRef} className="multi-fmv-video" />
    <Text size="xs" c="dimmed" mt="xs">player time: {clipTime(currentTime)} / {duration ? clipTime(duration) : '—'}</Text>
    <Group gap="xs" mt="xs" justify="center" className="multi-fmv-transport"><Tooltip label="Play from start" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(0)} aria-label="Play from start">|▶</ActionIcon></Tooltip><Tooltip label="Rewind 15 seconds" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(currentTime - 15)} aria-label="Rewind 15 seconds">◀◀</ActionIcon></Tooltip><Tooltip label="Seek to clip start" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(clipStart)} aria-label="Seek to clip start">|◀</ActionIcon></Tooltip><Tooltip label={paused ? 'Play' : 'Pause'} withArrow><ActionIcon variant="light" size="lg" onClick={togglePlayback} aria-label={paused ? 'Play' : 'Pause'}>{paused ? '▶' : 'Ⅱ'}</ActionIcon></Tooltip><Tooltip label="Seek to clip end" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(clipEnd)} aria-label="Seek to clip end">▶|</ActionIcon></Tooltip><Tooltip label="Fast-forward 15 seconds" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(currentTime + 15)} aria-label="Fast-forward 15 seconds">▶▶</ActionIcon></Tooltip><Tooltip label="Go to end" withArrow><ActionIcon variant="light" size="lg" onClick={() => seek(duration)} aria-label="Go to end">▶|</ActionIcon></Tooltip><ActionIcon variant="light" size="lg" onClick={() => setZoom((value) => Math.max(1, value - 0.25))} aria-label="Zoom out">−</ActionIcon><Select size="xs" aria-label="Playback speed" value={playbackRate} onChange={setTilePlaybackRate} data={[{ value: '0.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }]} w={76} /><ActionIcon variant="light" size="lg" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} aria-label="Zoom in">+</ActionIcon><NumberInput size="xs" aria-label="Brightness" value={brightness} min={50} max={200} suffix="%" onChange={(value) => setBrightness(Number(value) || 100)} w={75} /><NumberInput size="xs" aria-label="Contrast" value={contrast} min={50} max={200} suffix="%" onChange={(value) => setContrast(Number(value) || 100)} w={75} /><NumberInput size="xs" aria-label="Saturation" value={saturation} min={0} max={200} suffix="%" onChange={(value) => setSaturation(Number(value) || 100)} w={82} /><Button size="xs" variant="light" onClick={snapshot} loading={busy}>Snapshot</Button><Button size="xs" variant="light" onClick={() => window.open(`/streams/${encodeURIComponent(item.sourceStreamId)}/klv/export.csv`, '_blank', 'noopener')}>KLV CSV</Button><Button size="xs" variant="light" onClick={() => window.open(`/streams/${encodeURIComponent(item.sourceStreamId)}/klv/export.kml`, '_blank', 'noopener')}>KLV KML</Button></Group>
    <div className="clip-widget" aria-label="Video clip selection"><Group justify="space-between" align="center" mb={4}><div><Text size="sm" fw={700}>Create video clip</Text><Text size="xs" c="dimmed">Drag either edge to preview a playable point. Exports stream-copy the uploaded source and may begin at a preceding keyframe.</Text></div><Group gap="xs">{thumbnailLoading ? <Badge color="blue" variant="light">Building thumbnails…</Badge> : null}<Badge color={telemetry ? 'teal' : 'gray'} variant="light">{telemetry ? 'KLV preserved' : 'No KLV detected'}</Badge></Group></Group><div className="clip-trim-shell" onPointerDown={(event) => setTrimFromPointer(event)} onPointerMove={(event) => { if (event.buttons === 1) setTrimFromPointer(event); }}><div className={`clip-filmstrip${thumbnails.length ? ' has-thumbnails' : ''}`} aria-hidden="true">{thumbnails.length ? thumbnails.map((thumbnail, index) => <img key={thumbnail.url || index} src={thumbnail.url} alt="" />) : Array.from({ length: 12 }, (_, index) => <span key={index} />)}</div>{duration ? <><div className="clip-selection" style={{ left: `${(clipStart / duration) * 100}%`, width: `${(clipLength / duration) * 100}%` }} /><div className="clip-playback-marker" style={{ left: `${playheadPercent}%` }} /><button type="button" className="clip-drag-handle clip-drag-handle-start" style={{ left: `calc(${(clipStart / duration) * 100}% - 9px)` }} onPointerDown={(event) => { event.stopPropagation(); setTrimFromPointer(event, 'start'); }} aria-label="Clip start time" /><button type="button" className="clip-drag-handle clip-drag-handle-end" style={{ left: `calc(${(clipEnd / duration) * 100}% - 9px)` }} onPointerDown={(event) => { event.stopPropagation(); setTrimFromPointer(event, 'end'); }} aria-label="Clip end time" />{targetEntries.filter((entry) => Number.isFinite(Number(entry.videoTimeMs))).map((entry) => <button key={entry.id} type="button" className="clip-target-log-marker" style={{ left: `calc(${bounded((Number(entry.videoTimeMs) / 1000 / duration) * 100, 0, 100)}% - 6px)` }} onPointerDown={(event) => event.stopPropagation()} onClick={() => seek(Number(entry.videoTimeMs) / 1000)} aria-label="Seek to target mark" />)}</> : null}</div><Group justify="space-between" className="clip-time-readout"><span><b>Start</b> {clipTime(clipStart)}</span><span><b>Length</b> {clipTime(clipLength)}</span><span><b>End</b> {clipTime(clipEnd)}</span></Group><Group mt="xs" gap="xs" wrap="wrap"><Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('start')} disabled={!duration || busy}>Set start at playhead</Button><Button size="xs" variant="default" onClick={() => setClipBoundaryAtPlayhead('end')} disabled={!duration || busy}>Set end at playhead</Button><Button size="xs" color="dark" loading={busy} onClick={() => createClip(false)} disabled={clipLength < 0.25}>Download clip</Button><Button size="xs" color="blue" loading={busy} onClick={() => createClip(true)} disabled={clipLength < 0.25}>Download &amp; create product</Button></Group><Text size="xs" c="dimmed" mt="xs">Downloads copy the uploaded source as MPEG-TS with video, audio, and KLV. Creating a product also stores a cataloged copy; its KLV coverage is used when available, otherwise the mission bbox is inherited.</Text></div>
    <Group gap="xs" mt="xs" align="end" wrap="wrap"><TextInput size="xs" label="Target observation" value={observation} onChange={(event) => setObservation(event.currentTarget.value)} /><Button size="xs" variant="light" loading={busy} onClick={addTarget}>{mapPosition ? 'Add target at map click' : 'Add target at playhead'}</Button></Group>
  </Paper>;
}

export default function MultiFmvPlayback({ products = [], onRemove, baseMap, onBaseMapChange, onStatus = () => {} }) {
  const [focusedProductId, setFocusedProductId] = useState(products[0]?.productId || null);
  const [mapState, setMapState] = useState({});
  const [mapPosition, setMapPosition] = useState(null);
  useEffect(() => { if (!products.some((product) => product.productId === focusedProductId)) setFocusedProductId(products[0]?.productId || null); }, [products, focusedProductId]);
  const updateMapState = useCallback((productId, patch) => setMapState((current) => ({ ...current, [productId]: { ...(current[productId] || {}), ...patch } })), []);
  const mapItems = useMemo(() => products.map((product) => ({ ...product, ...(mapState[product.productId] || {}) })), [products, mapState]);
  if (!products.length) return <Paper id="playback" p="xl" withBorder><Text size="xl" fw={600}>Playback</Text><Text c="dimmed" mt="xs">Select an FMV from Mission Products and choose “Add to Playback.” Selected products remain here until you remove them; nothing is deleted.</Text></Paper>;
  return <Stack id="playback" gap="md"><Group justify="space-between"><div><Text size="xl" fw={600}>Multi-FMV Playback</Text><Text size="sm" c="dimmed">Independent video playheads · shared KLV map · focused tile receives map authoring actions.</Text></div><Text size="sm" c="dimmed">{products.length} FMV{products.length === 1 ? '' : 's'} selected</Text></Group><div className="multi-fmv-workspace"><div className="multi-fmv-grid">{products.map((product) => <FmvTile key={product.productId} item={product} focused={product.productId === focusedProductId} mapPosition={product.productId === focusedProductId ? mapPosition : null} onFocus={() => setFocusedProductId(product.productId)} onRemove={() => onRemove(product.productId)} onTelemetry={updateMapState} onStatus={onStatus} />)}</div><Paper className="multi-fmv-map-panel" withBorder p="sm"><MultiKlvMap items={mapItems} focusedProductId={focusedProductId} baseMap={baseMap} onBaseMapChange={onBaseMapChange} onPositionSelect={setMapPosition} /></Paper></div></Stack>;
}
