import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  formatDuration,
  normalizeYoutubeUrl,
  parseProgressLine,
  publicJob,
  safeDownloadName,
  validateDownloadOptions,
} from "./lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");
const runtimeDir = path.join(root, ".runtime");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const jobs = new Map();
const videoCache = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
const VIDEO_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;

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

function run(command, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("O YouTube demorou demais para responder. Tente novamente."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cleanToolError(stderr || stdout)));
    });
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

async function startDownload(url, format, quality) {
  const id = randomUUID();
  const jobDir = path.join(runtimeDir, id);
  await mkdir(jobDir, { recursive: true });
  const job = {
    id,
    dir: jobDir,
    state: "queued",
    progress: 0,
    speed: null,
    eta: null,
    error: null,
    filePath: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--windows-filenames",
    "--extract-audio",
    "--audio-format",
    format,
    "--audio-quality",
    `${quality}K`,
    "--embed-metadata",
    "--progress-template",
    "download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "--output",
    path.join(jobDir, "%(title).120B [%(id)s].%(ext)s"),
    "--",
    url,
  ];

  const child = spawn(ytDlpPath(), args, { cwd: root, env: process.env });
  job.state = "downloading";
  let outputBuffer = "";
  let errorOutput = "";

  child.stdout.on("data", (chunk) => {
    outputBuffer += chunk.toString();
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() || "";
    for (const line of lines) {
      const progress = parseProgressLine(line.trim());
      if (progress) Object.assign(job, progress);
    }
  });
  child.stderr.on("data", (chunk) => {
    errorOutput = (errorOutput + chunk.toString()).slice(-12_000);
  });
  child.on("error", (error) => {
    job.state = "error";
    job.error = error.code === "ENOENT"
      ? "O yt-dlp não foi encontrado. Execute npm run setup."
      : "Não foi possível iniciar o download.";
  });
  child.on("close", async (code) => {
    if (job.state === "error") return;
    if (code !== 0) {
      job.state = "error";
      job.error = cleanToolError(errorOutput);
      return;
    }
    try {
      const files = await readdir(jobDir);
      const audioFile = files.find((file) => file.toLowerCase().endsWith(`.${format}`));
      if (!audioFile) throw new Error("Arquivo convertido não encontrado.");
      job.filePath = path.join(jobDir, audioFile);
      job.progress = 100;
      job.state = "ready";
    } catch (error) {
      job.state = "error";
      job.error = error.message;
    }
  });

  return publicJob(job);
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
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
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

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      ytDlp: existsSync(ytDlpPath()),
      ffmpeg: true,
      localOnly: host === "127.0.0.1" || host === "localhost",
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
      const body = await readJson(req);
      const url = normalizeYoutubeUrl(body.url);
      const { format, quality } = validateDownloadOptions(body.format, body.quality);
      sendJson(res, 202, await startDownload(url, format, quality));
    } catch (error) {
      sendError(res, 400, error.message);
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
    const info = await stat(job.filePath);
    const filename = safeDownloadName(job.filePath);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": info.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(job.filePath).pipe(res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(pathname, res);
    return;
  }
  sendError(res, 405, "Método não permitido.");
}

async function cleanupExpiredJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      jobs.delete(id);
      await rm(job.dir, { recursive: true, force: true });
    }
  }
  for (const [url, cached] of videoCache) {
    if (cached.expiresAt <= Date.now()) videoCache.delete(url);
  }
}

await mkdir(runtimeDir, { recursive: true });
setInterval(cleanupExpiredJobs, 5 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, "Ocorreu um erro interno.");
    else res.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`\nFITA está rodando em http://${host}:${port}`);
  console.log("Pressione Ctrl+C para encerrar.\n");
});
