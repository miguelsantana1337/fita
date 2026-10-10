import path from "node:path";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export const FORMATS = new Set(["mp3", "m4a", "opus"]);
export const QUALITIES = new Set(["128", "192", "256", "320"]);
export const MAX_BATCH_ITEMS = 50;
export const MAX_CONCURRENCY = 4;

export function normalizeYoutubeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Cole um link do YouTube para continuar.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Esse link não parece ser uma URL válida.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Use um link do YouTube que comece com http ou https.");
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Por segurança, este aplicativo aceita apenas links do YouTube.");
  }

  url.protocol = "https:";
  url.hash = "";
  return url.toString();
}

export function youtubeIdentity(value) {
  const normalized = normalizeYoutubeUrl(value);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.searchParams.get("list")) return `playlist:${url.searchParams.get("list")}`;

  if (host === "youtu.be" || host === "www.youtu.be") {
    return parts[0] ? `video:${parts[0]}` : `url:${normalized}`;
  }

  if (url.pathname === "/watch" && url.searchParams.get("v")) {
    return `video:${url.searchParams.get("v")}`;
  }

  if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) {
    return `video:${parts[1]}`;
  }

  const stable = new URL(normalized);
  for (const key of [...stable.searchParams.keys()]) {
    if (key.startsWith("utm_") || ["feature", "si", "pp"].includes(key)) {
      stable.searchParams.delete(key);
    }
  }
  return `url:${stable.toString()}`;
}

export function isPlaylistUrl(value) {
  const url = new URL(normalizeYoutubeUrl(value));
  return url.pathname === "/playlist" || url.searchParams.has("list");
}

export function normalizeBatchSources(value, maxItems = MAX_BATCH_ITEMS) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  const cleaned = rawItems.map((item) => String(item).trim()).filter(Boolean);

  if (!cleaned.length) throw new Error("Cole ao menos um link do YouTube para continuar.");
  if (cleaned.length > maxItems) {
    throw new Error(`Use no máximo ${maxItems} links ou playlists por lote.`);
  }

  const seen = new Set();
  const sources = [];
  for (const item of cleaned) {
    const normalized = normalizeYoutubeUrl(item);
    const identity = youtubeIdentity(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    sources.push(normalized);
  }
  return sources;
}

export function validateConcurrency(value, fallback = 3) {
  const concurrency = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`Escolha entre 1 e ${MAX_CONCURRENCY} downloads simultâneos.`);
  }
  return concurrency;
}

export function validateDownloadOptions(format, quality) {
  if (!FORMATS.has(format)) {
    throw new Error("Escolha um formato de áudio válido.");
  }
  if (!QUALITIES.has(quality)) {
    throw new Error("Escolha uma qualidade válida.");
  }
  return { format, quality };
}

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return null;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function safeDownloadName(filePath) {
  return path.basename(filePath).replace(/[\r\n\"\\]/g, "_");
}

export function parseProgressLine(line) {
  if (!line.startsWith("download:")) return null;
  const [percent = "", speed = "", eta = ""] = line.slice(9).split("|");
  const numeric = Number.parseFloat(percent.replace("%", "").trim());
  return {
    percent: Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0,
    speed: speed.trim() && speed.trim() !== "NA" ? speed.trim() : null,
    eta: eta.trim() && eta.trim() !== "NA" ? eta.trim() : null,
  };
}

export function publicJob(job) {
  return {
    id: job.id,
    batchId: job.batchId || null,
    title: job.title || "Faixa do YouTube",
    state: job.state,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    filename: job.filePath ? safeDownloadName(job.filePath) : null,
    downloadUrl: job.state === "ready" ? `/api/jobs/${job.id}/file` : null,
  };
}
