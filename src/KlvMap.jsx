import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import OSM from 'ol/source/OSM.js';
import XYZ from 'ol/source/XYZ.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style.js';
import 'ol/ol.css';

// Renders KLV geometry carried by the active cue, including the decoder's
// computed-flat fallback footprint. Terrain correction and terrain-derived
// targets/footprints are intentionally absent.
const normalizeHeading = (value) => {
  const heading = Number(value);
  if (!Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
};

const platformStyle = (heading) => new Style({
  image: new RegularShape({
    points: 3,
    radius: 12,
    rotation: ((90 - (heading ?? 0)) * Math.PI) / 180,
    fill: new Fill({ color: '#3FC6D1' }),
    stroke: new Stroke({ color: '#E7ECEF', width: 2 })
  })
});

const platformHeadingLineStyle = [
  new Style({ stroke: new Stroke({ color: '#E7ECEF', width: 5 }) }),
  new Style({ stroke: new Stroke({ color: '#3FC6D1', width: 3 }) })
];

const platformHistoryStyle = [
  new Style({ stroke: new Stroke({ color: 'rgba(231, 236, 239, 0.78)', width: 6 }) }),
  new Style({ stroke: new Stroke({ color: 'rgba(63, 198, 209, 0.88)', width: 3, lineDash: [9, 6] }) })
];

const frameCenterHistoryStyle = [
  new Style({ stroke: new Stroke({ color: 'rgba(231, 236, 239, 0.78)', width: 6 }) }),
  new Style({ stroke: new Stroke({ color: 'rgba(229, 72, 77, 0.9)', width: 3, lineDash: [7, 5] }) })
];

const frameCenterStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: '#E5484D' }),
    stroke: new Stroke({ color: '#E7ECEF', width: 2 })
  }),
  text: new Text({
    text: 'Frame center',
    offsetY: -18,
    fill: new Fill({ color: '#E7ECEF' }),
    stroke: new Stroke({ color: '#0A0D10', width: 3 })
  })
});

const lineStyle = new Style({
  stroke: new Stroke({ color: 'rgba(229, 72, 77, 0.8)', width: 2, lineDash: [8, 6] })
});

const frameGeometryStyle = new Style({
  fill: new Fill({ color: 'rgba(232, 178, 61, 0.22)' }),
  stroke: new Stroke({ color: '#E8B23D', width: 3 }),
  text: new Text({
    text: 'Frame footprint',
    offsetY: 18,
    fill: new Fill({ color: '#E7ECEF' }),
    stroke: new Stroke({ color: '#0A0D10', width: 3 })
  })
});

const targetLogStyle = (highlighted = false) => new Style({
  image: new CircleStyle({
    radius: highlighted ? 9 : 7,
    fill: new Fill({ color: highlighted ? '#E5484D' : '#3FC6D1' }),
    stroke: new Stroke({ color: '#E7ECEF', width: 2 })
  }),
  text: new Text({
    text: 'Target',
    offsetY: -18,
    fill: new Fill({ color: '#E7ECEF' }),
    stroke: new Stroke({ color: '#0A0D10', width: 3 })
  })
});

const isCoordinate = (lat, lon) => (
  Number.isFinite(Number(lat))
  && Number.isFinite(Number(lon))
  && Math.abs(Number(lat)) <= 90
  && Math.abs(Number(lon)) <= 180
);

const getKlvFrameCorners = (telemetry) => {
  const corners = [1, 2, 3, 4].map((index) => ({
    lat: telemetry?.[`frameCorner${index}Lat`],
    lon: telemetry?.[`frameCorner${index}Lon`]
  }));
  if (!corners.every((corner) => isCoordinate(corner.lat, corner.lon))) return null;
  return corners.some((corner) => Number(corner.lat) !== 0 || Number(corner.lon) !== 0) ? corners : null;
};

const createBaseMapSource = (baseMap) => {
  if (baseMap === 'world-imagery') {
    return new XYZ({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attributions: 'Tiles © Esri'
    });
  }
  if (baseMap === 'dark-openstreetmap') {
    return new XYZ({
      url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}@2x.png',
      attributions: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
      maxZoom: 20
    });
  }
  return new OSM();
};

