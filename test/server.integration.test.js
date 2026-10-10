import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fakeYtDlp = path.join(root, "test-support", "fake-yt-dlp");
const fakeFfmpeg = path.join(root, "test-support", "fake-ffmpeg");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, diagnostics) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Servidor encerrou antes do teste:\n${diagnostics.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch { /* O servidor ainda está iniciando. */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Servidor não iniciou:\n${diagnostics.join("")}`);
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForBatch(baseUrl, id, acceptedStates, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/batches/${id}`);
    const batch = await response.json();
    if (acceptedStates.includes(batch.state)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("O lote simulado não chegou ao estado esperado.");
}

async function waitForJob(baseUrl, id, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${id}`);
    const job = await response.json();
    if (["ready", "error", "cancelled"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("O download simulado não chegou ao estado terminal.");
}

async function waitForExit(child, timeoutMs = 7_000) {
  if (child.exitCode != null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Servidor não encerrou os subprocessos a tempo."));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function startPartialPost(port, pathname, body, splitAt = 12) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        connection: "close",
      },
    }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode));
    });
    request.once("error", reject);
    request.write(body.slice(0, splitAt));
  });
  return {
    response,
    finish: () => request.end(body.slice(splitAt)),
  };
}

test("API em lote expande playlist, produz arquivos, ZIP e cancela com segurança", async (t) => {
  const port = await freePort();
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "fita-integration-"));
  const staleSessionId = randomUUID();
  const staleSessionDir = path.join(runtimeDir, `session-${staleSessionId}`);
  const unrelatedSessionId = randomUUID();
  const unrelatedSessionDir = path.join(runtimeDir, `session-${unrelatedSessionId}`);
  const fakePidLog = path.join(runtimeDir, "fake-pids.log");
  const oldTimestamp = Date.now() - (3 * 60 * 60 * 1000);
  await mkdir(staleSessionDir, { recursive: true });
  await writeFile(path.join(staleSessionDir, ".fita-session.json"), JSON.stringify({
    app: "fita-youtube-local",
    version: 1,
    sessionId: staleSessionId,
    pid: 999_999,
    startedAt: oldTimestamp,
    updatedAt: oldTimestamp,
  }));
  await writeFile(path.join(staleSessionDir, "leftover.mp3"), "temporário");
  await mkdir(unrelatedSessionDir, { recursive: true });
  await writeFile(path.join(unrelatedSessionDir, ".fita-session.json"), JSON.stringify({
    app: "outro-aplicativo",
    version: 1,
    sessionId: unrelatedSessionId,
    updatedAt: oldTimestamp,
  }));
  await writeFile(path.join(unrelatedSessionDir, "preserve.txt"), "não remover");
  await chmod(fakeYtDlp, 0o755);
  await chmod(fakeFfmpeg, 0o755);
  const diagnostics = [];
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RUNTIME_DIR: runtimeDir,
      YT_DLP_PATH: fakeYtDlp,
      FFMPEG_PATH: fakeFfmpeg,
      FITA_FAKE_PID_LOG: fakePidLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => diagnostics.push(chunk.toString()));
  child.stderr.on("data", (chunk) => diagnostics.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else child.once("exit", resolve);
    });
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl, child, diagnostics);
  assert.equal(health.ytDlp, true);
  assert.equal(health.ffmpeg, true);
  assert.deepEqual(health.queue, { active: 0, queued: 0, limit: 4 });
  assert.equal(existsSync(staleSessionDir), false);
  assert.equal(existsSync(unrelatedSessionDir), true);

  const createResponse = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/playlist?list=fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  });
  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  const completed = await waitForBatch(baseUrl, created.id, ["completed"]);
  assert.equal(completed.counts.total, 2);
  assert.equal(completed.counts.ready, 2);
  assert.equal(completed.progress, 100);
  assert.equal(completed.items.every((item) => item.downloadUrl), true);

  const fileResponse = await fetch(`${baseUrl}${completed.items[0].downloadUrl}`);
  assert.equal(fileResponse.status, 200);
  assert.match(await fileResponse.text(), /^audio-fixture:/);

  const archiveResponse = await fetch(`${baseUrl}${completed.archiveUrl}`);
  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.headers.get("content-type"), "application/zip");
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.equal(archive.subarray(0, 2).toString(), "PK");
  assert.equal(archive.includes(Buffer.from("fixture-one")), true);
  assert.equal(archive.includes(Buffer.from("fixture-two")), true);

  const singleResponse = await postJson(`${baseUrl}/api/download`, {
    url: "https://youtube.com/watch?v=single-fixture",
    format: "m4a",
    quality: "128",
  });
  assert.equal(singleResponse.status, 202);
  const singleCreated = await singleResponse.json();
  const singleReady = await waitForJob(baseUrl, singleCreated.id);
  assert.equal(singleReady.state, "ready");
  assert.match(singleReady.filename, /single-fixture.*\.m4a$/);

  const invalidConcurrency = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtu.be/fixture",
    format: "mp3",
    quality: "192",
    concurrency: 5,
  });
  assert.equal(invalidConcurrency.status, 400);

  const blockedOrigin = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtu.be/fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  }, { origin: "https://example.com" });
  assert.equal(blockedOrigin.status, 403);

  const blockedLocalPort = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtu.be/fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  }, { origin: "http://127.0.0.1:9999" });
  assert.equal(blockedLocalPort.status, 403);

  const blockedRebinding = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtu.be/fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  }, {
    host: `dominio-controlado.example:${port}`,
    origin: `http://dominio-controlado.example:${port}`,
  });
  assert.equal(blockedRebinding.status, 403);

  const partialResponse = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/watch?v=ok-fixture\nhttps://youtube.com/watch?v=fail-fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  });
  const partialCreated = await partialResponse.json();
  const partial = await waitForBatch(baseUrl, partialCreated.id, ["completed_with_errors"]);
  assert.equal(partial.counts.ready, 1);
  assert.equal(partial.counts.error, 1);
  const failedItem = partial.items.find((item) => item.state === "error");
  const retryResponses = await Promise.all([
    postJson(`${baseUrl}/api/batches/${partial.id}/items/${failedItem.id}/retry`, {}),
    postJson(`${baseUrl}/api/batches/${partial.id}/items/${failedItem.id}/retry`, {}),
  ]);
  assert.deepEqual(retryResponses.map((response) => response.status).sort(), [202, 409]);
  await waitForBatch(baseUrl, partial.id, ["completed_with_errors"]);

  const slowPlaylistResponse = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/playlist?list=slow-fixture",
    format: "mp3",
    quality: "192",
    concurrency: 1,
  });
  const slowPlaylist = await slowPlaylistResponse.json();
  const cancelResolvingResponse = await postJson(`${baseUrl}/api/batches/${slowPlaylist.id}/cancel`, {});
  assert.equal(cancelResolvingResponse.status, 200);
  const cancelledResolver = await waitForBatch(baseUrl, slowPlaylist.id, ["cancelled"]);
  assert.equal(cancelledResolver.counts.total, 0);

  const slowResponse = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/watch?v=slow-fixture",
    format: "mp3",
    quality: "192",
    concurrency: 1,
  });
  const slowBatch = await slowResponse.json();
  await waitForBatch(baseUrl, slowBatch.id, ["running", "queued"]);
  const cancelResponse = await postJson(`${baseUrl}/api/batches/${slowBatch.id}/cancel`, {});
  assert.equal(cancelResponse.status, 200);
  const cancelled = await waitForBatch(baseUrl, slowBatch.id, ["cancelled"]);
  assert.equal(cancelled.counts.cancelled, 1);

  const retryAfterCancel = await postJson(`${baseUrl}/api/batches/${slowBatch.id}/items/${cancelled.items[0].id}/retry`, {});
  assert.equal(retryAfterCancel.status, 202);
  const resumed = await waitForBatch(baseUrl, slowBatch.id, ["completed"]);
  assert.equal(resumed.items[0].state, "ready");

  const cancellingResponse = await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/watch?v=fail-cancelling-fixture\nhttps://youtube.com/watch?v=cancel-delay-fixture",
    format: "mp3",
    quality: "192",
    concurrency: 2,
  });
  const cancellingBatch = await cancellingResponse.json();
  let cancellingSnapshot;
  const cancellingDeadline = Date.now() + 3_000;
  while (Date.now() < cancellingDeadline) {
    cancellingSnapshot = await (await fetch(`${baseUrl}/api/batches/${cancellingBatch.id}`)).json();
    if (cancellingSnapshot.counts.error === 1 && cancellingSnapshot.counts.running === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const cancellingFailedItem = cancellingSnapshot.items.find((item) => item.state === "error");
  assert.ok(cancellingFailedItem);
  await postJson(`${baseUrl}/api/batches/${cancellingBatch.id}/cancel`, {});
  const retryWhileCancelling = await postJson(
    `${baseUrl}/api/batches/${cancellingBatch.id}/items/${cancellingFailedItem.id}/retry`,
    {},
  );
  assert.equal(retryWhileCancelling.status, 409);
  await waitForBatch(baseUrl, cancellingBatch.id, ["cancelled"]);

  const pidCountBeforeShutdown = existsSync(fakePidLog)
    ? (await readFile(fakePidLog, "utf8")).trim().split("\n").filter(Boolean).length
    : 0;
  await postJson(`${baseUrl}/api/batches`, {
    sources: "https://youtube.com/playlist?list=very-slow-fixture",
    format: "mp3",
    quality: "192",
    concurrency: 1,
  });
  await postJson(`${baseUrl}/api/download`, {
    url: "https://youtube.com/watch?v=very-slow-fixture",
    format: "mp3",
    quality: "192",
  });
  const pidDeadline = Date.now() + 2_000;
  let shutdownPids = [];
  while (Date.now() < pidDeadline) {
    const allPids = (await readFile(fakePidLog, "utf8")).trim().split("\n").filter(Boolean).map(Number);
    shutdownPids = allPids.slice(pidCountBeforeShutdown);
    if (shutdownPids.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(shutdownPids.length >= 2, true);
  const pidCountAtShutdown = pidCountBeforeShutdown + shutdownPids.length;
  const lateBody = JSON.stringify({
    url: "https://youtube.com/watch?v=very-slow-late-fixture",
    format: "mp3",
    quality: "192",
  });
  const lateRequest = startPartialPost(port, "/api/download", lateBody);
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.kill("SIGTERM");
  lateRequest.finish();
  assert.equal(await lateRequest.response, 503);
  await waitForExit(child);
  const finalPidCount = (await readFile(fakePidLog, "utf8")).trim().split("\n").filter(Boolean).length;
  assert.equal(finalPidCount, pidCountAtShutdown);
  for (const pid of shutdownPids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});
