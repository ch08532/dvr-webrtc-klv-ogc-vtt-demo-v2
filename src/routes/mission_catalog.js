import { Router } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function parseBbox(value) {
  if (value == null || value === '') return null;
  const values = String(value).split(',').map((item) => Number(item.trim()));
  if (values.length !== 4 || !values.every(Number.isFinite)) throw new Error('bbox must be west,south,east,north');
  const [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error('bbox must be a valid WGS84 extent');
  return values;
}

function parseDatetime(value) {
  if (!value) return null;
  const toMs = (input) => {
    const ms = Date.parse(String(input));
    if (!Number.isFinite(ms)) throw new Error('datetime must be ISO-8601 or an ISO interval');
    return ms;
  };
  const [from, to] = String(value).split('/');
  if (to == null) {
    const instant = toMs(from);
    return { fromMs: instant, toMs: instant };
  }
  const fromMs = from === '..' ? null : toMs(from);
  const toMsValue = to === '..' ? null : toMs(to);
  if (fromMs != null && toMsValue != null && fromMs > toMsValue) throw new Error('datetime interval must be chronological');
  return { fromMs, toMs: toMsValue };
}

function recordsFeature(product) {
  return {
    type: 'Feature', id: product.id, geometry: product.geometry,
    properties: {
      title: product.title, description: product.description, type: product.type,
      status: product.status, operationId: product.operationId, operation: product.operationTitle,
      missionId: product.missionId, mission: product.missionTitle,
      datetime: product.temporalStart && product.temporalEnd ? `${product.temporalStart}/${product.temporalEnd}` : null,
      created: product.createdAt, updated: product.updatedAt, parentProductId: product.parentProductId
    },
    links: [{ rel: 'self', href: `/ogc/collections/mission-products/items/${encodeURIComponent(product.id)}`, type: 'application/geo+json' }]
  };
}

function sendCatalogError(res, error) {
  res.status(error?.statusCode || 400).json({ error: String(error?.message || error) });
}

function productAssetDirectory(root, productId) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, String(productId)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('invalid managed mission product asset path');
  }
  return path.join(resolvedRoot, relative);
}

