import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  MAX_BATCH_ITEMS,
  formatDuration,
  isPlaylistUrl,
  normalizeBatchSources,
  normalizeYoutubeUrl,
  parseProgressLine,
  publicJob,
  safeDownloadName,
  validateConcurrency,
  validateDownloadOptions,
  youtubeIdentity,
} from "./lib.js";
import { DownloadScheduler } from "./scheduler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const builtPublicDir = path.join(root, "dist");
const publicDir = existsSync(path.join(builtPublicDir, "index.html")) ? builtPublicDir : path.join(root, "public");
const runtimeRoot = process.env.RUNTIME_DIR ? path.resolve(process.env.RUNTIME_DIR) : path.join(root, ".runtime");
const sessionId = randomUUID();
const runtimeDir = path.join(runtimeRoot, `session-${sessionId}`);
const sessionMarkerPath = path.join(runtimeDir, ".fita-session.json");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const jobs = new Map();
const batches = new Map();
const videoCache = new Map();
const managedChildren = new Set();
const childStopTimers = new WeakMap();
let shuttingDown = false;
const TERMINAL_JOB_STATES = new Set(["ready", "error", "cancelled"]);
const TERMINAL_BATCH_STATES = new Set(["completed", "completed_with_errors", "error", "cancelled"]);
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const VIDEO_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PLAYLIST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ACTIVE_BATCHES = 4;
const MAX_PENDING_JOBS = 200;
const ZIP_PATH = process.env.ZIP_PATH || "/usr/bin/zip";
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status === 0;
let sessionMarker = {
  app: "fita-youtube-local",
  version: 1,
  sessionId,
  pid: process.pid,
  startedAt: Date.now(),
  updatedAt: Date.now(),
};

function ytDlpPath() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  return path.join(root, ".tools", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("A solicitação é grande demais.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Não foi possível entender a solicitação.");
  }
}

function isTrustedRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const requestHost = new URL(`http://${req.headers.host || "invalid"}`);
    const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (!allowedHosts.has(requestHost.hostname.toLowerCase())) return false;
    if ((requestHost.port || "80") !== String(port)) return false;
    const originUrl = new URL(origin);
    return originUrl.origin === requestHost.origin;
  } catch {
    return false;
  }
}

class AsyncSemaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire(key) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ key, resolve, reject });
      this.pump();
    });
  }

  cancel(key) {
    const cancelled = this.waiters.filter((entry) => entry.key === key);
    this.waiters = this.waiters.filter((entry) => entry.key !== key);
    for (const entry of cancelled) entry.reject(new Error("Lote cancelado."));
  }

  pump() {
    while (this.active < this.limit && this.waiters.length) {
      const entry = this.waiters.shift();
      this.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      });
    }
  }
}

const playlistSemaphore = new AsyncSemaphore(2);

function childIsRunning(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

function trackChild(child) {
  managedChildren.add(child);
  const forget = () => managedChildren.delete(child);
  child.once("close", forget);
  child.once("error", forget);
  return child;
}

function signalChild(child, signal) {
  if (!childIsRunning(child)) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* O processo já terminou. */ }
  }
}

function stopChild(child) {
  if (!childIsRunning(child)) return null;
  signalChild(child, "SIGTERM");
  const existingTimer = childStopTimers.get(child);
  if (existingTimer) return existingTimer;
  const timer = setTimeout(() => {
    childStopTimers.delete(child);
    if (childIsRunning(child)) signalChild(child, "SIGKILL");
  }, 4_000);
  const clear = () => {
    clearTimeout(timer);
    childStopTimers.delete(child);
  };
  child.once("close", clear);
  child.once("error", clear);
  childStopTimers.set(child, timer);
  timer.unref();
  return timer;
}

