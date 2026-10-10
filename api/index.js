import { randomUUID } from "node:crypto";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { del, getDownloadUrl, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { Sandbox } from "@vercel/sandbox";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  MAX_BATCH_ITEMS,
  formatDuration,
  normalizeBatchSources,
  normalizeYoutubeUrl,
  validateConcurrency,
  validateDownloadOptions,
  youtubeIdentity,
} from "../src/lib.js";

const requiredEnv = [
  "DATABASE_URL",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_JWKS_URL",
  "SANDBOX_SNAPSHOT_ID",
];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const sql = neon(process.env.DATABASE_URL);
const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL).origin;
const terminalBatchStates = new Set(["completed", "completed_with_errors", "error", "cancelled"]);
const maxBodyBytes = 256 * 1024;
const dailyJobLimit = 100;
const maxUserActiveJobs = 4;
const maxGlobalActiveJobs = 9;

function sendJson(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  for (const [name, value] of Object.entries(extraHeaders || {})) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, extraHeaders) {
  sendJson(res, status, { error: message }, extraHeaders);
}

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, "A solicitação é grande demais.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Não foi possível entender a solicitação.");
  }
}

async function authenticate(req) {
  const header = req.headers.authorization;
  if (!header?.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "Entre na sua conta para continuar.");
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, { issuer });
    if (!payload.sub) throw new Error("missing subject");
    return payload.sub;
  } catch {
    throw new HttpError(401, "Sua sessão expirou. Entre novamente.");
  }
}

