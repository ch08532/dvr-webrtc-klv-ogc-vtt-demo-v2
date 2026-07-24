import { fromArrayBuffer } from 'geotiff';

const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const USGS_TERRAIN_TILE_MILES = 100;
const MILES_PER_LATITUDE_DEGREE = 69;
const USGS_TERRAIN_IMAGE_SIZE = 2048;

const isFiniteNumber = (value) => Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const destinationPoint = (lat, lon, bearingDeg, distanceM) => {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = bearingDeg * DEG_TO_RAD;
  const startLat = lat * DEG_TO_RAD;
  const startLon = lon * DEG_TO_RAD;
  const endLat = Math.asin(
    Math.sin(startLat) * Math.cos(angularDistance)
    + Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const endLon = startLon + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLat),
    Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(endLat)
  );
  return {
    lat: endLat * RAD_TO_DEG,
    lon: ((endLon * RAD_TO_DEG + 540) % 360) - 180
  };
};

const terrainModelFromArrayBuffer = async (arrayBuffer) => {
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();

  if (
    ![minLon, minLat, maxLon, maxLat].every(Number.isFinite)
    || minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90
    || minLon >= maxLon || minLat >= maxLat
  ) {
    throw new Error('Terrain GeoTIFF must use WGS84 longitude/latitude coordinates (EPSG:4326).');
  }

  const noData = image.getGDALNoData();
  return {
    image,
    minLon,
    minLat,
    maxLon,
    maxLat,
    width: image.getWidth(),
    height: image.getHeight(),
    noData: noData == null ? null : Number(noData)
  };
};

export const getUsgsTerrainRequest = (lat, lon) => {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) return null;

  const latitudeSpan = USGS_TERRAIN_TILE_MILES / MILES_PER_LATITUDE_DEGREE;
  const centerLat = ((Math.floor((Number(lat) + 90) / latitudeSpan) + 0.5) * latitudeSpan) - 90;
  const longitudeSpan = USGS_TERRAIN_TILE_MILES / (MILES_PER_LATITUDE_DEGREE * Math.cos(centerLat * DEG_TO_RAD));
  const centerLon = ((Math.floor((Number(lon) + 180) / longitudeSpan) + 0.5) * longitudeSpan) - 180;
  const minLon = centerLon - (longitudeSpan / 2);
  const minLat = centerLat - (latitudeSpan / 2);
  const maxLon = centerLon + (longitudeSpan / 2);
  const maxLat = centerLat + (latitudeSpan / 2);
  const imageHeight = Math.max(1, Math.round(USGS_TERRAIN_IMAGE_SIZE * latitudeSpan / longitudeSpan));
  const bbox = [minLon, minLat, maxLon, maxLat].map((value) => value.toFixed(6)).join(',');
  const query = new URLSearchParams({
    bbox,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${USGS_TERRAIN_IMAGE_SIZE},${imageHeight}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    returnSquarePixels: 'false',
    f: 'image'
  });

  return {
    key: `usgs:${bbox}`,
    url: `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?${query.toString()}`
  };
};

export const loadTerrainModelFromUrl = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`USGS terrain request failed (HTTP ${response.status}).`);
  return terrainModelFromArrayBuffer(await response.arrayBuffer());
};

export async function getTerrainElevation(model, lon, lat) {
  if (
    !model
    || !isFiniteNumber(lon)
    || !isFiniteNumber(lat)
    || lon < model.minLon || lon > model.maxLon
    || lat < model.minLat || lat > model.maxLat
  ) {
    return null;
  }

  const x = clamp(Math.floor(((lon - model.minLon) / (model.maxLon - model.minLon)) * model.width), 0, model.width - 1);
  const y = clamp(Math.floor(((model.maxLat - lat) / (model.maxLat - model.minLat)) * model.height), 0, model.height - 1);
  const raster = await model.image.readRasters({ window: [x, y, x + 1, y + 1], samples: [0], interleave: true });
  const elevation = Number(raster[0]);

  if (!Number.isFinite(elevation) || (Number.isFinite(model.noData) && elevation === model.noData)) return null;
  return elevation;
}