function run(command, args, {
  timeoutMs = 90_000,
  maxOutputBytes = 8 * 1024 * 1024,
  onChild = () => {},
  onFinish = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error("O FITA está encerrando. Abra o aplicativo novamente para continuar."));
      return;
    }
    const child = trackChild(spawn(command, args, {
      cwd: root,
      env: process.env,
      detached: process.platform !== "win32",
    }));
    onChild(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forcedError = null;
    let forceTimer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      onFinish(child);
      callback();
    };
    const requestStop = (error) => {
      if (forcedError) return;
      forcedError = error;
      forceTimer = stopChild(child);
    };
    const timer = setTimeout(() => {
      requestStop(new Error("O YouTube demorou demais para responder. Tente novamente."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutputBytes) {
        requestStop(new Error("A resposta recebida foi grande demais."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (forcedError) reject(forcedError);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cleanToolError(stderr || stdout)));
    }));
  });
}

function cleanToolError(value) {
  const text = String(value || "").replace(/^ERROR:\s*/gim, "").trim();
  const last = text.split("\n").filter(Boolean).at(-1);
  if (/sign in|login|cookies/i.test(text)) {
    return "O YouTube pediu autenticação para esse conteúdo. Tente outro vídeo público.";
  }
  if (/private video/i.test(text)) return "Esse vídeo é privado e não pode ser acessado.";
  if (/video unavailable|not available/i.test(text)) return "Esse vídeo não está disponível.";
  return last || "Não foi possível processar esse vídeo.";
}

async function inspectVideo(url) {
  const cached = videoCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const binary = ytDlpPath();
  if (!existsSync(binary)) {
    throw new Error("O yt-dlp ainda não foi instalado. Execute npm run setup no Terminal.");
  }
  const { stdout } = await run(binary, [
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--",
    url,
  ]);
  const data = JSON.parse(stdout);
  const value = {
    id: data.id,
    title: data.title || "Sem título",
    channel: data.channel || data.uploader || "Canal não informado",
    duration: formatDuration(data.duration),
    thumbnail: typeof data.thumbnail === "string" ? data.thumbnail : null,
    webpageUrl: data.webpage_url || url,
  };
  videoCache.set(url, { value, expiresAt: Date.now() + VIDEO_CACHE_TTL_MS });
  return value;
}

