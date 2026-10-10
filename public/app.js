const linkForm = document.querySelector("#link-form");
const downloadForm = document.querySelector("#download-form");
const urlInput = document.querySelector("#youtube-url");
const statusBox = document.querySelector("#status");
const trackCard = document.querySelector("#track-card");
const progressCard = document.querySelector("#progress-card");
const searchButton = linkForm.querySelector("button");
const downloadButton = document.querySelector("#download-button");
let selectedUrl = "";
let pollTimer = null;

function setStatus(message, type = "error") {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`;
  statusBox.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir essa ação.");
  return data;
}

function showTrack(track) {
  document.querySelector("#track-title").textContent = track.title;
  document.querySelector("#track-channel").textContent = track.channel;
  const duration = document.querySelector("#track-duration");
  duration.textContent = track.duration || "Duração não informada";
  const cover = document.querySelector("#track-cover");
  cover.src = track.thumbnail || "";
  cover.alt = track.thumbnail ? `Capa de ${track.title}` : "";
  trackCard.hidden = false;
  progressCard.hidden = true;
  trackCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

linkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(pollTimer);
  trackCard.hidden = true;
  progressCard.hidden = true;
  selectedUrl = urlInput.value.trim();
  setStatus("Buscando informações do vídeo…", "loading");
  searchButton.disabled = true;
  try {
    const track = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({ url: selectedUrl }),
    });
    setStatus("");
    showTrack(track);
  } catch (error) {
    setStatus(error.message);
  } finally {
    searchButton.disabled = false;
  }
});

downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedUrl) return;
  downloadButton.disabled = true;
  setStatus("");
  progressCard.hidden = false;
  document.querySelector("#progress-title").textContent = "Baixando e convertendo…";
  updateProgress({ progress: 0, speed: null, eta: null });
  progressCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const job = await api("/api/download", {
      method: "POST",
      body: JSON.stringify({
        url: selectedUrl,
        format: document.querySelector("#format").value,
        quality: document.querySelector("#quality").value,
      }),
    });
    await pollJob(job.id);
  } catch (error) {
    progressCard.hidden = true;
    setStatus(error.message);
    downloadButton.disabled = false;
  }
});

function updateProgress(job) {
  const percent = Math.round(job.progress || 0);
  document.querySelector("#progress-value").textContent = `${percent}%`;
  document.querySelector("#progress-bar").style.width = `${percent}%`;
  const details = [];
  if (job.speed) details.push(job.speed);
  if (job.eta) details.push(`faltam ${job.eta}`);
  document.querySelector("#progress-detail").textContent = details.join(" · ") || "Preparando o download…";
}

async function pollJob(id) {
  try {
    const job = await api(`/api/jobs/${id}`);
    updateProgress(job);
    if (job.state === "ready") {
      document.querySelector("#progress-title").textContent = "Faixa pronta. Iniciando download…";
      document.querySelector("#progress-detail").textContent = job.filename;
      window.location.assign(job.downloadUrl);
      downloadButton.disabled = false;
      return;
    }
    if (job.state === "error") throw new Error(job.error || "O download não pôde ser concluído.");
    pollTimer = setTimeout(() => pollJob(id), 700);
  } catch (error) {
    progressCard.hidden = true;
    setStatus(error.message);
    downloadButton.disabled = false;
  }
}

fetch("/api/health")
  .then((response) => response.json())
  .then((health) => {
    if (!health.ytDlp) setStatus("A configuração inicial ainda não foi feita. Feche esta janela e execute npm run setup no Terminal.");
  })
  .catch(() => setStatus("O servidor local não respondeu. Reinicie o aplicativo."));
