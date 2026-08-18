import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { deriveClipProductMetadata } from "../src/clip_product_metadata.js";
import { createOgcProcessesRouter } from "../src/routes/ogc_processes.js";

test("clip product metadata uses KLV samples from the selected clip window", async () => {
  const windows = [];
  const store = {
    async getMissionTimeline() {
      return { missionBaseMs: 1_000_000, videoBaseMs: 0, missionMinMs: 1_002_000, missionMaxMs: 1_020_000 };
    },
    async listPlatformTrackPoints(_streamId, window) {
      windows.push(window);
      return { points: [{ lat: 45, lon: -75 }, { lat: 45.1, lon: -75.1 }] };
    },
    async listFrameCenterTrackPoints(_streamId, window) {
      windows.push(window);
      return { points: [{ lat: 44.9, lon: -74.9 }] };
    },
    async getManualVideoTimeAnchor() {
      throw new Error("manual anchor should not be used when KLV is present");
    }
  };

  const metadata = await deriveClipProductMetadata({ store, streamId: "stream-1", startSeconds: 5, endSeconds: 10 });
  assert.deepEqual(windows, [{ fromMs: 1_005_000, toMs: 1_010_000 }, { fromMs: 1_005_000, toMs: 1_010_000 }]);
  assert.equal(metadata.temporalStartMs, 1_005_000);
  assert.equal(metadata.temporalEndMs, 1_010_000);
  assert.equal(metadata.geometryWkt, "GEOMETRYCOLLECTION(LINESTRING(-75 45,-75.1 45.1),POINT(-74.9 44.9))");
  assert.equal(metadata.metadataSource, "klv");
});

test("clip product metadata falls back to the mission bbox when no clip metadata exists", async () => {
  const metadata = await deriveClipProductMetadata({
    streamId: "stream-1",
    startSeconds: 5,
    endSeconds: 10,
    store: {
      async getMissionTimeline() { return null; },
      async getManualVideoTimeAnchor() { return null; }
    }
  });
  assert.deepEqual(metadata, { temporalStartMs: null, temporalEndMs: null, geometryWkt: null, metadataSource: "mission" });
});

test("OGC clip export accepts no missionId and preserves the requested product mode", async (t) => {
  const received = [];
  const app = express();
  app.use(express.json());
  app.use("/ogc", createOgcProcessesRouter({
    startSourceRuntime: async () => { throw new Error("not used"); },
    stopSourceRuntime: async () => {},
    getSourceRuntime: () => ({}),
    createFileClipRuntime: async (streamId, inputs) => {
      received.push({ streamId, inputs });
      return { clip: { clipId: "clip-1", filename: "clip.ts", path: "private", downloadUrl: "/download" } };
    }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const post = async (createProduct) => fetch(`http://127.0.0.1:${address.port}/ogc/processes/export-clip/execution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: { streamId: "stream-1", startSeconds: 1, endSeconds: 2, ...(createProduct === undefined ? {} : { createProduct }) } })
  });

  const downloadResponse = await post(undefined);
  assert.equal(downloadResponse.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  const productResponse = await post(true);
  assert.equal(productResponse.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 2);
  assert.equal(received[0].inputs.createProduct, undefined);
  assert.equal(received[1].inputs.createProduct, true);
});

test("OGC FMV provisioning allocates an internal stream ID when one is omitted", async (t) => {
  const received = [];
  const app = express();
  app.use(express.json());
  app.use("/ogc", createOgcProcessesRouter({
    allocateStreamId: async () => "fmv-generated-id",
    stopSourceRuntime: async () => {},
    getSourceRuntime: () => ({ state: "running" }),
    startSourceRuntime: async (inputs) => {
      received.push(inputs);
      return { streamId: inputs.streamId, state: { state: "running" } };
    }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/ogc/processes/provision-live-fmv/execution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: { missionId: "mission-1", inputUrl: "udp://239.0.0.1:5000" } })
  });
  const job = await response.json();
  assert.equal(response.status, 201);
  assert.equal(job.streamId, "fmv-generated-id");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0].streamId, "fmv-generated-id");
});

test("OGC FMV provisioning reserves a source workspace with a future product ID", async (t) => {
  const received = [];
  const app = express();
  app.use(express.json());
  app.use("/ogc", createOgcProcessesRouter({
    allocateSourcePreparation: async ({ missionId, sourceType }) => ({
      streamId: "fmv-server-generated", productId: "11111111-1111-4111-8111-111111111111", missionId, sourceType
    }),
    stopSourceRuntime: async () => {},
    getSourceRuntime: () => ({ state: "running", productId: "11111111-1111-4111-8111-111111111111" }),
    startSourceRuntime: async (inputs) => {
      received.push(inputs);
      return { streamId: inputs.streamId, productId: "11111111-1111-4111-8111-111111111111", state: { state: "running", productId: "11111111-1111-4111-8111-111111111111" } };
    }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/ogc/processes/provision-live-fmv/execution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: { missionId: "mission-1", inputUrl: "udp://239.0.0.1:5000" } })
  });
  const job = await response.json();
  assert.equal(response.status, 201);
  assert.equal(job.streamId, "fmv-server-generated");
  assert.equal(job.productId, "11111111-1111-4111-8111-111111111111");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0].streamId, "fmv-server-generated");
});