function createJob({ url, format, quality, title, batch = null }) {
  const id = randomUUID();
  const dir = batch ? path.join(batch.dir, id) : path.join(runtimeDir, id);
  const job = {
    id,
    batchId: batch?.id || null,
    batchConcurrency: batch?.concurrency || null,
    url,
    format,
    quality,
    title: title || "Aguardando título…",
    dir,
    state: "queued",
    progress: 0,
    speed: null,
    eta: null,
    error: null,
    filePath: null,
    child: null,
    cancelRequested: false,
    activeReaders: 0,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  if (batch) batch.jobIds.push(id);
  return job;
}

function terminateJob(job) {
  if (!job.child) return;
  const child = job.child;
  stopChild(child);
}

function handleToolLine(job, line) {
  const clean = line.trim();
  if (!clean) return;
  if (clean.startsWith("__FITA_TITLE__:")) {
    job.title = clean.slice("__FITA_TITLE__:".length).trim() || job.title;
    return;
  }
  if (clean.startsWith("__FITA_FILE__:")) {
    const candidate = path.resolve(clean.slice("__FITA_FILE__:".length).trim());
    if (candidate.startsWith(`${job.dir}${path.sep}`)) job.filePath = candidate;
    return;
  }
  const progress = parseProgressLine(clean);
  if (progress) {
    job.progress = progress.percent;
    job.speed = progress.speed;
    job.eta = progress.eta;
  }
}

async function runDownloadJob(job) {
  if (job.cancelRequested || shuttingDown) {
    job.cancelRequested = true;
    job.state = "cancelled";
    job.finishedAt = Date.now();
    return;
  }

  await mkdir(job.dir, { recursive: true });
  if (job.cancelRequested || shuttingDown) {
    job.cancelRequested = true;
    job.state = "cancelled";
    job.finishedAt = Date.now();
    await rm(job.dir, { recursive: true, force: true });
    return;
  }
  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--progress",
    "--windows-filenames",
    "--concurrent-fragments",
    "4",
    "--extract-audio",
    "--audio-format",
    job.format,
    "--audio-quality",
    `${job.quality}K`,
    "--embed-metadata",
    "--print",
    "before_dl:__FITA_TITLE__:%(title)s",
    "--print",
    "after_move:__FITA_FILE__:%(filepath)s",
    "--progress-template",
    "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--output",
    path.join(job.dir, "%(title).120B [%(id)s].%(ext)s"),
    "--",
    job.url,
  ];

  let errorOutput = "";
  let timedOut = false;
  try {
    const child = trackChild(spawn(ytDlpPath(), args, {
      cwd: root,
      env: process.env,
      detached: process.platform !== "win32",
    }));
    job.child = child;
    job.state = "downloading";
    const buffers = { stdout: "", stderr: "" };

    const consume = (stream, chunk) => {
      const text = chunk.toString();
      if (stream === "stderr") errorOutput = (errorOutput + text).slice(-64 * 1024);
      buffers[stream] += text;
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() || "";
      for (const line of lines) handleToolLine(job, line);
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));

    const code = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminateJob(job);
      }, DOWNLOAD_TIMEOUT_MS);
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (exitCode) => finish(() => resolve(exitCode)));
    });
    handleToolLine(job, buffers.stdout);
    handleToolLine(job, buffers.stderr);
    job.child = null;

    if (job.cancelRequested) {
      job.state = "cancelled";
      await rm(job.dir, { recursive: true, force: true });
      return;
    }
    if (timedOut) throw new Error("O download excedeu duas horas e foi encerrado.");
    if (code !== 0) throw new Error(cleanToolError(errorOutput));

    if (!job.filePath || !existsSync(job.filePath)) {
      const files = await readdir(job.dir);
      if (job.cancelRequested) {
        job.state = "cancelled";
        await rm(job.dir, { recursive: true, force: true });
        return;
      }
      const audioFile = files.find((file) => file.toLowerCase().endsWith(`.${job.format}`));
      if (!audioFile) throw new Error("Arquivo convertido não encontrado.");
      job.filePath = path.join(job.dir, audioFile);
    }
    if (job.cancelRequested) {
      job.state = "cancelled";
      await rm(job.dir, { recursive: true, force: true });
      return;
    }
    job.progress = 100;
    job.speed = null;
    job.eta = null;
    job.state = "ready";
  } catch (error) {
    job.child = null;
    if (job.cancelRequested) {
      job.state = "cancelled";
      await rm(job.dir, { recursive: true, force: true });
    } else {
      job.state = "error";
      job.error = error?.code === "ENOENT"
        ? "O yt-dlp não foi encontrado. Execute npm run setup."
        : error.message || "Não foi possível concluir o download.";
    }
  } finally {
    if (TERMINAL_JOB_STATES.has(job.state)) job.finishedAt = Date.now();
  }
}

const scheduler = new DownloadScheduler({
  maxActive: 4,
  runner: runDownloadJob,
  onChange: (job) => {
    if (job.batchId) refreshBatch(batches.get(job.batchId));
  },
});

function pendingJobCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (!TERMINAL_JOB_STATES.has(job.state)) count += 1;
  }
  return count;
}

function activeBatchCount() {
  let count = 0;
  for (const batch of batches.values()) {
    refreshBatch(batch);
    if (!TERMINAL_BATCH_STATES.has(batch.state)) count += 1;
  }
  return count;
}

