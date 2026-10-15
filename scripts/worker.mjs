import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put as putWithClientToken } from "@vercel/blob/client";
import { parseProgressLine } from "../src/lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

async function loadEnvFile(filename) {
  try {
    const text = await readFile(path.join(root, filename), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (process.env[key] !== undefined) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await loadEnvFile(".env.worker.local");

const baseUrl = new URL(process.env.FITA_BASE_URL || "https://fita-azure.vercel.app/");
const workerToken = process.env.FITA_WORKER_TOKEN;
const concurrency = Math.max(1, Math.min(4, Number(process.env.FITA_WORKER_CONCURRENCY) || 3));
const workerLabel = String(process.env.FITA_WORKER_LABEL || "Mac principal").slice(0, 80);
const runtimeRoot = path.join(root, ".runtime", "cloud-worker");
const workerIdPath = path.join(runtimeRoot, "worker-id");
const jobsRoot = path.join(runtimeRoot, "jobs");
const ytDlp = process.env.YT_DLP_PATH || path.join(root, ".tools", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const version = "3.0.0";
const maxFileBytes = 250 * 1024 * 1024;
let stopping = false;

if (!workerToken) throw new Error("FITA_WORKER_TOKEN não está configurado em .env.worker.local.");
if (!existsSync(ytDlp)) throw new Error("yt-dlp não encontrado. Execute npm run setup antes de iniciar o worker.");
if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0) {
  throw new Error("FFmpeg não encontrado no PATH.");
}

await mkdir(jobsRoot, { recursive: true });
let workerId;
try {
  workerId = (await readFile(workerIdPath, "utf8")).trim();
} catch {
  workerId = `mac-${randomUUID()}`;
  await writeFile(workerIdPath, `${workerId}\n`, { mode: 0o600 });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class CancelledError extends Error {}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, body = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerToken}`,
      "content-type": "application/json",
      "x-fita-worker-id": workerId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error || `A API respondeu ${response.status}.`);
  return data;
}

function workerInfo() {
  return {
    label: workerLabel,
    version,
    capabilities: { ytDlp: true, ffmpeg: true, concurrency },
  };
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  timer.unref();
}

function cleanToolError(value) {
  const text = String(value || "").replace(/^ERROR:\s*/gim, "").trim();
  if (/private video/i.test(text)) return "Esse vídeo é privado e não pode ser acessado.";
  if (/video unavailable|not available/i.test(text)) return "Esse vídeo não está disponível.";
  if (/sign in|login|cookies/i.test(text)) return "O YouTube pediu autenticação para esse conteúdo. Tente outro vídeo público.";
  if (/larger than max-filesize|does not pass filter|duration/i.test(text)) return "A faixa ultrapassa o limite de 60 minutos ou 250 MB.";
  return text.split("\n").filter(Boolean).at(-1) || "Não foi possível processar esse vídeo.";
}

function youtubeRuntimeArgs() {
  return [
    "--js-runtimes",
    `node:${process.execPath}`,
    "--remote-components",
    "ejs:github",
  ];
}

function runCommand(command, args, {
  cwd = root,
  timeoutMs = 3 * 60 * 1000,
  maxOutputBytes = 20 * 1024 * 1024,
  onLine = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const buffers = { stdout: "", stderr: "" };
    let settled = false;
    let forcedError = null;
    const timer = setTimeout(() => {
      forcedError = new Error("O processamento excedeu o tempo permitido.");
      stopChild(child);
    }, timeoutMs);

    const consume = (stream, chunk) => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr = (stderr + text).slice(-128 * 1024);
      if (stdout.length > maxOutputBytes) {
        forcedError = new Error("A resposta do yt-dlp ficou grande demais.");
        stopChild(child);
      }
      buffers[stream] += text;
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() || "";
      for (const line of lines) onLine(line, stream, child);
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onLine(buffers.stdout, "stdout", child);
      onLine(buffers.stderr, "stderr", child);
      if (forcedError) reject(forcedError);
      else if (code === 0) resolve({ stdout, stderr, child });
      else reject(new Error(cleanToolError(stderr || stdout)));
    });
  });
}

async function resolveSource(task) {
  let playlistCount = 0;
  try {
    const { stdout } = await runCommand(ytDlp, [
      ...youtubeRuntimeArgs(),
      "--flat-playlist",
      "--dump-json",
      "--playlist-end",
      "50",
      "--no-warnings",
      "--",
      task.url,
    ]);
    const entries = [];
    const seen = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const data = JSON.parse(line);
      playlistCount = Math.max(playlistCount, Number(data.playlist_count) || 0);
      const id = String(data.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, title: data.title || "Faixa do YouTube" });
    }
    await api(`/api/worker/sources/${task.id}/complete`, {
      leaseId: task.leaseId,
      entries,
      truncated: playlistCount > entries.length || entries.length >= 50,
    });
    console.log(`[playlist] ${task.id}: ${entries.length} faixa(s) adicionada(s)`);
  } catch (error) {
    try {
      await api(`/api/worker/sources/${task.id}/fail`, { leaseId: task.leaseId, error: error.message });
    } catch (reportError) {
      if (reportError.status !== 409) console.error(`[playlist] falha ao reportar ${task.id}:`, reportError.message);
    }
    console.error(`[playlist] ${task.id}:`, error.message);
  }
}

async function downloadTask(task) {
  const jobDir = path.join(jobsRoot, `${task.id}-${task.leaseId}`);
  await mkdir(jobDir, { recursive: true });
  let outputPath = null;
  let title = task.title || "Faixa do YouTube";
  let latestProgress = { progress: 3, speed: null, eta: null };
  let currentChild = null;
  let reportInFlight = false;
  let cancelled = false;

  const reportProgress = async () => {
    if (reportInFlight || cancelled) return;
    reportInFlight = true;
    try {
      const response = await api(`/api/worker/jobs/${task.id}/progress`, {
        leaseId: task.leaseId,
        ...latestProgress,
      });
      if (response.cancelled) {
        cancelled = true;
        stopChild(currentChild);
      }
    } catch (error) {
      if (error.status === 409) {
        cancelled = true;
        stopChild(currentChild);
      } else {
        console.error(`[progresso] ${task.id}:`, error.message);
      }
    } finally {
      reportInFlight = false;
    }
  };

  const progressTimer = setInterval(reportProgress, 1_500);
  progressTimer.unref();
  try {
    await reportProgress();
    await runCommand(ytDlp, [
      ...youtubeRuntimeArgs(),
      "--no-playlist",
      "--newline",
      "--no-warnings",
      "--progress",
      "--windows-filenames",
      "--concurrent-fragments",
      "4",
      "--match-filter",
      "duration <= 3600",
      "--max-filesize",
      "250M",
      "--extract-audio",
      "--audio-format",
      task.format,
      "--audio-quality",
      `${task.quality}K`,
      "--embed-metadata",
      "--print",
      "before_dl:__FITA_TITLE__:%(title)s",
      "--print",
      "after_move:__FITA_FILE__:%(filepath)s",
      "--progress-template",
      "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "--output",
      path.join(jobDir, "%(title).160B [%(id)s].%(ext)s"),
      "--",
      task.url,
    ], {
      timeoutMs: 2 * 60 * 60 * 1000,
      onLine(line, _stream, child) {
        currentChild = child;
        const clean = line.trim();
        if (clean.startsWith("__FITA_TITLE__:")) title = clean.slice("__FITA_TITLE__:".length).trim() || title;
        else if (clean.startsWith("__FITA_FILE__:")) {
          const candidate = path.resolve(clean.slice("__FITA_FILE__:".length).trim());
          if (candidate.startsWith(`${jobDir}${path.sep}`)) outputPath = candidate;
        } else {
          const progress = parseProgressLine(clean);
          if (progress) {
            latestProgress = {
              progress: Math.min(88, Math.max(3, 3 + progress.percent * 0.85)),
              speed: progress.speed,
              eta: progress.eta,
            };
          }
        }
      },
    });
    if (cancelled) throw new CancelledError("Tarefa cancelada.");

    if (!outputPath || !existsSync(outputPath)) {
      const files = await readdir(jobDir);
      const found = files.find((file) => file.toLowerCase().endsWith(`.${task.format}`));
      if (!found) throw new Error("Arquivo convertido não encontrado.");
      outputPath = path.join(jobDir, found);
    }
    const details = await stat(outputPath);
    if (!details.size || details.size > maxFileBytes) throw new Error("O arquivo convertido é inválido ou excede 250 MB.");
    const filename = path.basename(outputPath);
    latestProgress = { progress: 90, speed: null, eta: null };
    await reportProgress();
    if (cancelled) throw new CancelledError("Tarefa cancelada.");

    const upload = await api(`/api/worker/jobs/${task.id}/upload-token`, {
      leaseId: task.leaseId,
      filename,
    });
    const blob = await putWithClientToken(upload.pathname, createReadStream(outputPath), {
      access: "private",
      token: upload.token,
      contentType: upload.contentType,
      multipart: details.size > 100 * 1024 * 1024,
      onUploadProgress(event) {
        latestProgress = {
          progress: Math.min(99, 90 + event.percentage * 0.09),
          speed: "Enviando arquivo privado",
          eta: null,
        };
      },
    });
    await api(`/api/worker/jobs/${task.id}/complete`, {
      leaseId: task.leaseId,
      pathname: blob.pathname,
      title,
    });
    console.log(`[download] ${task.id}: ${filename}`);
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      try {
        await api(`/api/worker/jobs/${task.id}/fail`, { leaseId: task.leaseId, error: error.message });
      } catch (reportError) {
        if (reportError.status !== 409) console.error(`[download] falha ao reportar ${task.id}:`, reportError.message);
      }
      console.error(`[download] ${task.id}:`, error.message);
    }
  } finally {
    clearInterval(progressTimer);
    await rm(jobDir, { recursive: true, force: true });
  }
}

async function heartbeat() {
  try {
    await api("/api/worker/heartbeat", workerInfo());
  } catch (error) {
    console.error("[heartbeat]", error.message);
  }
}

async function workLoop(index) {
  while (!stopping) {
    try {
      const { task } = await api("/api/worker/claim", workerInfo());
      if (!task) {
        await delay(2_000 + index * 150);
        continue;
      }
      if (task.type === "source") await resolveSource(task);
      else await downloadTask(task);
    } catch (error) {
      console.error(`[worker ${index + 1}]`, error.message);
      await delay(error.status === 401 ? 15_000 : 3_000);
    }
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Recebido ${signal}; encerrando após as tarefas atuais.`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`FITA worker ${version} conectado a ${baseUrl.origin} com ${concurrency} processador(es).`);
await heartbeat();
const heartbeatTimer = setInterval(heartbeat, 25_000);
heartbeatTimer.unref();
await Promise.all(Array.from({ length: concurrency }, (_, index) => workLoop(index)));
clearInterval(heartbeatTimer);