/** Compact, dependency-free map-control icons. */
function MapControlIcon({ name }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (name === 'frame') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="5" {...common} />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" {...common} />
      </svg>
    );
  }
  if (name === 'follow') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" {...common} />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M18 5l2 2-2 2M20 7h-5" {...common} />
      </svg>
    );
  }
  if (name === 'history') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 17c3-8 5 2 8-5s5 3 8-5" {...common} />
        <circle cx="4" cy="17" r="1.5" {...common} />
        <circle cx="20" cy="7" r="1.5" {...common} />
      </svg>
    );
  }
  if (name === 'frame-history') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 17c3-8 5 2 8-5s5 3 8-5" {...common} />
        <circle cx="4" cy="17" r="1.5" {...common} />
        <circle cx="20" cy="7" r="1.5" {...common} />
        <circle cx="12" cy="12" r="2.5" {...common} />
      </svg>
    );
  }
  if (name === 'legend') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="4" width="14" height="16" rx="1.5" {...common} />
        <path d="M8 9h2M12 9h4M8 13h2M12 13h4M8 17h2M12 17h4" {...common} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" {...common} />
      <path d="M8 8h8v8H8z" {...common} />
    </svg>
  );
}

export default function KlvMap({
  telemetry,
  active,
  baseMap = 'streets',
  onBaseMapChange = () => {},
  platformHistory = null,
  platformHistoryUntilMs = null,
  showPlatformHistory = false,
  onPlatformHistoryToggle = null,
  platformHistoryLoading = false,
  frameCenterHistory = null,
  frameCenterHistoryUntilMs = null,
  showFrameCenterHistory = false,
  onFrameCenterHistoryToggle = null,
  frameCenterHistoryLoading = false,
  onPositionSelect = null,
  onPointerCoordinate = null,
  targetLogEntries = [],
  hoveredTargetLogId = null,
  onTargetLogHoverChange = null,
  onTargetLogActivate = null,
  matchHeightTo = null
}) {
  const targetRef = useRef(null);
  const mapRef = useRef(null);
  const baseMapLayerRef = useRef(null);
  const sourceRef = useRef(null);
  const platformHistoryRef = useRef(null);
  const frameCenterHistoryRef = useRef(null);
  const platformRef = useRef(null);
  const platformHeadingLineRef = useRef(null);
  const platformPositionRef = useRef(null);
  const platformHeadingRef = useRef(null);
  const frameCenterRef = useRef(null);
  const lineRef = useRef(null);
  const frameGeometryRef = useRef(null);
  const targetLogFeaturesRef = useRef([]);
  const focusPositionRef = useRef(null);
  const hasCenteredRef = useRef(false);
  const centerRequestRef = useRef(0);
  const onPositionSelectRef = useRef(onPositionSelect);
  const onPointerCoordinateRef = useRef(onPointerCoordinate);
  const onTargetLogHoverChangeRef = useRef(onTargetLogHoverChange);
  const onTargetLogActivateRef = useRef(onTargetLogActivate);
  const [hasCoordinates, setHasCoordinates] = useState(false);
  const [hasPlatformHistory, setHasPlatformHistory] = useState(false);
  const [hasFrameCenterHistory, setHasFrameCenterHistory] = useState(false);
  const [hasTargetLogPositions, setHasTargetLogPositions] = useState(false);
  const [hasFrameCenterPosition, setHasFrameCenterPosition] = useState(false);
  const [followFrameCenter, setFollowFrameCenter] = useState(false);
  const [showLegend, setShowLegend] = useState(true);

  useEffect(() => {
    onPositionSelectRef.current = onPositionSelect;
  }, [onPositionSelect]);

  useEffect(() => {
    onPointerCoordinateRef.current = onPointerCoordinate;
  }, [onPointerCoordinate]);

  useEffect(() => {
    onTargetLogHoverChangeRef.current = onTargetLogHoverChange;
  }, [onTargetLogHoverChange]);

  useEffect(() => {
    onTargetLogActivateRef.current = onTargetLogActivate;
  }, [onTargetLogActivate]);

  const centerOnPosition = (position) => {
    const map = mapRef.current;
    if (!map || !position) return;

    map.updateSize();
    const view = map.getView();
    view.cancelAnimations();
    view.setCenter(position);
    if (view.getZoom() < 13) view.setZoom(14);
  };

  const centerOnFrameCenter = () => centerOnPosition(focusPositionRef.current);

  // Fit the real telemetry geometry. The heading indicator is intentionally
  // excluded: its length is screen-resolution-relative, unlike the platform,
  // frame center, joining line, and footprint/FOV geometry.
  const centerOnAllFeatures = () => {
    const map = mapRef.current;
    if (!map) return;
    const fit = () => {
      const features = [
        platformHistoryRef.current,
        frameCenterHistoryRef.current,
        platformRef.current,
        frameCenterRef.current,
        lineRef.current,
        frameGeometryRef.current,
        ...targetLogFeaturesRef.current
      ];
      const extents = features
        .map((feature) => feature?.getGeometry?.()?.getExtent?.())
        .filter((extent) => Array.isArray(extent) && extent.every(Number.isFinite));
      if (!extents.length) return;

      const extent = [
        Math.min(...extents.map((item) => item[0])),
        Math.min(...extents.map((item) => item[1])),
        Math.max(...extents.map((item) => item[2])),
        Math.max(...extents.map((item) => item[3]))
      ];
      if (extent[0] === extent[2] && extent[1] === extent[3]) {
        // A cue may contain only a platform position while frame-center/FOV
        // telemetry is not yet available. Center the single available point
        // instead of delegating to the frame-center-only control.
        centerOnPosition([extent[0], extent[1]]);
        return;
      }

      map.updateSize();
      const view = map.getView();
      view.cancelAnimations();
      // Set the center explicitly before fitting. This still centers correctly
      // when a tab transition temporarily leaves OpenLayers with no map size.
      view.setCenter([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]);
      const size = map.getSize();
      if (Array.isArray(size) && size[0] > 0 && size[1] > 0) {
        view.fit(extent, { size, padding: [42, 160, 42, 32], maxZoom: 16, duration: 0 });
      }
    };

    fit();
    // Mantine tabs can finish their layout after the click handler. Refit on
    // the next frame so the entire collection remains visible in that case.
    requestAnimationFrame(fit);
  };

  const updatePlatformHeadingLine = () => {
    const map = mapRef.current;
    const line = platformHeadingLineRef.current;
    const position = platformPositionRef.current;
    const heading = platformHeadingRef.current;
    const resolution = map?.getView()?.getResolution();
    if (!line) return;
    if (!position || heading == null || !Number.isFinite(resolution)) {
      line.setGeometry(null);
      return;
    }

    const radians = (heading * Math.PI) / 180;
    const startDistance = resolution * 11;
    const endDistance = resolution * 42;
    line.setGeometry(new LineString([
      [position[0] + Math.sin(radians) * startDistance, position[1] + Math.cos(radians) * startDistance],
      [position[0] + Math.sin(radians) * endDistance, position[1] + Math.cos(radians) * endDistance]
    ]));
  };

  const centerOnInitialGeometry = () => {
    const requestId = ++centerRequestRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (requestId === centerRequestRef.current) centerOnAllFeatures();
      });
    });
  };

  useEffect(() => {
    const source = new VectorSource();
    const platformHistory = new Feature();
    const frameCenterHistory = new Feature();
    const platform = new Feature();
    const platformHeadingLine = new Feature();
    const frameCenter = new Feature();
    const line = new Feature();
    const frameGeometry = new Feature();

    platformHistory.setStyle(platformHistoryStyle);
    frameCenterHistory.setStyle(frameCenterHistoryStyle);
    platform.setStyle(platformStyle(0));
    platformHeadingLine.setStyle(platformHeadingLineStyle);
    frameCenter.setStyle(frameCenterStyle);
    line.setStyle(lineStyle);
    frameGeometry.setStyle(frameGeometryStyle);
    source.addFeatures([platformHistory, frameCenterHistory, frameGeometry, line, platformHeadingLine, platform, frameCenter]);

    const baseMapLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const map = new Map({
      target: targetRef.current,
      layers: [
        baseMapLayer,
        new VectorLayer({ source })
      ],
      view: new View({ center: fromLonLat([0, 0]), zoom: 2 }),
      controls: []
    });
    const resizeObserver = new ResizeObserver(() => map.updateSize());
    resizeObserver.observe(targetRef.current);

    mapRef.current = map;
    baseMapLayerRef.current = baseMapLayer;
    sourceRef.current = source;
    platformHistoryRef.current = platformHistory;
    frameCenterHistoryRef.current = frameCenterHistory;
    platformRef.current = platform;
    platformHeadingLineRef.current = platformHeadingLine;
    frameCenterRef.current = frameCenter;
    lineRef.current = line;
    frameGeometryRef.current = frameGeometry;
    const view = map.getView();
    const onResolutionChange = () => updatePlatformHeadingLine();
    const targetLogIdAtPixel = (pixel) => {
      let targetLogId = null;
      map.forEachFeatureAtPixel(pixel, (feature) => {
        const id = feature.get('targetLogEntryId');
        if (id) {
          targetLogId = id;
          return feature;
        }
        return undefined;
      }, { hitTolerance: 6 });
      return targetLogId;
    };
    const onMapSingleClick = (event) => {
      const targetLogId = targetLogIdAtPixel(event.pixel);
      if (targetLogId) {
        onTargetLogActivateRef.current?.(targetLogId);
        return;
      }

      const callback = onPositionSelectRef.current;
      if (!callback || !event?.coordinate) return;
      const [lon, lat] = toLonLat(event.coordinate);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        callback({ lat, lon });
      }
    };
    const onMapPointerMove = (event) => {
      const targetLogId = event?.pixel ? targetLogIdAtPixel(event.pixel) : null;
      onTargetLogHoverChangeRef.current?.(targetLogId);
      if (targetRef.current) targetRef.current.style.cursor = targetLogId ? 'pointer' : '';

      const callback = onPointerCoordinateRef.current;
      if (!callback || !event?.coordinate) return;
      const [lon, lat] = toLonLat(event.coordinate);
      callback(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { lat, lon }
        : null);
    };
    const onMapPointerLeave = () => {
      onTargetLogHoverChangeRef.current?.(null);
      onPointerCoordinateRef.current?.(null);
      if (targetRef.current) targetRef.current.style.cursor = '';
    };
    view.on('change:resolution', onResolutionChange);
    map.on('singleclick', onMapSingleClick);
    map.on('pointermove', onMapPointerMove);
    targetRef.current.addEventListener('pointerleave', onMapPointerLeave);

    return () => {
      resizeObserver.disconnect();
      view.un('change:resolution', onResolutionChange);
      map.un('singleclick', onMapSingleClick);
      map.un('pointermove', onMapPointerMove);
      targetRef.current?.removeEventListener('pointerleave', onMapPointerLeave);
      onTargetLogHoverChangeRef.current?.(null);
      onPointerCoordinateRef.current?.(null);
      map.setTarget(undefined);
      mapRef.current = null;
      baseMapLayerRef.current = null;
      sourceRef.current = null;
      platformHistoryRef.current = null;
      frameCenterHistoryRef.current = null;
      targetLogFeaturesRef.current = [];
      platformHeadingLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const previousLayer = baseMapLayerRef.current;
    if (!map || !previousLayer) return;

    // Replace only the base layer to preserve all telemetry overlays and map state.
    const baseMapLayer = new TileLayer({
      source: createBaseMapSource(baseMap)
    });
    const layers = map.getLayers();
    const index = layers.getArray().indexOf(previousLayer);
    if (index < 0) return;
    layers.setAt(index, baseMapLayer);
    baseMapLayerRef.current = baseMapLayer;
  }, [baseMap]);

  // Keep the map canvas aligned with the full video pane, including playback
  // controls and file-only widgets such as clip creation.
  useEffect(() => {
    const mapElement = targetRef.current;
    const videoElement = matchHeightTo?.current;
    if (!mapElement || !videoElement) return undefined;

    const syncHeight = () => {
      const height = Math.round(videoElement.getBoundingClientRect().height);
      if (height <= 0) return;
      mapElement.style.height = `${height}px`;
      mapRef.current?.updateSize();
    };

    const resizeObserver = new ResizeObserver(syncHeight);
    resizeObserver.observe(videoElement);
    syncHeight();
    return () => resizeObserver.disconnect();
  }, [matchHeightTo]);

  useEffect(() => {
    const historyFeature = platformHistoryRef.current;
    if (!historyFeature) return;
    // The GeoJSON endpoint guarantees `timesMs` is index-aligned with its
    // coordinates. File playback uses that contract to hide future route
    // samples while the active WebVTT cue is earlier in the mission.
    const coordinates = Array.isArray(platformHistory?.geometry?.coordinates)
      ? platformHistory.geometry.coordinates
      : [];
    const timesMs = Array.isArray(platformHistory?.properties?.timesMs)
      ? platformHistory.properties.timesMs
      : [];
    const untilMs = Number(platformHistoryUntilMs);
    const lineCoordinates = coordinates
      .filter((coordinate, index) => {
        if (!Array.isArray(coordinate) || !isCoordinate(coordinate[1], coordinate[0])) return false;
        const pointTimeMs = Number(timesMs[index]);
        return !Number.isFinite(untilMs) || (Number.isFinite(pointTimeMs) && pointTimeMs <= untilMs);
      })
      .map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]);

    // Track samples arrive only after a segment is complete. Bridge the
    // resulting one-segment gap with the active cue's platform coordinate so
    // the visible trail terminates at the moving platform marker.
    const currentPlatformCoordinate = isCoordinate(telemetry?.sensorLat, telemetry?.sensorLon)
      ? [Number(telemetry.sensorLon), Number(telemetry.sensorLat)]
      : null;
    const lastHistoryCoordinate = lineCoordinates[lineCoordinates.length - 1];
    if (currentPlatformCoordinate && (!lastHistoryCoordinate
      || lastHistoryCoordinate[0] !== currentPlatformCoordinate[0]
      || lastHistoryCoordinate[1] !== currentPlatformCoordinate[1])) {
      lineCoordinates.push(currentPlatformCoordinate);
    }

    const projected = lineCoordinates
      .map((coordinate) => fromLonLat(coordinate));
    const visible = showPlatformHistory && projected.length >= 2;
    historyFeature.setGeometry(visible ? new LineString(projected) : null);
    setHasPlatformHistory(visible);
  }, [platformHistory, platformHistoryUntilMs, showPlatformHistory, telemetry]);

  useEffect(() => {
    const historyFeature = frameCenterHistoryRef.current;
    if (!historyFeature) return;
    const coordinates = Array.isArray(frameCenterHistory?.geometry?.coordinates)
      ? frameCenterHistory.geometry.coordinates
      : [];
    const timesMs = Array.isArray(frameCenterHistory?.properties?.timesMs)
      ? frameCenterHistory.properties.timesMs
      : [];
    const untilMs = Number(frameCenterHistoryUntilMs);
    const lineCoordinates = coordinates
      .filter((coordinate, index) => {
        if (!Array.isArray(coordinate) || !isCoordinate(coordinate[1], coordinate[0])) return false;
        const pointTimeMs = Number(timesMs[index]);
        return !Number.isFinite(untilMs) || (Number.isFinite(pointTimeMs) && pointTimeMs <= untilMs);
      })
      .map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]);

    // Like platform history, completed-segment indexing naturally trails the
    // active cue. Append the current frame center only in map memory.
    const currentFrameCenterCoordinate = isCoordinate(telemetry?.frameCenterLat, telemetry?.frameCenterLon)
      ? [Number(telemetry.frameCenterLon), Number(telemetry.frameCenterLat)]
      : null;
    const lastHistoryCoordinate = lineCoordinates[lineCoordinates.length - 1];
    if (currentFrameCenterCoordinate && (!lastHistoryCoordinate
      || lastHistoryCoordinate[0] !== currentFrameCenterCoordinate[0]
      || lastHistoryCoordinate[1] !== currentFrameCenterCoordinate[1])) {
      lineCoordinates.push(currentFrameCenterCoordinate);
    }

    const projected = lineCoordinates.map((coordinate) => fromLonLat(coordinate));
    const visible = showFrameCenterHistory && projected.length >= 2;
    historyFeature.setGeometry(visible ? new LineString(projected) : null);
    setHasFrameCenterHistory(visible);
  }, [frameCenterHistory, frameCenterHistoryUntilMs, showFrameCenterHistory, telemetry]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;

    source.removeFeatures(targetLogFeaturesRef.current);
    const features = (Array.isArray(targetLogEntries) ? targetLogEntries : [])
      .filter((entry) => entry?.id && isCoordinate(entry?.position?.lat, entry?.position?.lon))
      .map((entry) => {
        const feature = new Feature({
          geometry: new Point(fromLonLat([Number(entry.position.lon), Number(entry.position.lat)]))
        });
        feature.set('targetLogEntryId', entry.id);
        feature.setStyle(targetLogStyle(entry.id === hoveredTargetLogId));
        return feature;
      });
    source.addFeatures(features);
    targetLogFeaturesRef.current = features;
    setHasTargetLogPositions(features.length > 0);
  }, [targetLogEntries, hoveredTargetLogId]);

  useEffect(() => {
    hasCenteredRef.current = false;
    centerRequestRef.current += 1;
  }, [active]);

  useEffect(() => {
    if (active && hasTargetLogPositions && !hasCenteredRef.current) {
      hasCenteredRef.current = true;
      centerOnInitialGeometry();
    }
  }, [active, hasTargetLogPositions]);

  useEffect(() => {
    if (active && hasPlatformHistory && !hasCenteredRef.current) {
      hasCenteredRef.current = true;
      centerOnInitialGeometry();
    }
  }, [active, hasPlatformHistory]);

  useEffect(() => {
    if (active && hasFrameCenterHistory && !hasCenteredRef.current) {
      hasCenteredRef.current = true;
      centerOnInitialGeometry();
    }
  }, [active, hasFrameCenterHistory]);

  useEffect(() => {
    if (!mapRef.current || !sourceRef.current) return;

    const sensorAvailable = isCoordinate(telemetry?.sensorLat, telemetry?.sensorLon);
    const frameCenterAvailable = isCoordinate(telemetry?.frameCenterLat, telemetry?.frameCenterLon);
    setHasCoordinates(sensorAvailable || frameCenterAvailable);
    setHasFrameCenterPosition(frameCenterAvailable);

    if (!sensorAvailable && !frameCenterAvailable) {
      platformRef.current.setGeometry(null);
      platformPositionRef.current = null;
      platformHeadingRef.current = null;
      updatePlatformHeadingLine();
      frameCenterRef.current.setGeometry(null);
      lineRef.current.setGeometry(null);
      frameGeometryRef.current.setGeometry(null);
      focusPositionRef.current = null;
      return;
    }

    const sensorPosition = sensorAvailable
      ? fromLonLat([Number(telemetry.sensorLon), Number(telemetry.sensorLat)])
      : null;
    const frameCenterPosition = frameCenterAvailable
      ? fromLonLat([Number(telemetry.frameCenterLon), Number(telemetry.frameCenterLat)])
      : null;
    const platformHeading = normalizeHeading(telemetry?.platformHeadingDeg);

    platformRef.current.setGeometry(sensorPosition ? new Point(sensorPosition) : null);
    platformRef.current.setStyle(platformStyle(platformHeading));
    platformPositionRef.current = sensorPosition;
    platformHeadingRef.current = platformHeading;
    updatePlatformHeadingLine();
    frameCenterRef.current.setGeometry(frameCenterPosition ? new Point(frameCenterPosition) : null);
    lineRef.current.setGeometry(sensorPosition && frameCenterPosition
      ? new LineString([sensorPosition, frameCenterPosition])
      : null);
    const klvFrameCorners = getKlvFrameCorners(telemetry);
    if (klvFrameCorners) {
      frameGeometryRef.current.setGeometry(new Polygon([[...klvFrameCorners.map((corner) => fromLonLat([Number(corner.lon), Number(corner.lat)])), fromLonLat([Number(klvFrameCorners[0].lon), Number(klvFrameCorners[0].lat)])]]));
    } else {
      frameGeometryRef.current.setGeometry(null);
    }

    focusPositionRef.current = frameCenterPosition;
    if (active && frameCenterPosition && followFrameCenter) {
      centerOnFrameCenter();
    } else if (active && !hasCenteredRef.current) {
      hasCenteredRef.current = true;
      centerOnInitialGeometry();
    }
  }, [telemetry, active, followFrameCenter]);

  useEffect(() => {
    if (active) mapRef.current?.updateSize();
  }, [active]);

  return (
    <div className="klv-map-shell">
      <div ref={targetRef} className="klv-map" aria-label="KLV telemetry map" />
      <label className="klv-map-basemap-control">
        <span>Base map</span>
        <select value={baseMap} onChange={(event) => onBaseMapChange(event.target.value)}>
          <option value="streets">OpenStreetMap</option>
          <option value="dark-openstreetmap">Dark mode (Alidade)</option>
          <option value="world-imagery">World Imagery</option>
        </select>
      </label>
      <div className="klv-map-attribution">
        {baseMap === 'world-imagery'
          ? 'Tiles © Esri'
          : baseMap === 'dark-openstreetmap'
            ? '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors'
            : '© OpenStreetMap contributors'}
      </div>
      {showLegend ? <div className="klv-map-legend" aria-label="Telemetry map legend">
        <div className="klv-map-legend-title">Telemetry layers</div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-platform" aria-hidden="true" />
          <span>Platform / heading</span>
        </div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-history" aria-hidden="true" />
          <span>Platform history</span>
        </div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-frame-history" aria-hidden="true" />
          <span>Frame-center history</span>
        </div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-frame-center" aria-hidden="true" />
          <span>Frame center</span>
        </div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-footprint" aria-hidden="true" />
          <span>Frame footprint</span>
        </div>
        <div className="klv-map-legend-row">
          <span className="klv-map-legend-symbol klv-map-legend-target" aria-hidden="true" />
          <span>Target mark</span>
        </div>
      </div> : null}
      <div className="klv-map-controls">
        <button
          type="button"
          className="klv-map-control-button"
          onClick={centerOnAllFeatures}
          disabled={!hasCoordinates && !hasTargetLogPositions && !hasPlatformHistory && !hasFrameCenterHistory}
          aria-label="Center map on telemetry and targets"
          title="Center map on telemetry and targets"
          data-tooltip="Center map"
        >
          <MapControlIcon name="map" />
        </button>
        <button
          type="button"
          className="klv-map-control-button"
          onClick={centerOnFrameCenter}
          disabled={!hasFrameCenterPosition}
          aria-label="Center on frame center"
          title="Center on frame center"
          data-tooltip="Center frame"
        >
          <MapControlIcon name="frame" />
        </button>
        <button
          type="button"
          className={`klv-map-control-button${followFrameCenter ? ' is-active' : ''}`}
          onClick={() => {
            setFollowFrameCenter((following) => {
              const next = !following;
              if (next) centerOnFrameCenter();
              return next;
            });
          }}
          disabled={!hasFrameCenterPosition}
          aria-pressed={followFrameCenter}
          aria-label={followFrameCenter ? 'Stop following frame center' : 'Follow frame center'}
          title={followFrameCenter ? 'Stop following frame center' : 'Follow frame center'}
          data-tooltip={followFrameCenter ? 'Stop following frame' : 'Follow frame center'}
        >
          <MapControlIcon name="follow" />
        </button>
        <button
          type="button"
          className={`klv-map-control-button${showPlatformHistory ? ' is-active' : ''}`}
          onClick={() => onPlatformHistoryToggle?.(!showPlatformHistory)}
          disabled={!onPlatformHistoryToggle || !active}
          aria-pressed={showPlatformHistory}
          aria-busy={platformHistoryLoading}
          aria-label={showPlatformHistory ? 'Hide platform history' : 'Show platform history'}
          title={showPlatformHistory ? 'Hide platform history' : 'Show platform history'}
          data-tooltip={showPlatformHistory ? 'Hide platform history' : 'Show platform history'}
        >
          <MapControlIcon name="history" />
        </button>
        <button
          type="button"
          className={`klv-map-control-button${showFrameCenterHistory ? ' is-active' : ''}`}
          onClick={() => onFrameCenterHistoryToggle?.(!showFrameCenterHistory)}
          disabled={!onFrameCenterHistoryToggle || !active}
          aria-pressed={showFrameCenterHistory}
          aria-busy={frameCenterHistoryLoading}
          aria-label={showFrameCenterHistory ? 'Hide frame-center history' : 'Show frame-center history'}
          title={showFrameCenterHistory ? 'Hide frame-center history' : 'Show frame-center history'}
          data-tooltip={showFrameCenterHistory ? 'Hide frame history' : 'Show frame history'}
        >
          <MapControlIcon name="frame-history" />
        </button>
        <button
          type="button"
          className={`klv-map-control-button${showLegend ? ' is-active' : ''}`}
          onClick={() => setShowLegend((visible) => !visible)}
          aria-pressed={showLegend}
          aria-label={showLegend ? 'Hide telemetry legend' : 'Show telemetry legend'}
          title={showLegend ? 'Hide telemetry legend' : 'Show telemetry legend'}
          data-tooltip={showLegend ? 'Hide legend' : 'Show legend'}
        >
          <MapControlIcon name="legend" />
        </button>
      </div>
      {!hasCoordinates && !hasPlatformHistory && !hasFrameCenterHistory ? <div className="klv-map-empty">Waiting for KLV coordinates…</div> : null}
    </div>
  );
}
