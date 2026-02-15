import '@mantine/core/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AppShell, Text, Tabs, TextInput, NumberInput, Button, Group, Stack, Paper, JsonInput, Badge, Switch } from '@mantine/core';
import { Device } from 'mediasoup-client';

const theme = createTheme({
  /** Put your mantine theme override here */
});

function App() {
  const [streamId, setStreamId] = useState('stream1');
  const [inputUrl, setInputUrl] = useState('udp://239.1.2.3:5000');
  const [mode, setMode] = useState('xcode-any');
  const [dvrSeconds, setDvrSeconds] = useState(600);
  const [hlsSegmentSeconds, setHlsSegmentSeconds] = useState(1);
  const [maxCuesPerSecond, setMaxCuesPerSecond] = useState(10);
  const [minCueDurSec, setMinCueDurSec] = useState(0.10);
  const [maxCueDurSec, setMaxCueDurSec] = useState(0.50);
  const [purgeBeforeStart, setPurgeBeforeStart] = useState(true);
  const [status, setStatus] = useState('Ready. Start Source, then choose Live or DVR. DVR overlay is from segmented WebVTT.');
  const [overlay, setOverlay] = useState('');
  const [activeTab, setActiveTab] = useState('dvr');
  const [autoAttachOnDvr, setAutoAttachOnDvr] = useState(false);
  const [liveStatus, setLiveStatus] = useState('Idle');
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

  const refreshStreamState = async (targetStreamId = streamId) => {
    if (!targetStreamId) return;
    const result = await api(`/sources/${encodeURIComponent(targetStreamId)}/state`);
    if (result?.streamId) {
      setStreamRuntime(result);
      if (result.running) setAutoAttachOnDvr(true);
      if (!result.running) setAutoAttachOnDvr(false);
    }
  };

  const clearHlsRetryLoop = () => {
    if (hlsRetryTimerRef.current) {
      clearTimeout(hlsRetryTimerRef.current);
      hlsRetryTimerRef.current = null;
    }
  };

  const probeHlsMaster = async (targetStreamId) => {
    const url = `/hls/${encodeURIComponent(targetStreamId)}/master.m3u8?_=${Date.now()}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok;
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
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
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
      if (state === 'connected') setLiveStatus('Playing');
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

    const stream = new MediaStream([consumer.track]);
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = stream;
      await liveVideoRef.current.play().catch(() => {});
    }
    setLiveStatus('Playing');
  };

  const startSource = async () => {
    setStreamRuntime({ streamId, state: 'starting', running: false, lastError: null });
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
  };

  const stopSource = async () => {
    const result = await api(`/sources/${encodeURIComponent(streamId)}`, { method: "DELETE" });
    setStatus(JSON.stringify(result, null, 2));
    setAutoAttachOnDvr(false);
    clearHlsRetryLoop();
    clearWebRtcRetryLoop();
    if (window.player) {
      window.player.dispose();
      window.player = null;
    }
    cleanupWebRtcPlayback();
    setLiveStatus('Stopped');
    await refreshStreamState(streamId);
    await refreshSources({ silent: true });
  };

  const refreshSources = async ({ silent = false } = {}) => {
    const result = await api("/sources");
    if (Array.isArray(result)) setSourcesList(result);
    if (!silent) setStatus(JSON.stringify(result, null, 2));
  };

  const showOverlay = (obj) => {
    setOverlay(JSON.stringify(obj, null, 2));
  };

  const connectWs = () => {
    if (wsRef.current && (wsRef.current.readyState === 0 || wsRef.current.readyState === 1)) return;
    wsRef.current = new WebSocket(`ws://${location.hostname}:8081`);
    wsRef.current.onopen = () => subscribeWs();
    wsRef.current.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "st0601") showOverlay({ mode: "live-ws", ...msg });
    };
  };

  const subscribeWs = () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type: "subscribe", streamId, mode: "live" }));
  };

  const attachHlsDvr = (streamId, retryCount = 0) => {
    const maxRetries = 50; // Stop after 50 retries (~5 seconds)

    const url = `/hls/${encodeURIComponent(streamId)}/master.m3u8`;

    vttHookedRef.current = false;

    // Dispose existing player
    if (window.player) {
      window.player.dispose();
      window.player = null;
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

      window.player.on('error', () => {
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
        showOverlay({ mode: "dvr-vtt", ...obj });
      } catch {
        showOverlay({ mode: "dvr-vtt", raw: cue.text });
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

      const available = await probeHlsMaster(targetStreamId);
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
        setTimeout(() => startHlsAutoAttach(streamId), 0);
      }
      clearWebRtcRetryLoop();
      cleanupWebRtcPlayback();
    } else if (activeTab === 'live-klv') {
      clearHlsRetryLoop();
      clearWebRtcRetryLoop();
      cleanupWebRtcPlayback();
      connectWs();
      subscribeWs();
    } else if (activeTab === 'live-webrtc') {
      clearHlsRetryLoop();
      startWebRtcAutoAttach(streamId);
    }
  }, [activeTab, streamId, autoAttachOnDvr]);

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
    return () => {
      clearHlsRetryLoop();
      clearWebRtcRetryLoop();
      cleanupWebRtcPlayback();
      if (window.player) {
        window.player.dispose();
        window.player = null;
      }
    };
  }, []);

  return (
    <MantineProvider theme={theme}>
      <AppShell
        header={{ height: 60 }}
        navbar={{ width: 300, breakpoint: 'sm' }}
        padding="md"
      >
        <AppShell.Header>
          <Text size="lg" fw={700} p="md">DVR + WebRTC + KLV Demo</Text>
        </AppShell.Header>

        <AppShell.Navbar p="md">
          <Text>Navigation</Text>
        </AppShell.Navbar>

        <AppShell.Main>
          <Stack spacing="md">
            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Start Source</Text>
              <Group grow>
                <TextInput label="Stream ID" value={streamId} onChange={(e) => setStreamId(e.target.value)} />
                <TextInput label="Input URL" value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} />
              </Group>
              <Group grow>
                <TextInput label="Mode" value={mode} onChange={(e) => setMode(e.target.value)} />
                <NumberInput label="DVR Seconds" value={dvrSeconds} onChange={setDvrSeconds} />
                <NumberInput label="HLS/VTT Segment Seconds" value={hlsSegmentSeconds} onChange={setHlsSegmentSeconds} min={0.25} step={0.25} />
              </Group>
              <Group grow>
                <NumberInput label="Max Cues/Sec" value={maxCuesPerSecond} onChange={setMaxCuesPerSecond} />
                <NumberInput label="Min Cue Dur Sec" value={minCueDurSec} onChange={setMinCueDurSec} step={0.01} precision={2} />
                <NumberInput label="Max Cue Dur Sec" value={maxCueDurSec} onChange={setMaxCueDurSec} step={0.01} precision={2} />
              </Group>
              <Switch
                mt="sm"
                label="Purge existing recordings and KLV data before start"
                checked={purgeBeforeStart}
                onChange={(event) => setPurgeBeforeStart(event.currentTarget.checked)}
              />
              <Group mt="md">
                <Button onClick={startSource}>Start Source</Button>
                <Button onClick={stopSource} color="red">Stop Source</Button>
                <Button onClick={refreshSources} variant="outline">Refresh</Button>
                <Button variant="light" onClick={() => startHlsAutoAttach(streamId)}>Reconnect HLS</Button>
                <Button variant="light" onClick={() => startWebRtcAutoAttach(streamId)}>Reconnect WebRTC</Button>
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
                </Tabs.Panel>

                <Tabs.Panel value="live-webrtc" pt="xs">
                  <Text>Live video via WebRTC</Text>
                  <Text size="sm" c="dimmed">Status: {liveStatus}</Text>
                  <video ref={liveVideoRef} controls muted playsInline style={{ width: '100%', maxHeight: '400px' }}></video>
                </Tabs.Panel>

                <Tabs.Panel value="live-klv" pt="xs">
                  <Text>Live KLV via WebSocket</Text>
                </Tabs.Panel>
              </Tabs>
            </Paper>

            <Group grow>
              <Paper shadow="xs" p="md">
                <Text size="lg" fw={500}>Status</Text>
                <JsonInput value={status} readOnly />
              </Paper>
              <Paper shadow="xs" p="md">
                <Text size="lg" fw={500}>Overlay</Text>
                <JsonInput value={overlay} readOnly />
              </Paper>
            </Group>
          </Stack>
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
