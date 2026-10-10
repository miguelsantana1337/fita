import test from "node:test";
import assert from "node:assert/strict";
import { DownloadScheduler } from "../src/scheduler.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("respeita a concorrência global e inicia o próximo ao liberar uma vaga", async () => {
  const gates = new Map();
  let running = 0;
  let peak = 0;
  const starts = [];
  const scheduler = new DownloadScheduler({
    maxActive: 3,
    runner: async (job) => {
      running += 1;
      peak = Math.max(peak, running);
      starts.push(job.id);
      job.state = "downloading";
      await gates.get(job.id).promise;
      job.state = "ready";
      running -= 1;
    },
  });
  const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `job-${index}`, state: "new" }));
  for (const job of jobs) {
    gates.set(job.id, deferred());
    scheduler.enqueue(job);
  }

  await nextTurn();
  assert.deepEqual(starts, ["job-0", "job-1", "job-2"]);
  assert.deepEqual(scheduler.stats(), { active: 3, queued: 5, limit: 3 });
  gates.get("job-0").resolve();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(starts, ["job-0", "job-1", "job-2", "job-3"]);
  assert.equal(peak, 3);

  for (const gate of gates.values()) gate.resolve();
  await nextTurn();
  await nextTurn();
});

test("aplica o limite por lote sem bloquear outros lotes", async () => {
  const gates = new Map();
  const starts = [];
  const scheduler = new DownloadScheduler({
    maxActive: 4,
    runner: async (job) => {
      starts.push(job.id);
      await gates.get(job.id).promise;
      job.state = "ready";
    },
  });
  const jobs = [
    { id: "a-1", batchId: "a", batchConcurrency: 2 },
    { id: "a-2", batchId: "a", batchConcurrency: 2 },
    { id: "a-3", batchId: "a", batchConcurrency: 2 },
    { id: "b-1", batchId: "b", batchConcurrency: 1 },
    { id: "b-2", batchId: "b", batchConcurrency: 1 },
  ];
  for (const job of jobs) {
    gates.set(job.id, deferred());
    scheduler.enqueue(job);
  }
  await nextTurn();

  assert.deepEqual(starts, ["a-1", "a-2", "b-1"]);
  assert.equal(scheduler.stats().active, 3);
  gates.get("a-1").resolve();
  await nextTurn();
  await nextTurn();
  assert.equal(starts.includes("a-3"), true);
  assert.equal(starts.includes("b-2"), false);

  for (const gate of gates.values()) gate.resolve();
  await nextTurn();
  await nextTurn();
});

test("remove um item da fila antes que ele inicie", async () => {
  const gate = deferred();
  const starts = [];
  const scheduler = new DownloadScheduler({
    maxActive: 1,
    runner: async (job) => {
      starts.push(job.id);
      await gate.promise;
      job.state = "ready";
    },
  });
  scheduler.enqueue({ id: "primeiro" });
  scheduler.enqueue({ id: "cancelado" });
  assert.equal(scheduler.cancelQueued("cancelado"), true);
  assert.equal(scheduler.cancelQueued("cancelado"), false);
  gate.resolve();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(starts, ["primeiro"]);
});

test("uma falha libera a vaga e não interrompe a fila", async () => {
  const starts = [];
  const scheduler = new DownloadScheduler({
    maxActive: 1,
    runner: async (job) => {
      starts.push(job.id);
      if (job.id === "falha") throw new Error("erro controlado");
      job.state = "ready";
    },
  });
  const failed = { id: "falha" };
  const next = { id: "seguinte" };
  scheduler.enqueue(failed);
  scheduler.enqueue(next);
  await nextTurn();
  await nextTurn();
  await nextTurn();
  assert.deepEqual(starts, ["falha", "seguinte"]);
  assert.equal(failed.state, "error");
  assert.equal(next.state, "ready");
});

test("dá uma vaga a uma faixa avulsa antes de continuar um lote Turbo", async () => {
  const gates = new Map();
  const starts = [];
  const scheduler = new DownloadScheduler({
    maxActive: 2,
    runner: async (job) => {
      starts.push(job.id);
      await gates.get(job.id).promise;
      job.state = "ready";
    },
  });
  const batchJobs = Array.from({ length: 4 }, (_, index) => ({
    id: `lote-${index}`,
    batchId: "lote",
    batchConcurrency: 2,
  }));
  for (const job of batchJobs) {
    gates.set(job.id, deferred());
    scheduler.enqueue(job);
  }
  const single = { id: "avulsa" };
  gates.set(single.id, deferred());
  scheduler.enqueue(single);
  await nextTurn();
  assert.deepEqual(starts, ["lote-0", "lote-1"]);

  gates.get("lote-0").resolve();
  await nextTurn();
  await nextTurn();
  assert.equal(starts[2], "avulsa");

  for (const gate of gates.values()) gate.resolve();
  await nextTurn();
  await nextTurn();
});