function apiPath(req) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "fita.invalid"}`);
  const rewritten = requestUrl.searchParams.get("path");
  if (rewritten !== null) return `/${rewritten}`.replace(/\/{2,}/g, "/");
  return requestUrl.pathname.replace(/^\/api(?:\/index)?/, "") || "/";
}

function cleanToolError(value) {
  const text = String(value || "").replace(/^ERROR:\s*/gim, "").trim();
  if (/sign in|login|cookies/i.test(text)) {
    return "O YouTube bloqueou o endereço de saída do servidor. Configure uma saída residencial dedicada para continuar.";
  }
  if (/private video/i.test(text)) return "Esse vídeo é privado e não pode ser acessado.";
  if (/video unavailable|not available/i.test(text)) return "Esse vídeo não está disponível.";
  if (/larger than max-filesize|does not pass filter/i.test(text)) {
    return "A faixa ultrapassa o limite online de 60 minutos ou 250 MB.";
  }
  return text.split("\n").filter(Boolean).at(-1) || "Não foi possível processar esse vídeo.";
}

function youtubeRuntimeArgs() {
  const args = [
    "--js-runtimes",
    "node:/usr/local/bin/node",
    "--remote-components",
    "ejs:github",
  ];
  if (process.env.YTDLP_PROXY_URL) args.push("--proxy", process.env.YTDLP_PROXY_URL);
  return args;
}

function assertYoutubeAccess() {
  if (!process.env.YTDLP_PROXY_URL) {
    throw new HttpError(
      503,
      "O processamento online aguarda uma saída residencial dedicada. A interface e seus dados estão online, mas os downloads permanecem pausados para evitar falhas e cobranças inúteis.",
      { "retry-after": "3600" },
    );
  }
}

function safeFileName(value, fallback = "FITA-audio.mp3") {
  const base = path.basename(String(value || fallback));
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\x00-\x1f\x7f/\\:"<>|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 180);
}

function contentTypeFor(format) {
  if (format === "mp3") return "audio/mpeg";
  if (format === "m4a") return "audio/mp4";
  if (format === "opus") return "audio/ogg";
  return "application/octet-stream";
}

function publicJob(row) {
  return {
    id: row.id,
    batchId: row.batch_id || null,
    title: row.title || "Faixa do YouTube",
    state: row.state,
    progress: Number(row.progress) || 0,
    speed: row.speed,
    eta: row.eta,
    error: row.error,
    filename: row.filename,
    downloadUrl: row.state === "ready" ? `/api/jobs/${row.id}/file` : null,
  };
}

function summarizeBatch(batch, jobs) {
  const counts = { total: jobs.length, queued: 0, running: 0, ready: 0, error: 0, cancelled: 0 };
  for (const job of jobs) {
    if (job.state === "queued") counts.queued += 1;
    else if (["starting", "downloading"].includes(job.state)) counts.running += 1;
    else if (job.state === "ready") counts.ready += 1;
    else if (job.state === "error") counts.error += 1;
    else if (job.state === "cancelled") counts.cancelled += 1;
  }
  let state = "queued";
  if (!counts.total) state = "error";
  else if (counts.running) state = "running";
  else if (counts.queued) state = "queued";
  else if (counts.ready === counts.total) state = "completed";
  else if (counts.ready) state = "completed_with_errors";
  else if (counts.cancelled === counts.total) state = "cancelled";
  else state = "error";

  const completedProgress = jobs.reduce(
    (sum, job) => sum + (job.state === "ready" ? 100 : Number(job.progress) || 0),
    0,
  );
  const progress = counts.total ? Math.round((completedProgress / counts.total) * 10) / 10 : 0;
  const sourceErrors = Array.isArray(batch.source_errors) ? batch.source_errors : [];
  return {
    id: batch.id,
    state,
    progress,
    counts,
    items: jobs.map(publicJob),
    error: counts.total ? null : "Nenhuma faixa pública foi encontrada.",
    sourceErrors,
    truncated: Boolean(batch.truncated),
    concurrency: batch.concurrency,
    statusUrl: `/api/batches/${batch.id}`,
    archiveUrl: terminalBatchStates.has(state) && counts.ready ? `/api/batches/${batch.id}/archive` : null,
  };
}

async function createSandbox(tags, timeout = 5 * 60 * 1000) {
  return Sandbox.create({
    source: { type: "snapshot", snapshotId: process.env.SANDBOX_SNAPSHOT_ID },
    resources: { vcpus: 2 },
    region: "iad1",
    timeout,
    persistent: false,
    tags,
  });
}

async function runChecked(sandbox, cmd, args, options = {}) {
  const result = await sandbox.runCommand({ cmd, args, ...options });
  if (result.exitCode !== 0) {
    const errorText = `${await result.stderr()}\n${await result.stdout()}`.trim();
    throw new Error(cleanToolError(errorText));
  }
  return result;
}

async function inspectYoutube(url) {
  const normalized = normalizeYoutubeUrl(url);
  const sandbox = await createSandbox({ task: "inspect" }, 2 * 60 * 1000);
  try {
    const result = await runChecked(sandbox, "yt-dlp", [
      ...youtubeRuntimeArgs(),
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--",
      normalized,
    ]);
    const data = JSON.parse(await result.stdout());
    return {
      id: data.id,
      title: data.title || "Sem título",
      channel: data.channel || data.uploader || "Canal não informado",
      duration: formatDuration(data.duration),
      thumbnail: typeof data.thumbnail === "string" ? data.thumbnail : null,
      webpageUrl: data.webpage_url || normalized,
    };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

function resolvedEntry(data) {
  const id = data.id || null;
  let url = data.webpage_url || data.original_url || data.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    if (!id) return null;
    url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }
  try {
    return { url: normalizeYoutubeUrl(url), title: data.title || "Faixa do YouTube" };
  } catch {
    return null;
  }
}

async function resolveBatchSources(sources) {
  const sandbox = await createSandbox({ task: "playlist" }, 3 * 60 * 1000);
  try {
    const result = await runChecked(sandbox, "yt-dlp", [
      ...youtubeRuntimeArgs(),
      "--flat-playlist",
      "--dump-json",
      "--playlist-end",
      String(MAX_BATCH_ITEMS),
      "--no-warnings",
      "--",
      ...sources,
    ]);
    const seen = new Set();
    const entries = [];
    for (const line of (await result.stdout()).split("\n")) {
      if (!line.trim()) continue;
      const entry = resolvedEntry(JSON.parse(line));
      if (!entry) continue;
      const identity = youtubeIdentity(entry.url);
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
      if (entries.length >= MAX_BATCH_ITEMS) break;
    }
    return { entries, truncated: entries.length >= MAX_BATCH_ITEMS };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

async function assertQuota(userId, requestedJobs) {
  const [usage] = await sql.query(
    "SELECT count(*)::int AS count FROM fita_jobs WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
    [userId],
  );
  if ((usage?.count || 0) + requestedJobs > dailyJobLimit) {
    throw new HttpError(429, `Seu limite é de ${dailyJobLimit} faixas a cada 24 horas.`, { "retry-after": "3600" });
  }
}

async function getJob(userId, id) {
  const [job] = await sql.query("SELECT * FROM fita_jobs WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!job) throw new HttpError(404, "Faixa não encontrada.");
  return job;
}

async function getBatch(userId, id) {
  const [batch] = await sql.query("SELECT * FROM fita_batches WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!batch) throw new HttpError(404, "Lote não encontrado.");
  const jobs = await sql.query(
    "SELECT * FROM fita_jobs WHERE batch_id = $1 AND user_id = $2 ORDER BY created_at, id",
    [id, userId],
  );
  return { batch, jobs };
}

async function signedDownloadUrl(pathname) {
  const validUntil = Date.now() + 10 * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: "private",
    validUntil,
  });
  return getDownloadUrl(presignedUrl);
}

async function processJob(userId, id) {
  const [capacity] = await sql.query(
    `SELECT
       count(*) FILTER (WHERE user_id = $1)::int AS user_active,
       count(*)::int AS global_active
     FROM fita_jobs
     WHERE state IN ('starting', 'downloading')`,
    [userId],
  );
  if ((capacity?.user_active || 0) >= maxUserActiveJobs || (capacity?.global_active || 0) >= maxGlobalActiveJobs) {
    throw new HttpError(429, "A fila online está cheia. O FITA tentará novamente em instantes.", { "retry-after": "3" });
  }

  const rows = await sql.query(
    `UPDATE fita_jobs
       SET state = 'starting', progress = 2, error = NULL, attempt = attempt + 1,
           started_at = now(), finished_at = NULL, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND state = 'queued'
     RETURNING *`,
    [id, userId],
  );
  if (!rows.length) return getJob(userId, id);
  const job = rows[0];
  const sandboxName = `fita-${job.id.replaceAll("-", "").slice(0, 18)}-${job.attempt}`;
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      name: sandboxName,
      source: { type: "snapshot", snapshotId: process.env.SANDBOX_SNAPSHOT_ID },
      resources: { vcpus: 2 },
      region: "iad1",
      timeout: 4 * 60 * 1000,
      persistent: false,
      tags: { task: "download", job: job.id.slice(0, 12) },
    });
    await sql.query(
      "UPDATE fita_jobs SET state = 'downloading', progress = 10, sandbox_name = $1, updated_at = now() WHERE id = $2 AND state <> 'cancelled'",
      [sandbox.name, job.id],
    );

    const resultFile = "/vercel/sandbox/result.txt";
    await runChecked(sandbox, "mkdir", ["-p", "/vercel/sandbox/out"]);
    await runChecked(sandbox, "yt-dlp", [
      ...youtubeRuntimeArgs(),
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--concurrent-fragments",
      "4",
      "--match-filter",
      "duration <= 3600",
      "--max-filesize",
      "250M",
      "-x",
      "--audio-format",
      job.format,
      "--audio-quality",
      `${job.quality}K`,
      "--output",
      "/vercel/sandbox/out/%(title).160B [%(id)s].%(ext)s",
      "--print-to-file",
      "after_move:filepath",
      resultFile,
      "--",
      job.url,
    ]);

    const resultPathBuffer = await sandbox.readFileToBuffer({ path: resultFile });
    const resultPath = resultPathBuffer?.toString("utf8").trim().split("\n").at(-1);
    if (!resultPath?.startsWith("/vercel/sandbox/out/")) throw new Error("O arquivo convertido não foi encontrado.");
    const file = await sandbox.readFileToBuffer({ path: resultPath });
    if (!file?.length) throw new Error("O arquivo convertido ficou vazio.");
    const filename = safeFileName(resultPath, `FITA-${job.id}.${job.format}`);
    const blobPath = `users/${userId}/jobs/${job.id}/${Date.now()}-${filename}`;
    const uploaded = await put(blobPath, file, {
      access: "private",
      addRandomSuffix: false,
      contentType: contentTypeFor(job.format),
    });

    const [current] = await sql.query("SELECT state FROM fita_jobs WHERE id = $1 AND user_id = $2", [job.id, userId]);
    if (current?.state === "cancelled") {
      await del(uploaded.url).catch(() => {});
      return getJob(userId, job.id);
    }

    const title = filename.replace(new RegExp(`\\.${job.format}$`, "i"), "").replace(/\s*\[[^\]]+\]$/, "");
    const [ready] = await sql.query(
      `UPDATE fita_jobs
         SET state = 'ready', progress = 100, title = $1, filename = $2,
             blob_path = $3, blob_url = $4, sandbox_name = NULL,
             finished_at = now(), updated_at = now()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [title || job.title, filename, blobPath, uploaded.url, job.id, userId],
    );
    return ready;
  } catch (error) {
    const message = cleanToolError(error.message);
    const [failed] = await sql.query(
      `UPDATE fita_jobs
         SET state = 'error', error = $1, sandbox_name = NULL, finished_at = now(), updated_at = now()
       WHERE id = $2 AND user_id = $3 AND state <> 'cancelled'
       RETURNING *`,
      [message, job.id, userId],
    );
    if (failed) return failed;
    return getJob(userId, job.id);
  } finally {
    if (sandbox) await sandbox.stop().catch(() => {});
  }
}