async function expandPlaylist(url, batch) {
  const release = await playlistSemaphore.acquire(batch.id);
  try {
    if (batch.cancelRequested) throw new Error("Lote cancelado.");
    const { stdout } = await run(ytDlpPath(), [
      "--flat-playlist",
      "--dump-single-json",
      "--skip-download",
      "--playlist-end",
      String(MAX_BATCH_ITEMS),
      "--yes-playlist",
      "--no-warnings",
      "--",
      url,
    ], {
      timeoutMs: PLAYLIST_TIMEOUT_MS,
      onChild: (child) => batch.resolverChildren.add(child),
      onFinish: (child) => batch.resolverChildren.delete(child),
    });
    const data = JSON.parse(stdout);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return entries.flatMap((entry) => {
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (!id) return [];
      return [{
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        title: entry.title || "Faixa da playlist",
      }];
    });
  } finally {
    release();
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function resolveBatchSources(batch, sources) {
  const resolved = await mapWithConcurrency(sources, 2, async (source) => {
    if (batch.cancelRequested) return [];
    if (!isPlaylistUrl(source)) {
      const cached = videoCache.get(source);
      return [{ url: source, title: cached?.value?.title || "Faixa do YouTube" }];
    }
    try {
      const entries = await expandPlaylist(source, batch);
      if (!entries.length) throw new Error("A playlist não contém vídeos públicos disponíveis.");
      return entries;
    } catch (error) {
      if (!batch.cancelRequested) {
        batch.sourceErrors.push({ source, message: cleanToolError(error.message) });
      }
      return [];
    }
  });

  if (batch.cancelRequested) {
    batch.resolving = false;
    refreshBatch(batch);
    return;
  }

  const seen = new Set();
  for (const entries of resolved) {
    for (const entry of entries) {
      const key = youtubeIdentity(entry.url);
      if (seen.has(key)) continue;
      if (seen.size >= MAX_BATCH_ITEMS || pendingJobCount() >= MAX_PENDING_JOBS) {
        batch.truncated = true;
        break;
      }
      seen.add(key);
      createJob({
        url: entry.url,
        format: batch.format,
        quality: batch.quality,
        title: entry.title,
        batch,
      });
    }
    if (seen.size >= MAX_BATCH_ITEMS) break;
  }

  batch.resolving = false;
  if (!batch.jobIds.length) {
    batch.error = batch.sourceErrors[0]?.message || "Nenhuma faixa pública foi encontrada.";
    refreshBatch(batch);
    return;
  }
  for (const id of batch.jobIds) scheduler.enqueue(jobs.get(id));
  refreshBatch(batch);
}

function createBatch(sources, format, quality, concurrency) {
  const id = randomUUID();
  const batch = {
    id,
    dir: path.join(runtimeDir, id),
    format,
    quality,
    concurrency,
    state: "resolving",
    resolving: true,
    cancelRequested: false,
    truncated: false,
    error: null,
    sourceErrors: [],
    jobIds: [],
    archivePath: null,
    archivePromise: null,
    resolverChildren: new Set(),
    activeReaders: 0,
    createdAt: Date.now(),
    finishedAt: null,
  };
  batches.set(id, batch);
  resolveBatchSources(batch, sources).catch((error) => {
    batch.resolving = false;
    batch.error = cleanToolError(error.message);
    refreshBatch(batch);
  });
  return batch;
}

function batchCounts(batch) {
  const counts = { total: batch.jobIds.length, queued: 0, running: 0, ready: 0, error: 0, cancelled: 0 };
  for (const id of batch.jobIds) {
    const state = jobs.get(id)?.state;
    if (state === "queued") counts.queued += 1;
    else if (["starting", "downloading", "cancelling", "retrying"].includes(state)) counts.running += 1;
    else if (state === "ready") counts.ready += 1;
    else if (state === "error") counts.error += 1;
    else if (state === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

function refreshBatch(batch) {
  if (!batch) return;
  const counts = batchCounts(batch);
  if (batch.resolving) batch.state = batch.cancelRequested ? "cancelling" : "resolving";
  else if (counts.running) batch.state = batch.cancelRequested ? "cancelling" : "running";
  else if (counts.queued) batch.state = "queued";
  else if (!counts.total) batch.state = batch.cancelRequested ? "cancelled" : "error";
  else if (batch.cancelRequested && !counts.ready) batch.state = "cancelled";
  else if (counts.ready === counts.total && !batch.sourceErrors.length) batch.state = "completed";
  else if (counts.ready) batch.state = "completed_with_errors";
  else if (counts.cancelled === counts.total) batch.state = "cancelled";
  else batch.state = "error";

  if (TERMINAL_BATCH_STATES.has(batch.state)) batch.finishedAt ||= Date.now();
  else batch.finishedAt = null;
}

function publicBatch(batch) {
  refreshBatch(batch);
  const counts = batchCounts(batch);
  const items = batch.jobIds.map((id) => publicJob(jobs.get(id)));
  const completedProgress = items.reduce((sum, item) => {
    if (item.state === "ready") return sum + 100;
    return sum + (Number(item.progress) || 0);
  }, 0);
  const progress = counts.total ? Math.round((completedProgress / counts.total) * 10) / 10 : 0;
  return {
    id: batch.id,
    state: batch.state,
    progress,
    counts,
    items,
    error: batch.error,
    sourceErrors: batch.sourceErrors,
    truncated: batch.truncated,
    concurrency: batch.concurrency,
    statusUrl: `/api/batches/${batch.id}`,
    archiveUrl: TERMINAL_BATCH_STATES.has(batch.state) && counts.ready && existsSync(ZIP_PATH)
      ? `/api/batches/${batch.id}/archive`
      : null,
  };
}

function cancelBatch(batch) {
  batch.cancelRequested = true;
  playlistSemaphore.cancel(batch.id);
  for (const child of batch.resolverChildren) stopChild(child);
  for (const id of batch.jobIds) {
    const job = jobs.get(id);
    if (!job || TERMINAL_JOB_STATES.has(job.state)) continue;
    job.cancelRequested = true;
    if (scheduler.cancelQueued(job.id)) {
      job.state = "cancelled";
      job.finishedAt = Date.now();
    } else {
      job.state = "cancelling";
      terminateJob(job);
    }
  }
  refreshBatch(batch);
}

async function retryJob(batch, job) {
  if (shuttingDown) {
    throw new Error("O FITA está encerrando. Abra o aplicativo novamente para continuar.");
  }
  refreshBatch(batch);
  if (batch.resolving || (batch.cancelRequested && !TERMINAL_BATCH_STATES.has(batch.state))) {
    throw new Error("Aguarde o cancelamento do lote terminar antes de tentar novamente.");
  }
  if (!TERMINAL_JOB_STATES.has(job.state) || job.state === "ready") {
    throw new Error("Somente faixas com erro ou canceladas podem ser tentadas novamente.");
  }
  if (batch.archivePromise || batch.activeReaders) {
    throw new Error("Aguarde o download do ZIP terminar antes de tentar novamente.");
  }
  const previousState = job.state;
  job.state = "retrying";
  batch.cancelRequested = false;
  batch.finishedAt = null;
  job.cancelRequested = false;
  try {
    await rm(job.dir, { recursive: true, force: true });
    if (batch.cancelRequested || job.cancelRequested || shuttingDown) {
      job.state = "cancelled";
      job.cancelRequested = true;
      job.finishedAt = Date.now();
      refreshBatch(batch);
      return;
    }
    if (batch.archivePath) await rm(batch.archivePath, { force: true });
    if (batch.cancelRequested || job.cancelRequested || shuttingDown) {
      job.state = "cancelled";
      job.cancelRequested = true;
      job.finishedAt = Date.now();
      refreshBatch(batch);
      return;
    }
    batch.archivePath = null;
    job.progress = 0;
    job.speed = null;
    job.eta = null;
    job.error = null;
    job.filePath = null;
    job.startedAt = null;
    job.finishedAt = null;
    scheduler.enqueue(job);
  } catch (error) {
    job.state = previousState;
    throw error;
  }
}

async function ensureBatchArchive(batch) {
  refreshBatch(batch);
  if (!TERMINAL_BATCH_STATES.has(batch.state)) {
    throw new Error("Aguarde o lote terminar antes de baixar o ZIP.");
  }
  const files = batch.jobIds.map((id) => jobs.get(id)).filter((job) => job?.state === "ready" && job.filePath && existsSync(job.filePath));
  if (!files.length) throw new Error("Esse lote não possui arquivos prontos.");
  if (!existsSync(ZIP_PATH)) throw new Error("O utilitário ZIP não está disponível neste Mac.");
  if (batch.archivePath && existsSync(batch.archivePath)) return batch.archivePath;
  if (batch.archivePromise) return batch.archivePromise;

  batch.archivePromise = (async () => {
    await mkdir(batch.dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(batch.dir, `FITA-lote-${stamp}.zip`);
    await rm(archivePath, { force: true });
    await run(ZIP_PATH, ["-j", "-0", "-q", archivePath, ...files.map((job) => job.filePath)], {
      timeoutMs: 5 * 60 * 1000,
      maxOutputBytes: 512 * 1024,
    });
    batch.archivePath = archivePath;
    return archivePath;
  })().finally(() => {
    batch.archivePromise = null;
  });
  return batch.archivePromise;
}

async function streamDownload(res, filePath, owner) {
  owner.activeReaders = (owner.activeReaders || 0) + 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    owner.activeReaders = Math.max(0, (owner.activeReaders || 1) - 1);
  };
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    release();
    throw error;
  }
  const filename = safeDownloadName(filePath);
  res.writeHead(200, {
    "content-type": path.extname(filePath).toLowerCase() === ".zip" ? "application/zip" : "application/octet-stream",
    "content-length": info.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const stream = createReadStream(filePath);
  stream.once("close", release);
  stream.once("error", (error) => {
    release();
    res.destroy(error);
  });
  res.once("close", () => {
    if (!res.writableEnded) stream.destroy();
    release();
  });
  stream.pipe(res);
}

async function serveStatic(reqPath, res) {
  const requested = reqPath === "/" ? "index.html" : reqPath.slice(1);
  const safePath = path.resolve(publicDir, requested);
  if (!safePath.startsWith(`${publicDir}${path.sep}`) && safePath !== publicDir) {
    sendError(res, 403, "Acesso negado.");
    return;
  }
  try {
    const body = await readFile(safePath);
    const ext = path.extname(safePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
  } catch {
    sendError(res, 404, "Página não encontrada.");
  }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (pathname.startsWith("/api/") && req.method === "POST") {
    if (!isTrustedRequest(req)) {
      sendError(res, 403, "Solicitação externa bloqueada.");
      return;
    }
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      sendError(res, 415, "Envie os dados em JSON.");
      return;
    }
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      ytDlp: existsSync(ytDlpPath()),
      ffmpeg: hasFfmpeg,
      zip: existsSync(ZIP_PATH),
      localOnly: host === "127.0.0.1" || host === "localhost",
      sessionId,
      queue: scheduler.stats(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/inspect") {
    try {
      const body = await readJson(req);
      const url = normalizeYoutubeUrl(body.url);
      sendJson(res, 200, await inspectVideo(url));
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/download") {
    try {
      if (!existsSync(ytDlpPath())) {
        sendError(res, 503, "O yt-dlp ainda não foi instalado. Execute npm run setup.");
        return;
      }
      if (!hasFfmpeg) {
        sendError(res, 503, "O ffmpeg não foi encontrado. Instale-o antes de baixar.");
        return;
      }
      const body = await readJson(req);
      if (shuttingDown) {
        sendError(res, 503, "O FITA está encerrando. Abra o aplicativo novamente para continuar.");
        return;
      }
      const url = normalizeYoutubeUrl(body.url);
      const { format, quality } = validateDownloadOptions(body.format, body.quality);
      if (pendingJobCount() >= MAX_PENDING_JOBS) {
        throw new Error("A fila local atingiu o limite de 200 faixas. Aguarde alguns downloads terminarem.");
      }
      const cached = videoCache.get(url);
      const job = createJob({ url, format, quality, title: cached?.value?.title });
      scheduler.enqueue(job);
      sendJson(res, 202, publicJob(job));
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/batches") {
    try {
      if (!existsSync(ytDlpPath())) {
        sendError(res, 503, "O yt-dlp ainda não foi instalado. Execute npm run setup.");
        return;
      }
      if (!hasFfmpeg) {
        sendError(res, 503, "O ffmpeg não foi encontrado. Instale-o antes de baixar.");
        return;
      }
      const body = await readJson(req);
      if (shuttingDown) {
        sendError(res, 503, "O FITA está encerrando. Abra o aplicativo novamente para continuar.");
        return;
      }
      const sources = normalizeBatchSources(body.sources ?? body.urls);
      const { format, quality } = validateDownloadOptions(body.format, body.quality);
      const concurrency = validateConcurrency(body.concurrency);
      if (activeBatchCount() >= MAX_ACTIVE_BATCHES) {
        throw new Error("Já existem quatro lotes ativos. Aguarde um deles terminar.");
      }
      if (pendingJobCount() + MAX_BATCH_ITEMS > MAX_PENDING_JOBS) {
        throw new Error("Não há espaço para outro lote completo na fila local. Aguarde alguns downloads terminarem.");
      }
      const batch = createBatch(sources, format, quality, concurrency);
      sendJson(res, 202, publicBatch(batch));
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  const batchMatch = pathname.match(/^\/api\/batches\/([a-f0-9-]+)(?:\/(archive|cancel))?$/);
  if (batchMatch) {
    const batch = batches.get(batchMatch[1]);
    if (!batch) {
      sendError(res, 404, "Esse lote expirou ou não existe.");
      return;
    }
    if (req.method === "GET" && !batchMatch[2]) {
      sendJson(res, 200, publicBatch(batch));
      return;
    }
    if (req.method === "POST" && batchMatch[2] === "cancel") {
      await readJson(req);
      cancelBatch(batch);
      sendJson(res, 200, publicBatch(batch));
      return;
    }
    if (req.method === "GET" && batchMatch[2] === "archive") {
      try {
        const archivePath = await ensureBatchArchive(batch);
        await streamDownload(res, archivePath, batch);
      } catch (error) {
        sendError(res, 409, error.message);
      }
      return;
    }
  }

  const retryMatch = pathname.match(/^\/api\/batches\/([a-f0-9-]+)\/items\/([a-f0-9-]+)\/retry$/);
  if (req.method === "POST" && retryMatch) {
    const batch = batches.get(retryMatch[1]);
    const job = jobs.get(retryMatch[2]);
    if (!batch || !job || job.batchId !== batch.id) {
      sendError(res, 404, "Essa faixa ou lote não existe mais.");
      return;
    }
    try {
      await readJson(req);
      if (shuttingDown) {
        sendError(res, 503, "O FITA está encerrando. Abra o aplicativo novamente para continuar.");
        return;
      }
      await retryJob(batch, job);
      sendJson(res, 202, publicBatch(batch));
    } catch (error) {
      sendError(res, 409, error.message);
    }
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(\/file)?$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendError(res, 404, "Esse download expirou ou não existe.");
      return;
    }
    if (!jobMatch[2]) {
      sendJson(res, 200, publicJob(job));
      return;
    }
    if (job.state !== "ready" || !job.filePath || !existsSync(job.filePath)) {
      sendError(res, 409, "O arquivo ainda não está pronto.");
      return;
    }
    await streamDownload(res, job.filePath, job);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(pathname, res);
    return;
  }
  sendError(res, 405, "Método não permitido.");
}

let cleanupRunning = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writeSessionMarker(extra = {}) {
  sessionMarker = { ...sessionMarker, ...extra, updatedAt: Date.now() };
  await writeFile(sessionMarkerPath, `${JSON.stringify(sessionMarker)}\n`, "utf8");
}

async function cleanupStaleSessions() {
  await mkdir(runtimeRoot, { recursive: true });
  const entries = await readdir(runtimeRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^session-([0-9a-f-]{36})$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const candidate = path.join(runtimeRoot, entry.name);
    if (candidate === runtimeDir) continue;
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const marker = JSON.parse(await readFile(path.join(candidate, ".fita-session.json"), "utf8"));
      if (marker.app !== "fita-youtube-local" || marker.version !== 1 || marker.sessionId !== match[1]) continue;
      const lastSeen = Number(marker.stoppedAt || marker.updatedAt || marker.startedAt);
      if (!Number.isFinite(lastSeen) || Date.now() - lastSeen < JOB_TTL_MS) continue;
      if (!marker.stoppedAt && isProcessAlive(Number(marker.pid))) continue;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Diretórios sem um marker FITA válido nunca são removidos automaticamente.
    }
  }
}

async function cleanupExpiredJobs() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, batch] of batches) {
      refreshBatch(batch);
      const hasReaders = batch.activeReaders || batch.archivePromise || batch.jobIds.some((jobId) => jobs.get(jobId)?.activeReaders);
      if (TERMINAL_BATCH_STATES.has(batch.state) && batch.finishedAt < cutoff && !hasReaders) {
        batches.delete(id);
        for (const jobId of batch.jobIds) jobs.delete(jobId);
        await rm(batch.dir, { recursive: true, force: true });
      }
    }
    for (const [id, job] of jobs) {
      if (!job.batchId && TERMINAL_JOB_STATES.has(job.state) && job.finishedAt < cutoff && !job.activeReaders) {
        jobs.delete(id);
        await rm(job.dir, { recursive: true, force: true });
      }
    }
    for (const [url, cached] of videoCache) {
      if (cached.expiresAt <= Date.now()) videoCache.delete(url);
    }
    await writeSessionMarker();
    await cleanupStaleSessions();
  } finally {
    cleanupRunning = false;
  }
}

await mkdir(runtimeRoot, { recursive: true });
await cleanupStaleSessions();
await mkdir(runtimeDir, { recursive: true });
await writeSessionMarker();
setInterval(() => {
  cleanupExpiredJobs().catch((error) => console.error("Falha ao limpar arquivos temporários:", error));
}, 5 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, "Ocorreu um erro interno.");
    else res.destroy();
  });
});

function waitForChild(child) {
  if (!childIsRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", finish);
    child.once("error", finish);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopManagedChildren() {
  const children = [...managedChildren].filter(childIsRunning);
  for (const child of children) stopChild(child);
  if (!children.length) return;
  await Promise.race([Promise.all(children.map(waitForChild)), delay(4_500)]);
  const remaining = [...managedChildren].filter(childIsRunning);
  for (const child of remaining) signalChild(child, "SIGKILL");
  if (remaining.length) {
    await Promise.race([Promise.all(remaining.map(waitForChild)), delay(1_000)]);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const batch of batches.values()) cancelBatch(batch);
  for (const job of jobs.values()) {
    if (job.batchId || TERMINAL_JOB_STATES.has(job.state)) continue;
    job.cancelRequested = true;
    if (scheduler.cancelQueued(job.id)) {
      job.state = "cancelled";
      job.finishedAt = Date.now();
    } else {
      job.state = "cancelling";
      terminateJob(job);
    }
  }
  const serverClosed = new Promise((resolve) => server.close(resolve));
  await Promise.all([
    stopManagedChildren(),
    Promise.race([serverClosed, delay(5_000)]),
  ]);
  server.closeAllConnections?.();
  await writeSessionMarker({ stoppedAt: Date.now() }).catch(() => {});
  process.exit(0);
}
process.once("SIGINT", () => { shutdown().catch((error) => { console.error(error); process.exit(1); }); });
process.once("SIGTERM", () => { shutdown().catch((error) => { console.error(error); process.exit(1); }); });

server.listen(port, host, () => {
  console.log(`\nFITA está rodando em http://${host}:${port}`);
  console.log("Fila rápida: até 4 downloads simultâneos · 4 fragmentos por faixa");
  console.log("Pressione Ctrl+C para encerrar.\n");
});
