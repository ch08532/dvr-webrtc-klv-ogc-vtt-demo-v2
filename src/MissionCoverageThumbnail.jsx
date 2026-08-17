import { useEffect, useRef } from 'react';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { defaults as defaultControls } from 'ol/control/defaults.js';
import { Fill, Stroke, Style } from 'ol/style.js';
import 'ol/ol.css';
import { createBaseMapSource } from './map_base_layers.js';

const coverageStyle = new Style({
  stroke: new Stroke({ color: '#4FD68A', width: 2 }),
  fill: new Fill({ color: 'rgba(79, 214, 138, 0.28)' })
});

/** Non-interactive mission coverage preview using the app's shared base map. */
export default function MissionCoverageThumbnail({ geometry, baseMap }) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);
  const vectorSourceRef = useRef(null);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return undefined;
    const vectorSource = new VectorSource();
    const baseLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const map = new Map({
      target: hostRef.current,
      controls: defaultControls({ attribution: false, rotate: false, zoom: false }),
      layers: [baseLayer, new VectorLayer({ source: vectorSource, style: coverageStyle })],
      view: new View({ center: [0, 0], zoom: 2 })
    });
    const resizeObserver = new ResizeObserver(() => map.updateSize());
    resizeObserver.observe(hostRef.current);
    mapRef.current = map;
    baseLayerRef.current = baseLayer;
    vectorSourceRef.current = vectorSource;
    requestAnimationFrame(() => map.updateSize());
    return () => {
      resizeObserver.disconnect();
      map.setTarget(undefined);
      mapRef.current = null;
      baseLayerRef.current = null;
      vectorSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const previousLayer = baseLayerRef.current;
    if (!map || !previousLayer) return;
    const nextLayer = new TileLayer({ source: createBaseMapSource(baseMap) });
    const layers = map.getLayers();
    const index = layers.getArray().indexOf(previousLayer);
    if (index < 0) return;
    layers.setAt(index, nextLayer);
    baseLayerRef.current = nextLayer;
  }, [baseMap]);

  useEffect(() => {
    const map = mapRef.current;
    const source = vectorSourceRef.current;
    if (!map || !source || !geometry) return;
    source.clear();
    try {
      const feature = new Feature({ geometry: new GeoJSON().readGeometry(geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }) });
      source.addFeature(feature);
      map.getView().fit(feature.getGeometry().getExtent(), { padding: [8, 8, 8, 8], maxZoom: 13, duration: 0 });
    } catch {
      // An invalid saved geometry is omitted from the preview; the list remains usable.
    }
  }, [geometry]);

  return <div className={geometry ? 'mission-coverage-thumbnail' : 'mission-coverage-thumbnail is-empty'} aria-label={geometry ? 'Mission coverage map thumbnail' : 'No coverage area'}>
    <div ref={hostRef} />
    {!geometry ? <span>No coverage</span> : null}
  </div>;
}