async function createArchive(userId, batchId) {
  const { batch, jobs } = await getBatch(userId, batchId);
  const summary = summarizeBatch(batch, jobs);
  if (!terminalBatchStates.has(summary.state)) throw new HttpError(409, "Aguarde o lote terminar antes de baixar o ZIP.");
  const ready = jobs.filter((job) => job.state === "ready" && job.blob_path);
  if (!ready.length) throw new HttpError(409, "Esse lote não possui arquivos prontos.");
  if (batch.archive_path) return { url: await signedDownloadUrl(batch.archive_path) };

  const sandbox = await createSandbox({ task: "archive", batch: batchId.slice(0, 12) }, 4 * 60 * 1000);
  try {
    await runChecked(sandbox, "mkdir", ["-p", "/vercel/sandbox/files"]);
    const localFiles = [];
    for (const [index, job] of ready.entries()) {
      const url = await signedDownloadUrl(job.blob_path);
      const filename = `${String(index + 1).padStart(2, "0")} - ${safeFileName(job.filename, `faixa-${index + 1}.${job.format}`)}`;
      const destination = `/vercel/sandbox/files/${filename}`;
      await runChecked(sandbox, "curl", ["--fail", "--location", "--silent", "--show-error", "--output", destination, url]);
      localFiles.push(destination);
    }
    const archiveName = `FITA-lote-${new Date().toISOString().slice(0, 10)}.zip`;
    const archivePath = `/vercel/sandbox/${archiveName}`;
    await runChecked(sandbox, "zip", ["-j", "-0", "-q", archivePath, ...localFiles]);
    const archive = await sandbox.readFileToBuffer({ path: archivePath });
    if (!archive?.length) throw new Error("O ZIP ficou vazio.");
    const blobPath = `users/${userId}/batches/${batchId}/${archiveName}`;
    const uploaded = await put(blobPath, archive, {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/zip",
    });
    await sql.query(
      "UPDATE fita_batches SET archive_path = $1, archive_url = $2, updated_at = now() WHERE id = $3 AND user_id = $4",
      [blobPath, uploaded.url, batchId, userId],
    );
    return { url: await signedDownloadUrl(blobPath) };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

async function handle(req, res) {
  const route = apiPath(req);
  if (req.method === "GET" && (route === "/" || route === "/health")) {
    return sendJson(res, 200, {
      ok: true,
      runtime: "vercel-sandbox",
      ytDlp: true,
      ffmpeg: true,
      zip: true,
      auth: true,
      storage: "private",
      downloadsReady: Boolean(process.env.YTDLP_PROXY_URL),
      upstream: process.env.YTDLP_PROXY_URL ? "configured" : "blocked-by-youtube",
    });
  }

  const userId = await authenticate(req);

  if (req.method === "POST" && route === "/inspect") {
    assertYoutubeAccess();
    const body = await readJson(req);
    return sendJson(res, 200, await inspectYoutube(body.url));
  }

  if (req.method === "POST" && route === "/download") {
    assertYoutubeAccess();
    const body = await readJson(req);
    const url = normalizeYoutubeUrl(body.url);
    const { format, quality } = validateDownloadOptions(body.format, body.quality);
    await assertQuota(userId, 1);
    const id = randomUUID();
    const [job] = await sql.query(
      `INSERT INTO fita_jobs (id, user_id, url, format, quality)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, userId, url, format, quality],
    );
    return sendJson(res, 202, publicJob(job));
  }

  if (req.method === "POST" && route === "/batches") {
    assertYoutubeAccess();
    const body = await readJson(req);
    const sources = normalizeBatchSources(body.sources);
    const { format, quality } = validateDownloadOptions(body.format, body.quality);
    const concurrency = validateConcurrency(body.concurrency);
    const resolved = await resolveBatchSources(sources);
    if (!resolved.entries.length) throw new HttpError(400, "Nenhuma faixa pública foi encontrada.");
    await assertQuota(userId, resolved.entries.length);
    const id = randomUUID();
    const [batch] = await sql.query(
      `INSERT INTO fita_batches (id, user_id, format, quality, concurrency, truncated)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, userId, format, quality, concurrency, resolved.truncated],
    );
    const rows = resolved.entries.map((entry) => ({
      id: randomUUID(), batch_id: id, user_id: userId, url: entry.url,
      format, quality, title: entry.title,
    }));
    await sql.query(
      `INSERT INTO fita_jobs (id, batch_id, user_id, url, format, quality, title)
       SELECT id, batch_id, user_id, url, format, quality, title
       FROM jsonb_to_recordset($1::jsonb)
       AS x(id uuid, batch_id uuid, user_id text, url text, format text, quality text, title text)`,
      [JSON.stringify(rows)],
    );
    const jobs = await sql.query("SELECT * FROM fita_jobs WHERE batch_id = $1 ORDER BY created_at, id", [id]);
    return sendJson(res, 202, summarizeBatch(batch, jobs));
  }

  const jobMatch = route.match(/^\/jobs\/([a-f0-9-]+)(?:\/(run|file))?$/);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    if (req.method === "GET" && !action) return sendJson(res, 200, publicJob(await getJob(userId, id)));
    if (req.method === "POST" && action === "run") return sendJson(res, 200, publicJob(await processJob(userId, id)));
    if (req.method === "POST" && action === "file") {
      const job = await getJob(userId, id);
      if (job.state !== "ready" || !job.blob_path) throw new HttpError(409, "A faixa ainda não está pronta.");
      return sendJson(res, 200, { url: await signedDownloadUrl(job.blob_path), filename: job.filename });
    }
  }

  const retryMatch = route.match(/^\/batches\/([a-f0-9-]+)\/items\/([a-f0-9-]+)\/retry$/);
  if (req.method === "POST" && retryMatch) {
    const [, batchId, jobId] = retryMatch;
    await getBatch(userId, batchId);
    const [job] = await sql.query(
      `UPDATE fita_jobs
         SET state = 'queued', progress = 0, error = NULL, sandbox_name = NULL,
             started_at = NULL, finished_at = NULL, updated_at = now()
       WHERE id = $1 AND batch_id = $2 AND user_id = $3 AND state IN ('error', 'cancelled')
       RETURNING *`,
      [jobId, batchId, userId],
    );
    if (!job) throw new HttpError(409, "Somente faixas com erro ou canceladas podem ser tentadas novamente.");
    const { batch, jobs } = await getBatch(userId, batchId);
    return sendJson(res, 200, summarizeBatch(batch, jobs));
  }

  const batchMatch = route.match(/^\/batches\/([a-f0-9-]+)(?:\/(archive|cancel))?$/);
  if (batchMatch) {
    const [, id, action] = batchMatch;
    if (req.method === "GET" && !action) {
      const { batch, jobs } = await getBatch(userId, id);
      return sendJson(res, 200, summarizeBatch(batch, jobs));
    }
    if (req.method === "POST" && action === "archive") return sendJson(res, 200, await createArchive(userId, id));
    if (req.method === "POST" && action === "cancel") {
      const { batch, jobs } = await getBatch(userId, id);
      const active = jobs.filter((job) => ["starting", "downloading"].includes(job.state) && job.sandbox_name);
      await Promise.all(active.map(async (job) => {
        try {
          const sandbox = await Sandbox.get({ name: job.sandbox_name });
          await sandbox.stop();
        } catch {
          // The session may have already finished.
        }
      }));
      await sql.query(
        `UPDATE fita_jobs SET state = 'cancelled', error = NULL, sandbox_name = NULL,
             finished_at = now(), updated_at = now()
         WHERE batch_id = $1 AND user_id = $2 AND state IN ('queued', 'starting', 'downloading')`,
        [id, userId],
      );
      const currentJobs = await sql.query(
        "SELECT * FROM fita_jobs WHERE batch_id = $1 AND user_id = $2 ORDER BY created_at, id",
        [id, userId],
      );
      return sendJson(res, 200, summarizeBatch(batch, currentJobs));
    }
  }

  throw new HttpError(404, "Rota não encontrada.");
}

export default async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError
      ? error.message
      : "O FITA encontrou um erro inesperado. Tente novamente.";
    sendError(res, status, message, error.headers);
  }
}
