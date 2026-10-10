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
    state: job.state,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    filename: job.filePath ? safeDownloadName(job.filePath) : null,
    downloadUrl: job.state === "ready" ? `/api/jobs/${job.id}/file` : null,
  };
}
