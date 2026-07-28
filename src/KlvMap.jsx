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
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat } from 'ol/proj.js';
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
    fill: new Fill({ color: '#228be6' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 })
  })
});

const platformHeadingLineStyle = [
  new Style({ stroke: new Stroke({ color: '#ffffff', width: 5 }) }),
  new Style({ stroke: new Stroke({ color: '#228be6', width: 3 }) })
];

const frameCenterStyle = new Style({
  image: new CircleStyle({
    radius: 7,
    fill: new Fill({ color: '#fa5252' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 })
  }),
  text: new Text({
    text: 'Frame center',
    offsetY: -18,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#1a1b1e', width: 3 })
  })
});

const lineStyle = new Style({
  stroke: new Stroke({ color: 'rgba(250, 82, 82, 0.8)', width: 2, lineDash: [8, 6] })
});

const frameGeometryStyle = new Style({
  fill: new Fill({ color: 'rgba(252, 196, 25, 0.22)' }),
  stroke: new Stroke({ color: '#f08c00', width: 3 }),
  text: new Text({
    text: 'Frame footprint',
    offsetY: 18,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#1a1b1e', width: 3 })
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
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 19H4v-4" {...common} />
      <path d="M8 8h8v8H8z" {...common} />
    </svg>
  );
}

export default function KlvMap({ telemetry, active }) {
  const targetRef = useRef(null);
  const mapRef = useRef(null);
  const sourceRef = useRef(null);
  const platformRef = useRef(null);
  const platformHeadingLineRef = useRef(null);
  const platformPositionRef = useRef(null);
  const platformHeadingRef = useRef(null);
  const frameCenterRef = useRef(null);
  const lineRef = useRef(null);
  const frameGeometryRef = useRef(null);
  const focusPositionRef = useRef(null);
  const hasCenteredRef = useRef(false);
  const centerRequestRef = useRef(0);
  const [hasCoordinates, setHasCoordinates] = useState(false);
  const [hasFrameCenterPosition, setHasFrameCenterPosition] = useState(false);
  const [followFrameCenter, setFollowFrameCenter] = useState(false);

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
      const features = [platformRef.current, frameCenterRef.current, lineRef.current, frameGeometryRef.current];
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
    const platform = new Feature();
    const platformHeadingLine = new Feature();
    const frameCenter = new Feature();
    const line = new Feature();
    const frameGeometry = new Feature();

    platform.setStyle(platformStyle(0));
    platformHeadingLine.setStyle(platformHeadingLineStyle);
    frameCenter.setStyle(frameCenterStyle);
    line.setStyle(lineStyle);
    frameGeometry.setStyle(frameGeometryStyle);
    source.addFeatures([frameGeometry, line, platformHeadingLine, platform, frameCenter]);

    const map = new Map({
      target: targetRef.current,
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({ source })
      ],
      view: new View({ center: fromLonLat([0, 0]), zoom: 2 }),
      controls: []
    });
    const resizeObserver = new ResizeObserver(() => map.updateSize());
    resizeObserver.observe(targetRef.current);

    mapRef.current = map;
    sourceRef.current = source;
    platformRef.current = platform;
    platformHeadingLineRef.current = platformHeadingLine;
    frameCenterRef.current = frameCenter;
    lineRef.current = line;
    frameGeometryRef.current = frameGeometry;
    const view = map.getView();
    const onResolutionChange = () => updatePlatformHeadingLine();
    view.on('change:resolution', onResolutionChange);

    return () => {
      resizeObserver.disconnect();
      view.un('change:resolution', onResolutionChange);
      map.setTarget(undefined);
      mapRef.current = null;
      sourceRef.current = null;
      platformHeadingLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    hasCenteredRef.current = false;
    centerRequestRef.current += 1;
  }, [active]);

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
      <div className="klv-map-controls">
        <button
          type="button"
          className="klv-map-control-button"
          onClick={centerOnAllFeatures}
          disabled={!hasCoordinates}
          aria-label="Center map on all telemetry"
          title="Center map on all telemetry"
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
      </div>
      {!hasCoordinates ? <div className="klv-map-empty">Waiting for KLV coordinates…</div> : null}
    </div>
  );
}
