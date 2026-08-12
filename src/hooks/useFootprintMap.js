import { useCallback, useState } from 'react';

function samePosition(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7
    && Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;
}

/** State local to a single telemetry-map view. The stable callback prevents
 * OpenLayers pointer events from creating a new map-prop function per render. */
export function useFootprintMap() {
  const [pointerPosition, setPointerPosition] = useState(null);
  const onPointerCoordinate = useCallback((position) => {
    setPointerPosition((previous) => samePosition(previous, position) ? previous : position);
  }, []);
  return { pointerPosition, onPointerCoordinate };
}