async function stageManagedProductAssets(root, productIds) {
  const resolvedRoot = path.resolve(root);
  const stagingRoot = path.join(resolvedRoot, `.deleting-${randomUUID()}`);
  const moved = [];
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    for (const productId of productIds) {
      const source = productAssetDirectory(resolvedRoot, productId);
      const destination = productAssetDirectory(stagingRoot, productId);
      try {
        await fs.rename(source, destination);
        moved.push({ source, destination });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    await Promise.all(moved.reverse().map(({ source, destination }) => fs.rename(destination, source).catch(() => {})));
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    async restore() {
      await Promise.all(moved.reverse().map(({ source, destination }) => fs.rename(destination, source).catch(() => {})));
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    },
    async remove() {
      await fs.rm(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };
}

/** Application CRUD and OGC API - Records endpoints backed by SpatiaLite. */
export function createMissionCatalogRouter({ store, sources, stopSourceRuntime, missionProductRoot }) {
  const router = Router();
  router.get('/ogc/conformance', (_req, res) => res.json({ conformsTo: [
    'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/record-api',
    'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/record-core-query-parameters',
    'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/json',
    'http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core'
  ] }));
  router.get('/mission-operations', async (_req, res) => res.json({ operations: await store.listMissionOperations() }));
  router.post('/mission-operations', async (req, res) => {
    try { res.status(201).json(await store.createMissionOperation({ id: randomUUID(), ...req.body })); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.put('/mission-operations/:operationId', async (req, res) => {
    try { res.json(await store.updateMissionOperation({ id: req.params.operationId, ...req.body })); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.delete('/mission-operations/:operationId', async (req, res) => {
    try { await store.deleteMissionOperation(req.params.operationId); res.status(204).end(); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.get('/missions', async (req, res) => {
    try { res.json({ missions: await store.listMissions(req.query.operationId || null) }); }
    catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
  });
  router.post('/missions', async (req, res) => {
    try { res.status(201).json(await store.createMission({ id: randomUUID(), ...req.body })); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.put('/missions/:missionId', async (req, res) => {
    try { res.json(await store.updateMission({ id: req.params.missionId, ...req.body })); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.delete('/missions/:missionId', async (req, res) => {
    try { await store.deleteMission(req.params.missionId); res.status(204).end(); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.get('/mission-products', async (req, res) => {
    try {
      res.json(await store.listMissionProducts({
        q: req.query.q, type: req.query.type, operationId: req.query.operationId, missionId: req.query.missionId,
        bbox: parseBbox(req.query.bbox), datetime: parseDatetime(req.query.datetime), limit: req.query.limit, offset: req.query.offset
      }));
    } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
  });
  router.get('/mission-products/:productId', async (req, res) => {
    const product = await store.getMissionProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'mission product not found' });
    return res.json(product);
  });
  router.post('/mission-products', async (req, res) => {
    try { res.status(201).json(await store.createMissionProduct({ id: randomUUID(), ...req.body })); }
    catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
  });
  router.put('/mission-products/:productId', async (req, res) => {
    try { res.json(await store.updateMissionProduct({ id: req.params.productId, title: req.body?.title, description: req.body?.description })); }
    catch (error) { sendCatalogError(res, error); }
  });
  router.delete('/mission-products/:productId', async (req, res) => {
    try {
      const group = await store.getMissionProductDeletionGroup(req.params.productId);
      const activeFmvProductIds = new Set(group.products.filter((product) => product.product_type === 'fmv').map((product) => product.id));
      if (sources && stopSourceRuntime && activeFmvProductIds.size) {
        const matchingStreamIds = [...sources.entries()]
          .filter(([, source]) => activeFmvProductIds.has(source?.missionProductId))
          .map(([streamId]) => streamId);
        for (const streamId of matchingStreamIds) await stopSourceRuntime(streamId);
      }
      const stagedAssets = await stageManagedProductAssets(missionProductRoot, group.productIds);
      try {
        await store.deleteMissionProductGroup(group.productIds);
      } catch (error) {
        await stagedAssets.restore();
        throw error;
      }
      await stagedAssets.remove();
      res.json({ deletedProductIds: group.productIds });
    } catch (error) { sendCatalogError(res, error); }
  });

  // OGC API - Records collection and item search.
  router.get('/ogc/collections/mission-products', (_req, res) => res.json({
    id: 'mission-products', title: 'Mission Products', itemType: 'record',
    description: 'FMV, snapshots, clips, and target logs cataloged by operation and mission.',
    crs: ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'],
    links: [{ rel: 'items', href: '/ogc/collections/mission-products/items', type: 'application/geo+json' }]
  }));
  router.get('/ogc/collections/mission-products/items', async (req, res) => {
    try {
      const result = await store.listMissionProducts({
        q: req.query.q, type: req.query.type, operationId: req.query.operationId, missionId: req.query.missionId,
        bbox: parseBbox(req.query.bbox), datetime: parseDatetime(req.query.datetime), limit: req.query.limit, offset: req.query.offset
      });
      const query = new URLSearchParams(req.query);
      const links = [{ rel: 'self', href: req.originalUrl, type: 'application/geo+json' }];
      if (result.offset + result.limit < result.total) {
        query.set('offset', String(result.offset + result.limit)); query.set('limit', String(result.limit));
        links.push({ rel: 'next', href: `/ogc/collections/mission-products/items?${query}`, type: 'application/geo+json' });
      }
      res.json({ type: 'FeatureCollection', numberMatched: result.total, numberReturned: result.products.length, features: result.products.map(recordsFeature), links });
    } catch (error) { res.status(400).json({ error: String(error?.message || error) }); }
  });
  router.get('/ogc/collections/mission-products/items/:productId', async (req, res) => {
    const product = await store.getMissionProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'record not found' });
    return res.type('application/geo+json').json(recordsFeature(product));
  });
  return router;
}
