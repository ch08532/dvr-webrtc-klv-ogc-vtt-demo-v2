import '@mantine/core/styles.css';

import { createTheme, MantineProvider } from '@mantine/core';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { AppShell, Text, Tabs, TextInput, NumberInput, Button, Group, Stack, Paper, JsonInput } from '@mantine/core';

const theme = createTheme({
  /** Put your mantine theme override here */
});

function App() {
  const [streamId, setStreamId] = useState('stream1');
  const [inputUrl, setInputUrl] = useState('udp://239.1.2.3:5000');
  const [mode, setMode] = useState('xcode-any');
  const [dvrSeconds, setDvrSeconds] = useState(600);
  const [vttSegmentSeconds, setVttSegmentSeconds] = useState(5);
  const [maxCuesPerSecond, setMaxCuesPerSecond] = useState(10);
  const [minCueDurSec, setMinCueDurSec] = useState(0.10);
  const [maxCueDurSec, setMaxCueDurSec] = useState(0.50);
  const [status, setStatus] = useState('Ready. Start Source, then choose Live or DVR. DVR overlay is from segmented WebVTT.');
  const [overlay, setOverlay] = useState('');
  const [activeTab, setActiveTab] = useState('dvr');

  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const vttHookedRef = useRef(false);

  const api = async (url, opts) => {
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
  };

  const startSource = async () => {
    const result = await api("/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId, inputUrl, mode, dvrSeconds, vttSegmentSeconds, maxCuesPerSecond, minCueDurSec, maxCueDurSec })
    });
    setStatus(JSON.stringify(result, null, 2));
  };

  const stopSource = async () => {
    const result = await api(`/sources/${encodeURIComponent(streamId)}`, { method: "DELETE" });
    setStatus(JSON.stringify(result, null, 2));
  };

  const refreshSources = async () => {
    const result = await api("/sources");
    setStatus(JSON.stringify(result, null, 2));
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
      window.player = videojs(videoRef.current, {
        html5: {
          hls: {
            overrideNative: !videojs.browser.IS_SAFARI
          }
        }
      });

      window.player.src({
        src: url,
        type: 'application/x-mpegURL'
      });

      window.player.ready(() => {
        // Don't auto-play to avoid browser restrictions
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

  useLayoutEffect(() => {
    if (activeTab === 'dvr') {
      // Defer to next tick to ensure DOM is fully updated
      setTimeout(() => attachHlsDvr(streamId), 0);
    } else if (activeTab === 'live-klv') {
      connectWs();
      subscribeWs();
    }
  }, [activeTab, streamId]);

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
                <NumberInput label="VTT Segment Seconds" value={vttSegmentSeconds} onChange={setVttSegmentSeconds} />
              </Group>
              <Group grow>
                <NumberInput label="Max Cues/Sec" value={maxCuesPerSecond} onChange={setMaxCuesPerSecond} />
                <NumberInput label="Min Cue Dur Sec" value={minCueDurSec} onChange={setMinCueDurSec} step={0.01} precision={2} />
                <NumberInput label="Max Cue Dur Sec" value={maxCueDurSec} onChange={setMaxCueDurSec} step={0.01} precision={2} />
              </Group>
              <Group mt="md">
                <Button onClick={startSource}>Start Source</Button>
                <Button onClick={stopSource} color="red">Stop Source</Button>
                <Button onClick={refreshSources} variant="outline">Refresh</Button>
              </Group>
            </Paper>

            <Paper shadow="xs" p="md">
              <Text size="lg" fw={500}>Playback</Text>
              <Tabs value={activeTab} onChange={setActiveTab}>
                <Tabs.List>
                  <Tabs.Tab value="dvr">DVR (HLS)</Tabs.Tab>
                  <Tabs.Tab value="live-klv">Live KLV (WS)</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="dvr" pt="xs">
                  <Text>DVR HLS playback with VTT overlay</Text>
                  <video ref={videoRef} id="video-player" class="video-js" controls style={{ width: '100%', maxHeight: '400px' }}></video>
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