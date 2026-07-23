import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import OSM from 'ol/source/OSM.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat } from 'ol/proj.js';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style.js';
import 'ol/ol.css';

const platformStyle = (heading) => new Style({
  image: new RegularShape({
    points: 3,
    radius: 12,
    rotation: ((90 - heading) * Math.PI) / 180,
    fill: new Fill({ color: '#228be6' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 })
  }),
  text: new Text({
    text: 'Platform',
    offsetY: -20,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#1a1b1e', width: 3 })
  })
});

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

const isCoordinate = (lat, lon) => (
  Number.isFinite(Number(lat))
  && Number.isFinite(Number(lon))
  && Math.abs(Number(lat)) <= 90
  && Math.abs(Number(lon)) <= 180
);

export default function KlvMap({ telemetry, active }) {
  const targetRef = useRef(null);
  const mapRef = useRef(null);
  const sourceRef = useRef(null);
  const platformRef = useRef(null);
  const frameCenterRef = useRef(null);
  const lineRef = useRef(null);
  const [hasCoordinates, setHasCoordinates] = useState(false);

  useEffect(() => {
    const source = new VectorSource();
    const platform = new Feature();
    const frameCenter = new Feature();
    const line = new Feature();

    platform.setStyle(platformStyle(0));
    frameCenter.setStyle(frameCenterStyle);
    line.setStyle(lineStyle);
    source.addFeatures([line, platform, frameCenter]);

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
    frameCenterRef.current = frameCenter;
    lineRef.current = line;

    return () => {
      resizeObserver.disconnect();
      map.setTarget(undefined);
      mapRef.current = null;
      sourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !sourceRef.current) return;

    const sensorAvailable = isCoordinate(telemetry?.sensorLat, telemetry?.sensorLon);
    const frameCenterAvailable = isCoordinate(telemetry?.frameCenterLat, telemetry?.frameCenterLon);
    setHasCoordinates(sensorAvailable || frameCenterAvailable);

    if (!sensorAvailable && !frameCenterAvailable) {
      platformRef.current.setGeometry(null);
      frameCenterRef.current.setGeometry(null);
      lineRef.current.setGeometry(null);
      return;
    }

    const sensorPosition = sensorAvailable
      ? fromLonLat([Number(telemetry.sensorLon), Number(telemetry.sensorLat)])
      : null;
    const frameCenterPosition = frameCenterAvailable
      ? fromLonLat([Number(telemetry.frameCenterLon), Number(telemetry.frameCenterLat)])
      : null;

    platformRef.current.setGeometry(sensorPosition ? new Point(sensorPosition) : null);
    platformRef.current.setStyle(platformStyle(Number(telemetry?.platformHeadingDeg) || 0));
    frameCenterRef.current.setGeometry(frameCenterPosition ? new Point(frameCenterPosition) : null);
    lineRef.current.setGeometry(sensorPosition && frameCenterPosition
      ? new LineString([sensorPosition, frameCenterPosition])
      : null);

    const focusPosition = sensorPosition || frameCenterPosition;
    const view = mapRef.current.getView();
    view.cancelAnimations();
    view.animate({ center: focusPosition, duration: 200 });
    if (view.getZoom() < 13) view.setZoom(14);
  }, [telemetry]);

  useEffect(() => {
    if (active) mapRef.current?.updateSize();
  }, [active]);

  return (
    <div className="klv-map-shell">
      <div ref={targetRef} className="klv-map" aria-label="KLV telemetry map" />
      {!hasCoordinates ? <div className="klv-map-empty">Waiting for KLV coordinates…</div> : null}
    </div>
  );
}
