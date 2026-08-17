import OSM from 'ol/source/OSM.js';
import XYZ from 'ol/source/XYZ.js';

export const BASE_MAP_OPTIONS = Object.freeze([
  { value: 'streets', label: 'OpenStreetMap' },
  { value: 'dark-openstreetmap', label: 'Dark mode (Alidade)' },
  { value: 'world-imagery', label: 'World Imagery' }
]);

export function createBaseMapSource(baseMap) {
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
}

export function baseMapAttribution(baseMap) {
  if (baseMap === 'world-imagery') return 'Tiles © Esri';
  if (baseMap === 'dark-openstreetmap') return '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors';
  return '© OpenStreetMap contributors';
}
