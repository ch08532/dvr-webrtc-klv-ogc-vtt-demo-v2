export const HLS_RENDITIONS = [
  {
    id: "360p",
    playlist: "v0/index.m3u8",
    width: 640,
    height: 360,
    videoBitrate: "800k",
    maxRate: "856k",
    bufferSize: "1200k",
    averageBandwidth: 800000,
    bandwidth: 856000,
    codecs: "avc1.42e01e,wvtt"
  },
  {
    id: "720p",
    playlist: "v1/index.m3u8",
    width: 1280,
    height: 720,
    videoBitrate: "3000k",
    maxRate: "3210k",
    bufferSize: "4500k",
    averageBandwidth: 3000000,
    bandwidth: 3210000,
    codecs: "avc1.42e01f,wvtt"
  },
  {
    id: "90p",
    playlist: "v2/index.m3u8",
    width: 160,
    height: 90,
    videoBitrate: "100k",
    maxRate: "120k",
    bufferSize: "150k",
    averageBandwidth: 100000,
    bandwidth: 120000,
    codecs: "avc1.42e00b,wvtt"
  }
];

export function createHlsMasterPlaylist() {
  const subtitleGroup = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="KLV",AUTOSELECT=YES,DEFAULT=NO,FORCED=NO,URI="subtitles.m3u8"';
  const variants = [...HLS_RENDITIONS]
    .sort((a, b) => a.bandwidth - b.bandwidth)
    .flatMap((rendition) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth},CODECS="${rendition.codecs}",RESOLUTION=${rendition.width}x${rendition.height},SUBTITLES="subs",CLOSED-CAPTIONS=NONE`,
    rendition.playlist
    ]);

  return [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    subtitleGroup,
    ...variants,
    ""
  ].join("\n");
}
