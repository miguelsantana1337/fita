import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { del, getDownloadUrl, head, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { Sandbox } from "@vercel/sandbox";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  MAX_BATCH_ITEMS,
  isPlaylistUrl,
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
  "BLOB_READ_WRITE_TOKEN",
];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const sql = neon(process.env.DATABASE_URL);
const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL).origin;
const terminalBatchStates = new Set(["completed", "completed_with_errors", "error", "cancelled"]);
const maxBodyBytes = 256 * 1024;
const maxFileBytes = 250 * 1024 * 1024;
const dailyJobLimit = 100;
const workerLeaseMinutes = 5;

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

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && first.length > 0 && timingSafeEqual(first, second);
}

function authenticateWorker(req) {
  const expected = process.env.FITA_WORKER_TOKEN;
  const header = req.headers.authorization;
  const supplied = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  if (!expected || !safeEqual(supplied, expected)) throw new HttpError(401, "Worker não autorizado.");
  const workerId = String(req.headers["x-fita-worker-id"] || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,96}$/.test(workerId)) throw new HttpError(400, "Identificador do worker inválido.");
  return workerId;
}

function apiPath(req) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "fita.invalid"}`);
  const rewritten = requestUrl.searchParams.get("path");
  if (rewritten !== null) return `/${rewritten}`.replace(/\/{2,}/g, "/");
  return requestUrl.pathname.replace(/^\/api(?:\/index)?/, "") || "/";
}

function assertHybridConfigured() {
  if (!process.env.FITA_WORKER_TOKEN) {
    throw new HttpError(503, "A fila híbrida ainda não foi configurada.", { "retry-after": "300" });
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

function safePathSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
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

function summarizeBatch(batch, jobs, sources = []) {
  const counts = { total: jobs.length, queued: 0, running: 0, ready: 0, error: 0, cancelled: 0 };
  for (const job of jobs) {
    if (job.state === "queued") counts.queued += 1;
    else if (["starting", "downloading"].includes(job.state)) counts.running += 1;
    else if (job.state === "ready") counts.ready += 1;
    else if (job.state === "error") counts.error += 1;
    else if (job.state === "cancelled") counts.cancelled += 1;
  }
  const pendingSources = sources.filter((source) => ["queued", "resolving"].includes(source.state)).length;
  const cancelledSources = sources.filter((source) => source.state === "cancelled").length;
  const sourceErrors = [
    ...(Array.isArray(batch.source_errors) ? batch.source_errors : []),
    ...sources
      .filter((source) => source.state === "error" && source.error)
      .map((source) => ({ url: source.url, message: source.error })),
  ];

  let state = "queued";
  if (pendingSources) state = counts.running ? "running" : "resolving";
  else if (!counts.total && sources.length && cancelledSources === sources.length) state = "cancelled";
  else if (!counts.total) state = "error";
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
  return {
    id: batch.id,
    state,
    progress,
    counts,
    pendingSources,
    items: jobs.map(publicJob),
    error: !pendingSources && !counts.total ? "Nenhuma faixa pública foi encontrada." : null,
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
    throw new Error(errorText.split("\n").filter(Boolean).at(-1) || "Falha ao montar o arquivo.");
  }
  return result;
}

async function inspectYoutube(url) {
  const normalized = normalizeYoutubeUrl(url);
  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", normalized);
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint, {
      headers: { "user-agent": "FITA/3.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`oEmbed ${response.status}`);
    const data = await response.json();
    return {
      id: youtubeIdentity(normalized),
      title: data.title || "Faixa do YouTube",
      channel: data.author_name || "Canal não informado",
      duration: null,
      thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
      webpageUrl: normalized,
    };
  } catch {
    const identity = youtubeIdentity(normalized);
    const videoId = identity.startsWith("video:") ? identity.slice(6) : null;
    return {
      id: identity,
      title: "Faixa do YouTube",
      channel: "Informações completas aparecerão durante o processamento",
      duration: null,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : null,
      webpageUrl: normalized,
    };
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
  const [jobs, sources] = await Promise.all([
    sql.query("SELECT * FROM fita_jobs WHERE batch_id = $1 AND user_id = $2 ORDER BY created_at, id", [id, userId]),
    sql.query("SELECT * FROM fita_batch_sources WHERE batch_id = $1 AND user_id = $2 ORDER BY created_at, id", [id, userId]),
  ]);
  return { batch, jobs, sources };
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

function cleanWorkerError(value) {
  const text = String(value || "").replace(/^ERROR:\s*/gim, "").trim();
  if (/private video/i.test(text)) return "Esse vídeo é privado e não pode ser acessado.";
  if (/video unavailable|not available/i.test(text)) return "Esse vídeo não está disponível.";
  if (/larger than max-filesize|does not pass filter|duration/i.test(text)) {
    return "A faixa ultrapassa o limite de 60 minutos ou 250 MB.";
  }
  return (text.split("\n").filter(Boolean).at(-1) || "Não foi possível processar esse vídeo.").slice(0, 500);
}

async function recordWorker(workerId, body = {}) {
  const label = String(body.label || "Mac FITA").trim().slice(0, 80) || "Mac FITA";
  const version = String(body.version || "").trim().slice(0, 40) || null;
  const capabilities = body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {};
  await sql.query(
    `INSERT INTO fita_workers (id, label, version, capabilities, last_seen)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label, version = EXCLUDED.version,
           capabilities = EXCLUDED.capabilities, last_seen = now()`,
    [workerId, label, version, JSON.stringify(capabilities)],
  );
}

async function claimSource(workerId) {
  const leaseId = randomUUID();
  const [source] = await sql.query(
    `WITH claim_lock AS (
       SELECT pg_try_advisory_xact_lock(73482101) AS acquired
     ), candidate AS (
       SELECT source.id
       FROM fita_batch_sources AS source, claim_lock
       WHERE claim_lock.acquired
         AND (
           source.state = 'queued'
           OR (source.state = 'resolving' AND COALESCE(source.lease_expires_at, source.updated_at) < now())
         )
         AND NOT EXISTS (
           SELECT 1 FROM fita_batch_sources AS active
           WHERE active.state = 'resolving' AND active.lease_expires_at >= now()
         )
       ORDER BY source.created_at, source.id
       FOR UPDATE OF source SKIP LOCKED
       LIMIT 1
     )
     UPDATE fita_batch_sources AS source
        SET state = 'resolving', worker_id = $1, lease_id = $2,
            lease_expires_at = now() + interval '${workerLeaseMinutes} minutes',
            attempt = attempt + 1, error = NULL, finished_at = NULL, updated_at = now()
       FROM candidate
      WHERE source.id = candidate.id
      RETURNING source.*`,
    [workerId, leaseId],
  );
  if (!source) return null;
  return { type: "source", id: source.id, leaseId, url: source.url, batchId: source.batch_id };
}

async function claimJob(workerId) {
  const leaseId = randomUUID();
  const [job] = await sql.query(
    `WITH claim_lock AS (
       SELECT pg_try_advisory_xact_lock(73482102) AS acquired
     ), candidate AS (
       SELECT job.id
       FROM fita_jobs AS job
       LEFT JOIN fita_batches AS batch ON batch.id = job.batch_id,
       claim_lock
       WHERE claim_lock.acquired
         AND (
           job.state = 'queued'
           OR (
             job.state IN ('starting', 'downloading')
             AND COALESCE(job.lease_expires_at, job.updated_at) < now()
           )
         )
         AND (
           job.batch_id IS NULL
           OR (
             SELECT count(*)
             FROM fita_jobs AS active
             WHERE active.batch_id = job.batch_id
               AND active.state IN ('starting', 'downloading')
               AND active.lease_expires_at >= now()
           ) < batch.concurrency
         )
       ORDER BY job.created_at, job.id
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1
     )
     UPDATE fita_jobs AS job
        SET state = 'starting', progress = 2, speed = NULL, eta = NULL, error = NULL,
            worker_id = $1, lease_id = $2,
            lease_expires_at = now() + interval '${workerLeaseMinutes} minutes',
            upload_path = NULL, attempt = attempt + 1,
            started_at = COALESCE(job.started_at, now()), finished_at = NULL, updated_at = now()
       FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*`,
    [workerId, leaseId],
  );
  if (!job) return null;
  return {
    type: "download", id: job.id, leaseId, url: job.url, format: job.format,
    quality: job.quality, title: job.title, batchId: job.batch_id,
  };
}

async function claimTask(workerId, body) {
  await recordWorker(workerId, body);
  return (await claimSource(workerId)) || (await claimJob(workerId));
}

async function getLeasedJob(workerId, id, leaseId) {
  const [job] = await sql.query(
    "SELECT * FROM fita_jobs WHERE id = $1 AND worker_id = $2 AND lease_id = $3",
    [id, workerId, leaseId],
  );
  if (!job) throw new HttpError(409, "A reserva desta tarefa expirou.");
  return job;
}

async function updateJobProgress(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const progress = Math.max(2, Math.min(99, Number(body.progress) || 2));
  const speed = body.speed ? String(body.speed).slice(0, 80) : null;
  const eta = body.eta ? String(body.eta).slice(0, 40) : null;
  const [job] = await sql.query(
    `UPDATE fita_jobs
        SET state = 'downloading', progress = $1, speed = $2, eta = $3,
            lease_expires_at = now() + interval '${workerLeaseMinutes} minutes', updated_at = now()
      WHERE id = $4 AND worker_id = $5 AND lease_id = $6
        AND state IN ('starting', 'downloading')
      RETURNING *`,
    [progress, speed, eta, id, workerId, leaseId],
  );
  if (job) return { ok: true, cancelled: false };
  const [current] = await sql.query("SELECT state FROM fita_jobs WHERE id = $1", [id]);
  if (current?.state === "cancelled") return { ok: true, cancelled: true };
  throw new HttpError(409, "A reserva desta tarefa expirou.");
}

async function createUploadToken(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const job = await getLeasedJob(workerId, id, leaseId);
  if (!["starting", "downloading"].includes(job.state)) throw new HttpError(409, "A tarefa não aceita mais uploads.");
  let filename = safeFileName(body.filename, `FITA-${job.id}.${job.format}`);
  if (!filename.toLowerCase().endsWith(`.${job.format}`)) filename = `${filename}.${job.format}`;
  const blobPath = `users/${safePathSegment(job.user_id)}/jobs/${job.id}/${leaseId}-${filename}`;
  const validUntil = Date.now() + 20 * 60 * 1000;
  const token = await generateClientTokenFromReadWriteToken({
    pathname: blobPath,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    allowedContentTypes: [contentTypeFor(job.format)],
    maximumSizeInBytes: maxFileBytes,
    validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  await sql.query(
    `UPDATE fita_jobs SET upload_path = $1, filename = $2,
       lease_expires_at = now() + interval '20 minutes', updated_at = now()
     WHERE id = $3 AND worker_id = $4 AND lease_id = $5`,
    [blobPath, filename, id, workerId, leaseId],
  );
  return { token, pathname: blobPath, filename, contentType: contentTypeFor(job.format), validUntil };
}

async function completeJob(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const job = await getLeasedJob(workerId, id, leaseId);
  if (!job.upload_path || body.pathname !== job.upload_path) throw new HttpError(400, "O caminho enviado não corresponde à tarefa.");
  const blob = await head(job.upload_path);
  if (!blob?.size || blob.size > maxFileBytes) {
    if (blob?.url) await del(blob.url).catch(() => {});
    throw new HttpError(400, "O arquivo enviado é inválido ou excede 250 MB.");
  }
  const title = String(body.title || job.filename || job.title)
    .replace(new RegExp(`\\.${job.format}$`, "i"), "")
    .replace(/\s*\[[^\]]+\]$/, "")
    .trim()
    .slice(0, 240) || job.title;
  const [ready] = await sql.query(
    `UPDATE fita_jobs
        SET state = 'ready', progress = 100, title = $1, filename = $2,
            blob_path = $3, blob_url = $4, file_size = $5,
            worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
            upload_path = NULL, speed = NULL, eta = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $6 AND worker_id = $7 AND lease_id = $8
        AND state IN ('starting', 'downloading')
      RETURNING *`,
    [title, job.filename, job.upload_path, blob.url, blob.size, id, workerId, leaseId],
  );
  if (!ready) {
    await del(blob.url).catch(() => {});
    throw new HttpError(409, "A tarefa foi cancelada antes da conclusão.");
  }
  return publicJob(ready);
}

async function failJob(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const [failed] = await sql.query(
    `UPDATE fita_jobs
        SET state = 'error', error = $1, worker_id = NULL, lease_id = NULL,
            lease_expires_at = NULL, upload_path = NULL, speed = NULL, eta = NULL,
            finished_at = now(), updated_at = now()
      WHERE id = $2 AND worker_id = $3 AND lease_id = $4
        AND state IN ('starting', 'downloading')
      RETURNING *`,
    [cleanWorkerError(body.error), id, workerId, leaseId],
  );
  if (failed) return publicJob(failed);
  const [current] = await sql.query("SELECT * FROM fita_jobs WHERE id = $1", [id]);
  if (current?.state === "cancelled") return publicJob(current);
  throw new HttpError(409, "A reserva desta tarefa expirou.");
}

function normalizeWorkerEntries(entries) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(entries) ? entries.slice(0, MAX_BATCH_ITEMS * 2) : []) {
    try {
      const id = String(item?.id || "").trim();
      const candidate = id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : item?.url;
      const url = normalizeYoutubeUrl(candidate);
      const identity = youtubeIdentity(url);
      if (!identity.startsWith("video:") || seen.has(identity)) continue;
      seen.add(identity);
      normalized.push({
        url,
        title: String(item?.title || "Faixa do YouTube").trim().slice(0, 240) || "Faixa do YouTube",
      });
    } catch {
      // Ignore malformed entries reported by yt-dlp.
    }
  }
  return normalized;
}

async function completeSource(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const [source] = await sql.query(
    `SELECT source.*, batch.format, batch.quality
       FROM fita_batch_sources AS source
       JOIN fita_batches AS batch ON batch.id = source.batch_id
      WHERE source.id = $1 AND source.worker_id = $2 AND source.lease_id = $3
        AND source.state = 'resolving'`,
    [id, workerId, leaseId],
  );
  if (!source) throw new HttpError(409, "A reserva desta playlist expirou.");
  const entries = normalizeWorkerEntries(body.entries);
  if (!entries.length) throw new HttpError(400, "Nenhuma faixa pública foi encontrada nessa playlist.");

  const [[batchCount], [dailyUsage]] = await Promise.all([
    sql.query("SELECT count(*)::int AS count FROM fita_jobs WHERE batch_id = $1", [source.batch_id]),
    sql.query(
      "SELECT count(*)::int AS count FROM fita_jobs WHERE user_id = $1 AND created_at > now() - interval '24 hours'",
      [source.user_id],
    ),
  ]);
  const remainingBatch = Math.max(0, MAX_BATCH_ITEMS - (batchCount?.count || 0));
  const remainingDaily = Math.max(0, dailyJobLimit - (dailyUsage?.count || 0));
  const selected = entries.slice(0, Math.min(remainingBatch, remainingDaily));
  if (!selected.length) {
    throw new HttpError(429, remainingBatch === 0
      ? `O lote já atingiu ${MAX_BATCH_ITEMS} faixas.`
      : `Seu limite é de ${dailyJobLimit} faixas a cada 24 horas.`);
  }

  const rows = selected.map((entry) => ({
    id: randomUUID(), batch_id: source.batch_id, user_id: source.user_id,
    url: entry.url, format: source.format, quality: source.quality, title: entry.title,
  }));
  await sql.query(
    `INSERT INTO fita_jobs (id, batch_id, user_id, url, format, quality, title)
     SELECT item.id, item.batch_id, item.user_id, item.url, item.format, item.quality, item.title
       FROM jsonb_to_recordset($1::jsonb)
         AS item(id uuid, batch_id uuid, user_id text, url text, format text, quality text, title text)
      WHERE NOT EXISTS (
        SELECT 1 FROM fita_jobs AS existing
        WHERE existing.batch_id = item.batch_id AND existing.url = item.url
      )`,
    [JSON.stringify(rows)],
  );
  const truncated = entries.length > selected.length || Boolean(body.truncated);
  await Promise.all([
    sql.query(
      `UPDATE fita_batch_sources
          SET state = 'resolved', worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
              finished_at = now(), updated_at = now()
        WHERE id = $1 AND worker_id = $2 AND lease_id = $3`,
      [id, workerId, leaseId],
    ),
    truncated
      ? sql.query("UPDATE fita_batches SET truncated = true, updated_at = now() WHERE id = $1", [source.batch_id])
      : Promise.resolve(),
  ]);
  return { ok: true, added: rows.length, truncated };
}

async function failSource(workerId, id, body) {
  const leaseId = String(body.leaseId || "");
  const [failed] = await sql.query(
    `UPDATE fita_batch_sources
        SET state = 'error', error = $1, worker_id = NULL, lease_id = NULL,
            lease_expires_at = NULL, finished_at = now(), updated_at = now()
      WHERE id = $2 AND worker_id = $3 AND lease_id = $4 AND state = 'resolving'
      RETURNING id`,
    [cleanWorkerError(body.error), id, workerId, leaseId],
  );
  if (!failed) throw new HttpError(409, "A reserva desta playlist expirou.");
  return { ok: true };
}

async function workerHealth() {
  const [worker] = await sql.query(
    `SELECT id, label, version, capabilities, last_seen
       FROM fita_workers
      WHERE last_seen > now() - interval '75 seconds'
      ORDER BY last_seen DESC
      LIMIT 1`,
  );
  return worker || null;
}

async function createArchive(userId, batchId) {
  const { batch, jobs, sources } = await getBatch(userId, batchId);
  const summary = summarizeBatch(batch, jobs, sources);
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
    const blobPath = `users/${safePathSegment(userId)}/batches/${batchId}/${archiveName}`;
    const uploaded = await put(blobPath, archive, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
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

async function handleWorkerRoute(req, res, route) {
  const workerId = authenticateWorker(req);
  const body = await readJson(req);
  if (req.method === "POST" && route === "/worker/heartbeat") {
    await recordWorker(workerId, body);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && route === "/worker/claim") {
    return sendJson(res, 200, { task: await claimTask(workerId, body) });
  }
  const jobMatch = route.match(/^\/worker\/jobs\/([a-f0-9-]+)\/(progress|upload-token|complete|fail)$/);
  if (req.method === "POST" && jobMatch) {
    const [, id, action] = jobMatch;
    if (action === "progress") return sendJson(res, 200, await updateJobProgress(workerId, id, body));
    if (action === "upload-token") return sendJson(res, 200, await createUploadToken(workerId, id, body));
    if (action === "complete") return sendJson(res, 200, await completeJob(workerId, id, body));
    if (action === "fail") return sendJson(res, 200, await failJob(workerId, id, body));
  }
  const sourceMatch = route.match(/^\/worker\/sources\/([a-f0-9-]+)\/(complete|fail)$/);
  if (req.method === "POST" && sourceMatch) {
    const [, id, action] = sourceMatch;
    if (action === "complete") return sendJson(res, 200, await completeSource(workerId, id, body));
    if (action === "fail") return sendJson(res, 200, await failSource(workerId, id, body));
  }
  throw new HttpError(404, "Rota do worker não encontrada.");
}

async function handle(req, res) {
  const route = apiPath(req);
  if (req.method === "GET" && (route === "/" || route === "/health")) {
    const worker = await workerHealth();
    const configured = Boolean(process.env.FITA_WORKER_TOKEN);
    return sendJson(res, 200, {
      ok: true,
      runtime: "hybrid-local-worker",
      processingMode: "local-worker",
      workerOnline: Boolean(worker),
      workerLabel: worker?.label || null,
      ytDlp: Boolean(worker?.capabilities?.ytDlp),
      ffmpeg: Boolean(worker?.capabilities?.ffmpeg),
      zip: true,
      auth: true,
      storage: "private",
      downloadsReady: configured,
      upstream: worker ? "local-worker-online" : configured ? "local-worker-offline" : "worker-not-configured",
    });
  }

  if (req.method === "POST" && route === "/inspect") {
    const body = await readJson(req);
    return sendJson(res, 200, await inspectYoutube(body.url));
  }

  if (route.startsWith("/worker/")) return handleWorkerRoute(req, res, route);

  const userId = await authenticate(req);

  if (req.method === "POST" && route === "/download") {
    assertHybridConfigured();
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
    assertHybridConfigured();
    const body = await readJson(req);
    const sources = normalizeBatchSources(body.sources);
    const { format, quality } = validateDownloadOptions(body.format, body.quality);
    const concurrency = validateConcurrency(body.concurrency);
    const direct = sources.filter((source) => !isPlaylistUrl(source));
    const playlists = sources.filter((source) => isPlaylistUrl(source));
    await assertQuota(userId, direct.length);
    const id = randomUUID();
    const [batch] = await sql.query(
      `INSERT INTO fita_batches (id, user_id, format, quality, concurrency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, userId, format, quality, concurrency],
    );
    if (direct.length) {
      const rows = direct.map((url) => ({
        id: randomUUID(), batch_id: id, user_id: userId, url,
        format, quality, title: "Faixa do YouTube",
      }));
      await sql.query(
        `INSERT INTO fita_jobs (id, batch_id, user_id, url, format, quality, title)
         SELECT item.id, item.batch_id, item.user_id, item.url, item.format, item.quality, item.title
         FROM jsonb_to_recordset($1::jsonb)
         AS item(id uuid, batch_id uuid, user_id text, url text, format text, quality text, title text)`,
        [JSON.stringify(rows)],
      );
    }
    if (playlists.length) {
      const rows = playlists.map((url) => ({ id: randomUUID(), batch_id: id, user_id: userId, url }));
      await sql.query(
        `INSERT INTO fita_batch_sources (id, batch_id, user_id, url)
         SELECT item.id, item.batch_id, item.user_id, item.url
         FROM jsonb_to_recordset($1::jsonb)
         AS item(id uuid, batch_id uuid, user_id text, url text)`,
        [JSON.stringify(rows)],
      );
    }
    const current = await getBatch(userId, id);
    return sendJson(res, 202, summarizeBatch(current.batch, current.jobs, current.sources));
  }

  const jobMatch = route.match(/^\/jobs\/([a-f0-9-]+)(?:\/(run|file))?$/);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    if (req.method === "GET" && !action) return sendJson(res, 200, publicJob(await getJob(userId, id)));
    if (req.method === "POST" && action === "run") return sendJson(res, 200, publicJob(await getJob(userId, id)));
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
              worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
              upload_path = NULL, speed = NULL, eta = NULL,
              started_at = NULL, finished_at = NULL, updated_at = now()
        WHERE id = $1 AND batch_id = $2 AND user_id = $3 AND state IN ('error', 'cancelled')
        RETURNING *`,
      [jobId, batchId, userId],
    );
    if (!job) throw new HttpError(409, "Somente faixas com erro ou canceladas podem ser tentadas novamente.");
    const current = await getBatch(userId, batchId);
    return sendJson(res, 200, summarizeBatch(current.batch, current.jobs, current.sources));
  }

  const batchMatch = route.match(/^\/batches\/([a-f0-9-]+)(?:\/(archive|cancel))?$/);
  if (batchMatch) {
    const [, id, action] = batchMatch;
    if (req.method === "GET" && !action) {
      const current = await getBatch(userId, id);
      return sendJson(res, 200, summarizeBatch(current.batch, current.jobs, current.sources));
    }
    if (req.method === "POST" && action === "archive") return sendJson(res, 200, await createArchive(userId, id));
    if (req.method === "POST" && action === "cancel") {
      await getBatch(userId, id);
      await Promise.all([
        sql.query(
          `UPDATE fita_jobs
              SET state = 'cancelled', error = NULL, sandbox_name = NULL,
                  worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
                  upload_path = NULL, finished_at = now(), updated_at = now()
            WHERE batch_id = $1 AND user_id = $2 AND state IN ('queued', 'starting', 'downloading')`,
          [id, userId],
        ),
        sql.query(
          `UPDATE fita_batch_sources
              SET state = 'cancelled', error = NULL, worker_id = NULL, lease_id = NULL,
                  lease_expires_at = NULL, finished_at = now(), updated_at = now()
            WHERE batch_id = $1 AND user_id = $2 AND state IN ('queued', 'resolving')`,
          [id, userId],
        ),
      ]);
      const latest = await getBatch(userId, id);
      return sendJson(res, 200, summarizeBatch(latest.batch, latest.jobs, latest.sources));
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
