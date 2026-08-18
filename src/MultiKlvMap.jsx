import { useEffect, useRef, useState } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import Polygon from 'ol/geom/Polygon.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import 'ol/ol.css';
import { BASE_MAP_OPTIONS, baseMapAttribution, createBaseMapSource } from './map_base_layers.js';

const COLORS = ['#3fc6d1', '#e5484d', '#e8b23d', '#8d6ee8', '#51b873', '#e67e52', '#4d9de0'];
const colorFor = (id) => [...String(id)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLORS.length;
const valid = (lat, lon) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;
const frameCorners = (telemetry) => {
  const corners = [1, 2, 3, 4].map((index) => ({ lat: telemetry?.[`frameCorner${index}Lat`], lon: telemetry?.[`frameCorner${index}Lon`] }));
  return corners.every((corner) => valid(corner.lat, corner.lon)) && corners.some((corner) => Number(corner.lat) !== 0 || Number(corner.lon) !== 0) ? corners : null;
};

export default function MultiKlvMap({ items = [], focusedProductId = null, baseMap = 'streets', onBaseMapChange = () => {}, onPositionSelect = null }) {
  const targetRef = useRef(null);
  const mapRef = useRef(null);
  const sourceRef = useRef(null);
  const baseLayerRef = useRef(null);
  const [followFocused, setFollowFocused] = useState(false);

  useEffect(() => {
    const source = new VectorSource();
    const baseLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const map = new Map({ target: targetRef.current, layers: [baseLayer, new VectorLayer({ source })], view: new View({ center: fromLonLat([0, 0]), zoom: 2 }), controls: [] });
    const observer = new ResizeObserver(() => map.updateSize());
    observer.observe(targetRef.current);
    map.on('singleclick', (event) => {
      if (!onPositionSelect) return;
      const [lon, lat] = toLonLat(event.coordinate);
      if (valid(lat, lon)) onPositionSelect({ lat, lon });
    });
    mapRef.current = map; sourceRef.current = source; baseLayerRef.current = baseLayer;
    return () => { observer.disconnect(); map.setTarget(undefined); mapRef.current = null; sourceRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !baseLayerRef.current) return;
    const next = new TileLayer({ source: createBaseMapSource(baseMap) });
    const layers = map.getLayers();
    const index = layers.getArray().indexOf(baseLayerRef.current);
    if (index >= 0) layers.setAt(index, next);
    baseLayerRef.current = next;
  }, [baseMap]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    source.clear();
    const points = [];
    const addFeature = (geometry, style) => {
      const feature = new Feature({ geometry });
      feature.setStyle(style);
      source.addFeature(feature);
    };
    for (const item of items) {
      const color = COLORS[colorFor(item.productId)];
      const telemetry = item.telemetry || {};
      const until = Number(item.missionTimeMs);
      const addTrail = (history, width, alpha = 'aa') => {
        const coordinates = history?.geometry?.coordinates || [];
        const times = history?.properties?.timesMs || [];
        const projected = coordinates.filter((point, index) => Array.isArray(point) && valid(point[1], point[0]) && (!Number.isFinite(until) || Number(times[index]) <= until)).map(([lon, lat]) => fromLonLat([lon, lat]));
        if (projected.length > 1) addFeature(new LineString(projected), new Style({ stroke: new Stroke({ color: `${color}${alpha}`, width }) }));
      };
      addTrail(item.platformHistory, 3);
      addTrail(item.frameCenterHistory, 2, '77');
      const sensorPoint = valid(telemetry.sensorLat, telemetry.sensorLon) ? fromLonLat([Number(telemetry.sensorLon), Number(telemetry.sensorLat)]) : null;
      const framePoint = valid(telemetry.frameCenterLat, telemetry.frameCenterLon) ? fromLonLat([Number(telemetry.frameCenterLon), Number(telemetry.frameCenterLat)]) : null;
      if (valid(telemetry.sensorLat, telemetry.sensorLon)) {
        const point = sensorPoint;
        points.push(point);
        addFeature(new Point(point), new Style({ image: new CircleStyle({ radius: item.productId === focusedProductId ? 9 : 7, fill: new Fill({ color }), stroke: new Stroke({ color: '#e7ecef', width: 2 }) }) }));
      }
      if (valid(telemetry.frameCenterLat, telemetry.frameCenterLon)) {
        const point = framePoint;
        points.push(point);
        addFeature(new Point(point), new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color: '#e7ecef' }), stroke: new Stroke({ color, width: 3 }) }) }));
      }
      if (sensorPoint && framePoint) addFeature(new LineString([sensorPoint, framePoint]), new Style({ stroke: new Stroke({ color: `${color}bb`, width: 2, lineDash: [7, 5] }) }));
      const corners = frameCorners(telemetry);
      if (corners) {
        const ring = corners.map((corner) => fromLonLat([Number(corner.lon), Number(corner.lat)]));
        ring.push(ring[0]);
        addFeature(new Polygon([ring]), new Style({ fill: new Fill({ color: `${color}33` }), stroke: new Stroke({ color, width: 2 }) }));
      }
      for (const entry of item.targetLogEntries || []) {
        if (!valid(entry?.position?.lat, entry?.position?.lon)) continue;
        const target = fromLonLat([Number(entry.position.lon), Number(entry.position.lat)]);
        points.push(target);
        addFeature(new Point(target), new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color: '#e7ecef' }), stroke: new Stroke({ color, width: 2 }) }) }));
      }
    }
    const focused = items.find((item) => item.productId === focusedProductId)?.telemetry;
    if (followFocused && valid(focused?.frameCenterLat, focused?.frameCenterLon)) mapRef.current?.getView().setCenter(fromLonLat([Number(focused.frameCenterLon), Number(focused.frameCenterLat)]));
    if (points.length && !followFocused) mapRef.current?.getView().fit(source.getExtent(), { padding: [40, 40, 40, 40], maxZoom: 13, duration: 250 });
  }, [items, focusedProductId, followFocused]);

  const centerAll = () => {
    const source = sourceRef.current;
    if (source && source.getFeatures().length) mapRef.current?.getView().fit(source.getExtent(), { padding: [40, 40, 40, 40], maxZoom: 13, duration: 250 });
  };

  return <div className="multi-klv-map-shell">
    <div ref={targetRef} className="multi-klv-map" aria-label="Shared KLV telemetry map" />
    <div className="multi-klv-map-tools">
      <button type="button" onClick={centerAll}>Center all</button>
      <button type="button" className={followFocused ? 'is-active' : ''} onClick={() => setFollowFocused((value) => !value)}>Follow focused</button>
    </div>
    <label className="multi-klv-map-basemap"><span>Base map</span><select value={baseMap} onChange={(event) => onBaseMapChange(event.target.value)}>{BASE_MAP_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <div className="multi-klv-map-legend">{items.map((item) => <div key={item.productId}><span style={{ background: COLORS[colorFor(item.productId)] }} />{item.title}{item.productId === focusedProductId ? ' (focused)' : ''}</div>)}</div>
    <div className="multi-klv-map-attribution">{baseMapAttribution(baseMap)}</div>
  </div>;
}
