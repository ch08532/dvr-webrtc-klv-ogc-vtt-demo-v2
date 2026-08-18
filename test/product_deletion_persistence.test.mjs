import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createMissionCatalogRouter } from "../src/routes/mission_catalog.js";

async function requestDelete(app, productId) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}/mission-products/${productId}`, { method: "DELETE" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("deleting an FMV product removes its complete staged product workspace and source data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "midas-product-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await Promise.all([
    fs.mkdir(path.join(assets, "fmv-1", "source"), { recursive: true }),
    fs.mkdir(path.join(assets, "fmv-1", "private"), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(assets, "fmv-1", "master.m3u8"), "#EXTM3U"),
    fs.writeFile(path.join(assets, "fmv-1", "source", "video.ts"), "video"),
    fs.writeFile(path.join(assets, "fmv-1", "private", "ingest.sdp"), "sdp")
  ]);
  const calls = [];
  const store = {
    async getMissionProductDeletionGroup() {
      return { productIds: ["fmv-1"], products: [{ id: "fmv-1", product_type: "fmv", source_stream_id: "stream-1" }] };
    },
    async deleteMissionProductGroupAndSourceData(args) { calls.push(args); }
  };
  const app = express();
  app.use(createMissionCatalogRouter({
    store,
    sources: new Map(),
    missionProductRoot: assets
  }));

  const response = await requestDelete(app, "fmv-1");
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ productIds: ["fmv-1"], purgeSourceStreamIds: ["stream-1"], purgeTargetLogStreamIds: [] }]);
  await assert.rejects(fs.access(path.join(assets, "fmv-1")));
});

test("deleting a target-log product preserves its FMV product workspace but purges its log data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "midas-target-log-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  await Promise.all([
    fs.mkdir(path.join(assets, "log-1"), { recursive: true }),
    fs.mkdir(path.join(assets, "fmv-1"), { recursive: true })
  ]);
  await fs.writeFile(path.join(assets, "fmv-1", "segment0.ts"), "video");
  const calls = [];
  const app = express();
  app.use(createMissionCatalogRouter({
    store: {
      async getMissionProductDeletionGroup() {
        return { productIds: ["log-1"], products: [{ id: "log-1", product_type: "target-log", source_stream_id: "stream-1" }] };
      },
      async deleteMissionProductGroupAndSourceData(args) { calls.push(args); }
    },
    sources: new Map(),
    missionProductRoot: assets
  }));

  const response = await requestDelete(app, "log-1");
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ productIds: ["log-1"], purgeSourceStreamIds: [], purgeTargetLogStreamIds: ["stream-1"] }]);
  await fs.access(path.join(assets, "fmv-1", "segment0.ts"));
});