export async function findTerrainIntersection(model, telemetry, { azimuthOffsetDeg = 0, elevationOffsetDeg = 0 } = {}) {
  const sensorLat = Number(telemetry?.sensorLat);
  const sensorLon = Number(telemetry?.sensorLon);
  const sensorAltitudeM = Number(telemetry?.sensorAltMslM);
  const platformHeadingDeg = Number(telemetry?.platformHeadingDeg);
  const sensorRelativeAzimuthDeg = Number(telemetry?.sensorRelAzDeg);
  const sensorRelativeElevationDeg = Number(telemetry?.sensorRelElDeg);
  const platformPitchDeg = Number(telemetry?.platformPitchDeg || 0);

  if (
    ![sensorLat, sensorLon, sensorAltitudeM, platformHeadingDeg, sensorRelativeAzimuthDeg, sensorRelativeElevationDeg]
      .every(Number.isFinite)
  ) {
    return null;
  }

  const bearingDeg = (platformHeadingDeg + sensorRelativeAzimuthDeg + Number(azimuthOffsetDeg) + 360) % 360;
  const elevationRad = (sensorRelativeElevationDeg + platformPitchDeg + Number(elevationOffsetDeg)) * DEG_TO_RAD;
  if (elevationRad >= -0.001) return null;

  const slantRangeM = Number(telemetry?.slantRangeM);
  const maximumDistanceM = Number.isFinite(slantRangeM) && slantRangeM > 0
    ? Math.min(Math.max(slantRangeM * 4, 5000), 100000)
    : 50000;
  const terrainAtSensor = await getTerrainElevation(model, sensorLon, sensorLat);
  if (terrainAtSensor == null || sensorAltitudeM <= terrainAtSensor) return null;

  let lowerDistanceM = 0;
  let upperDistanceM = null;
  for (let step = 1; step <= 24; step += 1) {
    const distanceM = (maximumDistanceM * step) / 24;
    const point = destinationPoint(sensorLat, sensorLon, bearingDeg, distanceM);
    const terrainElevationM = await getTerrainElevation(model, point.lon, point.lat);
    if (terrainElevationM == null) return null;
    const lineAltitudeM = sensorAltitudeM + distanceM * Math.tan(elevationRad);
    if (lineAltitudeM <= terrainElevationM) {
      upperDistanceM = distanceM;
      break;
    }
    lowerDistanceM = distanceM;
  }
  if (upperDistanceM == null) return null;

  for (let step = 0; step < 16; step += 1) {
    const distanceM = (lowerDistanceM + upperDistanceM) / 2;
    const point = destinationPoint(sensorLat, sensorLon, bearingDeg, distanceM);
    const terrainElevationM = await getTerrainElevation(model, point.lon, point.lat);
    if (terrainElevationM == null) return null;
    const lineAltitudeM = sensorAltitudeM + distanceM * Math.tan(elevationRad);
    if (lineAltitudeM <= terrainElevationM) upperDistanceM = distanceM;
    else lowerDistanceM = distanceM;
  }

  return destinationPoint(sensorLat, sensorLon, bearingDeg, (lowerDistanceM + upperDistanceM) / 2);
}

export async function findTerrainFootprint(model, telemetry) {
  const horizontalFovDeg = Number(telemetry?.sensorHfovDeg);
  const verticalFovDeg = Number(telemetry?.sensorVfovDeg);
  if (!Number.isFinite(horizontalFovDeg) || !Number.isFinite(verticalFovDeg) || horizontalFovDeg <= 0 || verticalFovDeg <= 0) {
    return null;
  }

  const halfHorizontalFov = horizontalFovDeg / 2;
  const halfVerticalFov = verticalFovDeg / 2;
  const cornerOffsets = [
    { azimuthOffsetDeg: -halfHorizontalFov, elevationOffsetDeg: halfVerticalFov },
    { azimuthOffsetDeg: halfHorizontalFov, elevationOffsetDeg: halfVerticalFov },
    { azimuthOffsetDeg: halfHorizontalFov, elevationOffsetDeg: -halfVerticalFov },
    { azimuthOffsetDeg: -halfHorizontalFov, elevationOffsetDeg: -halfVerticalFov }
  ];
  const corners = await Promise.all(cornerOffsets.map((offset) => findTerrainIntersection(model, telemetry, offset)));
  return corners.every(Boolean) ? corners : null;
}
