import { useEffect, useRef } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import { defaults as defaultControls } from 'ol/control/defaults.js';
import { fromLonLat, transformExtent } from 'ol/proj.js';
import { Fill, Stroke, Style, Circle as CircleStyle } from 'ol/style.js';
import 'ol/ol.css';
import { BASE_MAP_OPTIONS, createBaseMapSource } from './map_base_layers.js';

const normalStyle = new Style({ stroke: new Stroke({ color: '#3FC6D1', width: 3 }), fill: new Fill({ color: 'rgba(63,198,209,.14)' }), image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#3FC6D1' }) }) });
const selectedStyle = new Style({ stroke: new Stroke({ color: '#E8B23D', width: 5 }), fill: new Fill({ color: 'rgba(232,178,61,.18)' }), image: new CircleStyle({ radius: 8, fill: new Fill({ color: '#E8B23D' }) }) });
const savedMissionStyle = new Style({ stroke: new Stroke({ color: '#3DBE77', width: 3 }), fill: new Fill({ color: 'rgba(61,190,119,.18)' }) });
const selectedMissionStyle = new Style({ stroke: new Stroke({ color: '#4FD68A', width: 5 }), fill: new Fill({ color: 'rgba(79,214,138,.24)' }) });
const draftMissionStyle = new Style({ stroke: new Stroke({ color: '#E8B23D', width: 3 }), fill: new Fill({ color: 'rgba(232,178,61,.18)' }) });
const EMPTY_PRODUCTS = Object.freeze([]);
const EMPTY_COVERAGE_AREAS = Object.freeze([]);

function ViewAllMissionsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 4H5a1 1 0 0 0-1 1v4m11-5h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4m11-5v4a1 1 0 0 1-1 1h-4M8 12h8M12 8v8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Product and mission coverage map with feature picking and bbox drawing. */
export default function CatalogMap({
  products = EMPTY_PRODUCTS,
  selectedId = null,
  onSelect = () => {},
  coverageAreas = EMPTY_COVERAGE_AREAS,
  selectedCoverageAreaId = null,
  onCoverageAreaSelect = () => {},
  draftCoverageArea = null,
  baseMap = 'streets',
  onBaseMapChange = () => {},
  showViewAllMissions = false,
  drawing = false,
  onBboxDrawn = () => {}
}) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const baseMapLayerRef = useRef(null);
  const sourceRef = useRef(null);
  const lastFittedSelectionRef = useRef(null);
  const drawRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  const onCoverageAreaSelectRef = useRef(onCoverageAreaSelect);
  const onBboxDrawnRef = useRef(onBboxDrawn);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onCoverageAreaSelectRef.current = onCoverageAreaSelect; }, [onCoverageAreaSelect]);
  useEffect(() => { onBboxDrawnRef.current = onBboxDrawn; }, [onBboxDrawn]);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const source = new VectorSource(); sourceRef.current = source;
    const baseMapLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const map = new Map({
      target: hostRef.current,
      controls: defaultControls({ attribution: false, zoom: false }),
      layers: [baseMapLayer, new VectorLayer({
        source,
        style: (feature) => {
          if (feature.get('draftCoverageArea')) return draftMissionStyle;
          if (feature.get('coverageAreaId')) {
            return feature.get('coverageAreaId') === feature.get('selectedCoverageAreaId')
              ? selectedMissionStyle
              : savedMissionStyle;
          }
          return feature.get('productId') === feature.get('selectedId') ? selectedStyle : normalStyle;
        }
      })],
      view: new View({ center: fromLonLat([-75.6972, 45.4215]), zoom: 5 })
    });
    map.on('singleclick', (event) => map.forEachFeatureAtPixel(event.pixel, (feature) => {
      const productId = feature.get('productId');
      if (productId) {
        onSelectRef.current(productId);
        return feature;
      }
      const coverageAreaId = feature.get('coverageAreaId');
      if (coverageAreaId) onCoverageAreaSelectRef.current(coverageAreaId);
      return feature;
    }));
    mapRef.current = map;
    baseMapLayerRef.current = baseMapLayer;
    const resizeObserver = new ResizeObserver(() => map.updateSize());
    resizeObserver.observe(hostRef.current);
    return () => {
      resizeObserver.disconnect();
      map.setTarget(undefined);
      mapRef.current = null;
      baseMapLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const previousLayer = baseMapLayerRef.current;
    if (!map || !previousLayer) return;
    const baseMapLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const layers = map.getLayers();
    const index = layers.getArray().indexOf(previousLayer);
    if (index < 0) return;
    layers.setAt(index, baseMapLayer);
    baseMapLayerRef.current = baseMapLayer;
  }, [baseMap]);

  useEffect(() => {
    const map = mapRef.current; const source = sourceRef.current; if (!map || !source) return;
    const format = new GeoJSON(); source.clear();
    for (const product of products) {
      if (!product.geometry) continue;
      try {
        const feature = new Feature({ geometry: format.readGeometry(product.geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) });
        feature.setProperties({ productId: product.id, selectedId }); source.addFeature(feature);
      } catch {}
    }
    for (const coverageArea of coverageAreas) {
      if (!coverageArea.geometry) continue;
      try {
        const feature = new Feature({ geometry: format.readGeometry(coverageArea.geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) });
        feature.setProperties({ coverageAreaId: coverageArea.id, selectedCoverageAreaId });
        source.addFeature(feature);
      } catch {}
    }
    if (draftCoverageArea?.geometry) {
      try {
        const feature = new Feature({ geometry: format.readGeometry(draftCoverageArea.geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) });
        feature.setProperties({ draftCoverageArea: true });
        source.addFeature(feature);
      } catch {}
    }
    const selectionKey = selectedId != null
      ? `product:${selectedId}`
      : selectedCoverageAreaId != null
        ? `coverage:${selectedCoverageAreaId}`
        : null;
    if (!selectionKey) lastFittedSelectionRef.current = null;
    const selected = source.getFeatures().find((feature) => (
      (selectedId != null && feature.get('productId') === selectedId)
      || (selectedCoverageAreaId != null && feature.get('coverageAreaId') === selectedCoverageAreaId)
    ));
    if (selected?.getGeometry() && selectionKey && lastFittedSelectionRef.current !== selectionKey) {
      map.getView().fit(selected.getGeometry().getExtent(), { padding: [48, 48, 48, 48], maxZoom: 13, duration: 250 });
      lastFittedSelectionRef.current = selectionKey;
    }
  }, [products, selectedId, coverageAreas, selectedCoverageAreaId, draftCoverageArea]);

  useEffect(() => {
    const map = mapRef.current; const source = sourceRef.current; if (!map || !source) return;
    if (drawRef.current) { map.removeInteraction(drawRef.current); drawRef.current = null; }
    if (!drawing) return;
    const draw = new Draw({ source, type: 'Circle', geometryFunction: createBox() });
    draw.on('drawend', (event) => {
      const [west, south, east, north] = transformExtent(event.feature.getGeometry().getExtent(), 'EPSG:3857', 'EPSG:4326');
      source.removeFeature(event.feature); onBboxDrawnRef.current([west, south, east, north]);
    });
    map.addInteraction(draw); drawRef.current = draw;
    return () => { map.removeInteraction(draw); if (drawRef.current === draw) drawRef.current = null; };
  }, [drawing]);

  const fitAllMissionCoverage = () => {
    const map = mapRef.current;
    const source = sourceRef.current;
    if (!map || !source) return;
    const features = source.getFeatures().filter((feature) => feature.get('coverageAreaId'));
    if (!features.length) return;
    const extent = features[0].getGeometry()?.getExtent().slice();
    if (!extent) return;
    for (const feature of features.slice(1)) {
      const nextExtent = feature.getGeometry()?.getExtent();
      if (!nextExtent) continue;
      extent[0] = Math.min(extent[0], nextExtent[0]);
      extent[1] = Math.min(extent[1], nextExtent[1]);
      extent[2] = Math.max(extent[2], nextExtent[2]);
      extent[3] = Math.max(extent[3], nextExtent[3]);
    }
    map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: 13, duration: 250 });
    onCoverageAreaSelectRef.current(null);
  };

  const hasMissionCoverage = coverageAreas.some((coverageArea) => !!coverageArea.geometry);

  return <div className="catalog-map-shell">
    <div ref={hostRef} className="catalog-map" aria-label="Mission product map" />
    <label className="klv-map-basemap-control">
      <span>Base map</span>
      <select value={baseMap} onChange={(event) => onBaseMapChange(event.target.value)}>
        {BASE_MAP_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {showViewAllMissions ? <span className="catalog-map-view-all">
      <button
        type="button"
        className="klv-map-control-button"
        onClick={fitAllMissionCoverage}
        disabled={!hasMissionCoverage}
        aria-label="View all missions"
        title={hasMissionCoverage ? 'Fit all saved mission coverage areas' : 'No saved mission coverage areas to show'}
        data-tooltip={hasMissionCoverage ? 'View all missions' : 'No saved coverage'}
      ><ViewAllMissionsIcon /></button>
    </span> : null}
  </div>;
}
