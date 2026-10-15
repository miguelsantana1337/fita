import { createAuthClient } from "@neondatabase/auth";

const authClient = createAuthClient(__NEON_AUTH_URL__);
const adsenseClientId = __ADSENSE_CLIENT_ID__;
const adsenseSlots = {
  top: __ADSENSE_SLOT_TOP__,
  inline: __ADSENSE_SLOT_INLINE__,
};
const runtimeBadge = document.querySelector(".local-badge");
const authPanel = document.querySelector("#auth-panel");
const authForm = document.querySelector("#auth-form");
const authStatus = document.querySelector("#auth-status");
const authSubmit = document.querySelector("#auth-submit");
const signInTab = document.querySelector("#sign-in-tab");
const signUpTab = document.querySelector("#sign-up-tab");
const nameField = document.querySelector("#name-field");
const authIntent = document.querySelector("#auth-intent");
const openAuthButton = document.querySelector("#open-auth");
const closeAuthButton = document.querySelector("#close-auth");
const accountEmail = document.querySelector("#account-email");
const signOutButton = document.querySelector("#sign-out");
const linkForm = document.querySelector("#link-form");
const downloadForm = document.querySelector("#download-form");
const batchForm = document.querySelector("#batch-form");
const urlInput = document.querySelector("#youtube-url");
const statusBox = document.querySelector("#status");
const batchStatusBox = document.querySelector("#batch-status");
const trackCard = document.querySelector("#track-card");
const progressCard = document.querySelector("#progress-card");
const batchProgress = document.querySelector("#batch-progress");
const batchList = document.querySelector("#batch-list");
const searchButton = linkForm.querySelector("button");
const downloadButton = document.querySelector("#download-button");
const batchButton = document.querySelector("#batch-button");
const cancelBatchButton = document.querySelector("#cancel-batch");
const archiveLink = document.querySelector("#download-archive");
const singleTab = document.querySelector("#single-tab");
const batchTab = document.querySelector("#batch-tab");
let selectedUrl = "";
let pollTimer = null;
let batchPollTimer = null;
let currentBatchId = null;
let batchPollRevision = 0;
let lastBatch = null;
let batchMutationActive = false;
let batchReconcilePending = false;
let singleJobActive = false;
let authMode = "sign-in";
let accessToken = null;
let pendingAuthAction = null;
let authFocusReturn = null;
let batchRunGeneration = 0;
let downloadsReady = false;

const TERMINAL_BATCH_STATES = new Set(["completed", "completed_with_errors", "error", "cancelled"]);
const STATE_LABELS = {
  queued: "Na fila",
  starting: "Iniciando",
  downloading: "Baixando",
  cancelling: "Cancelando",
  ready: "Pronta",
  error: "Falhou",
  cancelled: "Cancelada",
  retrying: "Repetindo",
};

function syncBatchControls() {
  const terminal = !lastBatch || TERMINAL_BATCH_STATES.has(lastBatch.state);
  const blocked = batchMutationActive || batchReconcilePending;
  batchButton.disabled = !downloadsReady || blocked || !terminal;
  cancelBatchButton.disabled = blocked;
  for (const action of batchList.querySelectorAll(".item-action")) {
    const item = action.closest(".batch-item")?.currentItem;
    action.disabled = blocked || !item || !["ready", "error", "cancelled"].includes(item.state);
  }
}

function setBatchMutationActive(active) {
  batchMutationActive = active;
  syncBatchControls();
}

function setStatus(target, message, type = "error") {
  target.textContent = message;
  target.className = `status ${type}`;
  target.hidden = !message;
}

async function token() {
  if (accessToken) return accessToken;
  const { data, error } = await authClient.token();
  if (error || !data?.token) throw new Error("Sua sessão expirou. Entre novamente.");
  accessToken = data.token;
  return accessToken;
}

async function api(path, options = {}) {
  const publicRequest = path === "/api/health" || path === "/api/inspect";
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (!publicRequest) headers.authorization = `Bearer ${await token()}`;
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) accessToken = null;
    const error = new Error(data.error || "Não foi possível concluir essa ação.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJob(id) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await api(`/api/jobs/${id}/run`, { method: "POST", body: "{}" });
    } catch (error) {
      if (error.status !== 429 || attempt === 7) throw error;
      await delay(3_000);
    }
  }
}

async function requestDownload(path) {
  const result = await api(path, { method: "POST", body: "{}" });
  window.location.assign(result.url);
}

function startBatchRuns(batch) {
  const generation = ++batchRunGeneration;
  const queue = batch.items.filter((item) => item.state === "queued").map((item) => item.id);
  const workerCount = Math.min(batch.concurrency || 3, queue.length);

  async function worker() {
    while (queue.length && generation === batchRunGeneration) {
      const id = queue.shift();
      try {
        await runJob(id);
      } catch (error) {
        setStatus(batchStatusBox, `${error.message} A fila continuará com as demais faixas.`, "warning");
      }
    }
  }

  Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => {
    if (generation === batchRunGeneration && currentBatchId === batch.id) forceBatchRefresh(batch.id, 100);
  });
}

function setAuthMode(mode) {
  authMode = mode;
  const signingUp = mode === "sign-up";
  signInTab.classList.toggle("is-active", !signingUp);
  signUpTab.classList.toggle("is-active", signingUp);
  nameField.hidden = !signingUp;
  document.querySelector("#auth-name").required = signingUp;
  document.querySelector("#auth-password").autocomplete = signingUp ? "new-password" : "current-password";
  authSubmit.textContent = signingUp ? "Criar conta" : "Entrar no FITA";
  setStatus(authStatus, "");
}

function openAuth({ action = null, intent = "Entre para acessar sua conta e seus downloads privados." } = {}) {
  pendingAuthAction = action;
  authFocusReturn = document.activeElement;
  authIntent.textContent = intent;
  authPanel.hidden = false;
  document.body.classList.add("auth-open");
  requestAnimationFrame(() => document.querySelector("#auth-email").focus());
}

function closeAuth({ keepAction = false } = {}) {
  authPanel.hidden = true;
  document.body.classList.remove("auth-open");
  setStatus(authStatus, "");
  if (!keepAction) pendingAuthAction = null;
  if (authFocusReturn instanceof HTMLElement) authFocusReturn.focus();
  authFocusReturn = null;
}

async function requireAuth(action, intent) {
  try {
    await token();
    return true;
  } catch {
    accessToken = null;
    openAuth({ action, intent });
    return false;
  }
}

function showAuthenticated(user) {
  accountEmail.textContent = user.email || "Conta FITA";
  accountEmail.hidden = false;
  openAuthButton.hidden = true;
  signOutButton.hidden = false;
}

function showSignedOut() {
  accessToken = null;
  accountEmail.hidden = true;
  openAuthButton.hidden = false;
  signOutButton.hidden = true;
}

openAuthButton.addEventListener("click", () => openAuth());
closeAuthButton.addEventListener("click", () => closeAuth());
authPanel.addEventListener("click", (event) => {
  if (event.target === authPanel) closeAuth();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !authPanel.hidden) closeAuth();
});
signInTab.addEventListener("click", () => setAuthMode("sign-in"));
signUpTab.addEventListener("click", () => setAuthMode("sign-up"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authSubmit.disabled = true;
  setStatus(authStatus, authMode === "sign-up" ? "Criando sua conta…" : "Entrando…", "loading");
  const email = document.querySelector("#auth-email").value.trim();
  const password = document.querySelector("#auth-password").value;
  try {
    const result = authMode === "sign-up"
      ? await authClient.signUp.email({ email, password, name: document.querySelector("#auth-name").value.trim() })
      : await authClient.signIn.email({ email, password });
    if (result.error) throw new Error(result.error.message || "Não foi possível autenticar.");
    const session = await authClient.getSession();
    if (!session.data?.user) {
      setStatus(authStatus, "Conta criada. Confira seu e-mail para confirmar o acesso e depois entre.", "success");
      setAuthMode("sign-in");
      return;
    }
    accessToken = null;
    await token();
    showAuthenticated(session.data.user);
    const action = pendingAuthAction;
    closeAuth({ keepAction: true });
    pendingAuthAction = null;
    if (action) queueMicrotask(action);
  } catch (error) {
    setStatus(authStatus, error.message || "Não foi possível autenticar.");
  } finally {
    authSubmit.disabled = false;
  }
});

signOutButton.addEventListener("click", async () => {
  signOutButton.disabled = true;
  try {
    await authClient.signOut();
  } finally {
    showSignedOut();
    signOutButton.disabled = false;
  }
});

function switchMode(mode) {
  const showBatch = mode === "batch";
  document.querySelector("#single-mode").hidden = showBatch;
  document.querySelector("#batch-mode").hidden = !showBatch;
  singleTab.classList.toggle("is-active", !showBatch);
  batchTab.classList.toggle("is-active", showBatch);
  singleTab.setAttribute("aria-selected", String(!showBatch));
  batchTab.setAttribute("aria-selected", String(showBatch));
}

singleTab.addEventListener("click", () => switchMode("single"));
batchTab.addEventListener("click", () => switchMode("batch"));
for (const tab of [singleTab, batchTab]) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const next = tab === singleTab ? batchTab : singleTab;
    next.focus();
    next.click();
  });
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
  if (!downloadsReady) {
    setStatus(statusBox, "A fila híbrida ainda está sendo preparada. Tente novamente em instantes.", "warning");
    return;
  }
  if (singleJobActive) return;
  clearTimeout(pollTimer);
  trackCard.hidden = true;
  progressCard.hidden = true;
  selectedUrl = urlInput.value.trim();
  setStatus(statusBox, "Buscando informações do vídeo…", "loading");
  searchButton.disabled = true;
  try {
    const track = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({ url: selectedUrl }),
    });
    setStatus(statusBox, "");
    showTrack(track);
  } catch (error) {
    setStatus(statusBox, error.message);
  } finally {
    searchButton.disabled = false;
  }
});

downloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedUrl) return;
  if (!downloadsReady) {
    setStatus(statusBox, "A fila híbrida ainda está sendo preparada. Tente novamente em instantes.", "warning");
    return;
  }
  if (!await requireAuth(
    startSingleDownload,
    "Entre ou crie sua conta para baixar esta faixa. Depois do acesso, o download começa automaticamente.",
  )) return;
  startSingleDownload();
});

async function startSingleDownload() {
  if (singleJobActive || !selectedUrl) return;
  singleJobActive = true;
  downloadButton.disabled = true;
  searchButton.disabled = true;
  urlInput.disabled = true;
  setStatus(statusBox, "");
  progressCard.hidden = false;
  document.querySelector("#progress-title").textContent = "Entrando na fila…";
  updateProgress({ state: "queued", progress: 0, speed: null, eta: null });
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
    setStatus(statusBox, error.message);
    downloadButton.disabled = false;
    searchButton.disabled = false;
    urlInput.disabled = false;
    singleJobActive = false;
  }
}

function updateProgress(job) {
  const percent = Math.round(job.progress || 0);
  document.querySelector("#progress-value").textContent = `${percent}%`;
  document.querySelector("#progress-bar").style.width = `${percent}%`;
  document.querySelector("#single-progress-track").setAttribute("aria-valuenow", String(percent));
  const details = [];
  if (job.state === "queued" || job.state === "starting") {
    document.querySelector("#progress-title").textContent = "Aguardando o Mac processador…";
    details.push("A tarefa continuará automaticamente quando o Mac estiver conectado");
  } else if (job.state === "downloading") {
    document.querySelector("#progress-title").textContent = "Baixando e convertendo…";
  }
  if (job.speed) details.push(job.speed);
  if (job.eta) details.push(`faltam ${job.eta}`);
  document.querySelector("#progress-detail").textContent = details.join(" · ") || "Baixando e convertendo…";
}

async function pollJob(id) {
  try {
    const job = await api(`/api/jobs/${id}`);
    updateProgress(job);
    if (job.state === "ready") {
      document.querySelector("#progress-title").textContent = "Faixa pronta. Iniciando download…";
      document.querySelector("#progress-detail").textContent = job.filename;
      await requestDownload(job.downloadUrl);
      downloadButton.disabled = false;
      searchButton.disabled = false;
      urlInput.disabled = false;
      singleJobActive = false;
      return;
    }
    if (job.state === "error") throw new Error(job.error || "O download não pôde ser concluído.");
    pollTimer = setTimeout(() => pollJob(id), 700);
  } catch (error) {
    progressCard.hidden = true;
    setStatus(statusBox, error.message);
    downloadButton.disabled = false;
    searchButton.disabled = false;
    urlInput.disabled = false;
    singleJobActive = false;
  }
}

batchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!downloadsReady) {
    setStatus(batchStatusBox, "A fila híbrida ainda está sendo preparada. Tente novamente em instantes.", "warning");
    return;
  }
  if (batchMutationActive || batchReconcilePending) return;
  if (!await requireAuth(
    startBatchDownload,
    "Entre ou crie sua conta para iniciar o lote. Sua lista será retomada automaticamente após o acesso.",
  )) return;
  startBatchDownload();
});

async function startBatchDownload() {
  if (batchMutationActive || batchReconcilePending) return;
  const hadBatch = Boolean(lastBatch);
  setBatchMutationActive(true);
  if (!hadBatch) {
    archiveLink.hidden = true;
    cancelBatchButton.hidden = true;
    batchList.replaceChildren();
    batchProgress.hidden = false;
    renderBatchHeader({ state: "resolving", progress: 0, counts: { total: 0, queued: 0, running: 0, ready: 0, error: 0, cancelled: 0 } });
  }
  setStatus(batchStatusBox, "Lendo os links e expandindo playlists…", "loading");
  try {
    const batch = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        sources: document.querySelector("#batch-urls").value,
        format: document.querySelector("#batch-format").value,
        quality: document.querySelector("#batch-quality").value,
        concurrency: document.querySelector("#batch-concurrency").value,
      }),
    });
    clearTimeout(batchPollTimer);
    batchPollRevision += 1;
    batchList.replaceChildren();
    batchProgress.hidden = false;
    currentBatchId = batch.id;
    renderBatch(batch);
    batchProgress.scrollIntoView({ behavior: "smooth", block: "start" });
    scheduleBatchPoll(batch);
  } catch (error) {
    if (!hadBatch) batchProgress.hidden = true;
    setStatus(batchStatusBox, error.message);
  } finally {
    setBatchMutationActive(false);
  }
}

function renderBatchHeader(batch) {
  const titles = {
    resolving: "Lendo links e playlists…",
    queued: "Faixas na fila…",
    running: "Baixando em paralelo…",
    cancelling: "Encerrando downloads…",
    completed: "Mixtape pronta.",
    completed_with_errors: "Lote concluído com avisos.",
    error: "Nenhuma faixa foi concluída.",
    cancelled: "Lote cancelado.",
  };
  const percent = Math.round(batch.progress || 0);
  document.querySelector("#batch-progress-title").textContent = titles[batch.state] || "Organizando a fila…";
  document.querySelector("#batch-progress-value").textContent = `${percent}%`;
  document.querySelector("#batch-progress-bar").style.width = `${percent}%`;
  document.querySelector("#batch-progress-track").setAttribute("aria-valuenow", String(percent));

  const counts = batch.counts;
  const countBox = document.querySelector("#batch-counts");
  const values = [
    ["total", counts.total, "faixas"],
    ["running", counts.running, "baixando"],
    ["ready", counts.ready, "prontas"],
    ["error", counts.error, "falhas"],
  ];
  const signature = values.map(([, value]) => value).join(":");
  if (countBox.dataset.signature !== signature) {
    countBox.dataset.signature = signature;
    countBox.replaceChildren(...values.map(([kind, value, label]) => {
      const item = document.createElement("span");
      item.dataset.kind = kind;
      item.textContent = `${value} ${label}`;
      return item;
    }));
  }
}

function itemDetail(item) {
  if (item.state === "queued") return "Aguardando uma vaga";
  if (item.state === "starting") return "Preparando o download";
  if (item.state === "downloading") {
    return [item.speed, item.eta ? `faltam ${item.eta}` : null].filter(Boolean).join(" · ") || "Baixando e convertendo";
  }
  if (item.state === "ready") return item.filename || "Arquivo pronto";
  if (item.state === "error") return item.error || "Não foi possível baixar esta faixa";
  if (item.state === "cancelled") return "Removida da fila";
  return "Encerrando o processo";
}

function buildBatchItem() {
  const row = document.createElement("li");
  row.className = "batch-item";

  const number = document.createElement("span");
  number.className = "batch-number";

  const content = document.createElement("div");
  content.className = "batch-item-copy";
  const top = document.createElement("div");
  top.className = "batch-item-top";
  const title = document.createElement("h3");
  const state = document.createElement("span");
  state.className = "item-state";
  top.append(title, state);

  const detail = document.createElement("p");
  const meter = document.createElement("div");
  meter.className = "item-meter";
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("span");
  meter.append(fill);
  content.append(top, detail, meter);

  const action = document.createElement("button");
  action.className = "item-action";
  action.type = "button";
  action.addEventListener("click", async () => {
    const item = row.currentItem;
    if (!item) return;
    if (item.state === "ready") {
      action.disabled = true;
      try {
        await requestDownload(item.downloadUrl);
      } catch (error) {
        setStatus(batchStatusBox, error.message);
      } finally {
        action.disabled = false;
      }
    }
    else if (["error", "cancelled"].includes(item.state)) retryBatchItem(row.batchId, item.id, action);
  });

  row.append(number, content, action);
  return row;
}

function updateBatchItem(row, item, index, batchId) {
  row.dataset.id = item.id;
  row.dataset.state = item.state;
  row.currentItem = item;
  row.batchId = batchId;
  row.querySelector(".batch-number").textContent = String(index + 1).padStart(2, "0");
  row.querySelector("h3").textContent = item.title;
  row.querySelector(".item-state").textContent = STATE_LABELS[item.state] || item.state;
  row.querySelector(".batch-item-copy > p").textContent = itemDetail(item);
  const percent = Math.round(item.progress || 0);
  const meter = row.querySelector(".item-meter");
  meter.setAttribute("aria-label", `${percent}% concluído`);
  meter.setAttribute("aria-valuenow", String(percent));
  meter.querySelector("span").style.width = `${percent}%`;
  const action = row.querySelector(".item-action");
  if (item.state === "ready") {
    action.disabled = false;
    action.textContent = "Baixar";
  } else if (["error", "cancelled"].includes(item.state)) {
    action.disabled = false;
    action.textContent = "Tentar de novo";
  } else {
    action.disabled = true;
    action.textContent = `${percent}%`;
  }
}

function renderBatchItems(batch) {
  const existing = new Map([...batchList.children].map((row) => [row.dataset.id, row]));
  batch.items.forEach((item, index) => {
    const row = existing.get(item.id) || buildBatchItem();
    existing.delete(item.id);
    updateBatchItem(row, item, index, batch.id);
    const currentAtIndex = batchList.children[index];
    if (currentAtIndex !== row) batchList.insertBefore(row, currentAtIndex || null);
  });
  for (const row of existing.values()) row.remove();
}

function renderBatch(batch) {
  lastBatch = batch;
  renderBatchHeader(batch);
  renderBatchItems(batch);

  const messages = [];
  if (batch.truncated) messages.push("O lote atingiu o limite de 50 faixas; o restante não entrou na fila.");
  if (batch.sourceErrors?.length) {
    const firstError = batch.sourceErrors[0]?.message || batch.sourceErrors[0];
    messages.push(`${batch.sourceErrors.length} link ou playlist não pôde ser lido. ${firstError}`);
  }
  if (batch.error) messages.push(batch.error);
  const terminal = TERMINAL_BATCH_STATES.has(batch.state);
  if (messages.length) setStatus(batchStatusBox, messages.join(" "), "warning");
  else if (batch.state === "resolving") setStatus(batchStatusBox, "Lendo os links e expandindo playlists…", "loading");
  else if (terminal && batch.counts.ready) setStatus(batchStatusBox, `${batch.counts.ready} arquivo${batch.counts.ready === 1 ? " está" : "s estão"} pronto${batch.counts.ready === 1 ? "" : "s"} para salvar.`, "success");
  else setStatus(batchStatusBox, "");

  archiveLink.hidden = !batch.archiveUrl;
  if (batch.archiveUrl) archiveLink.href = batch.archiveUrl;
  cancelBatchButton.hidden = terminal;
  syncBatchControls();
}

function scheduleBatchPoll(batch) {
  clearTimeout(batchPollTimer);
  if (TERMINAL_BATCH_STATES.has(batch.state)) return;
  const revision = ++batchPollRevision;
  batchPollTimer = setTimeout(() => pollBatch(batch.id, revision), 850);
}

function forceBatchRefresh(id, delay = 500) {
  if (!id) return;
  batchReconcilePending = true;
  syncBatchControls();
  clearTimeout(batchPollTimer);
  const revision = ++batchPollRevision;
  batchPollTimer = setTimeout(() => pollBatch(id, revision), delay);
}

async function pollBatch(id, revision) {
  if (id !== currentBatchId || revision !== batchPollRevision) return;
  try {
    const batch = await api(`/api/batches/${id}`);
    if (revision !== batchPollRevision) return;
    batchReconcilePending = false;
    renderBatch(batch);
    scheduleBatchPoll(batch);
  } catch (error) {
    if (revision !== batchPollRevision) return;
    if (error.status === 404) {
      currentBatchId = null;
      lastBatch = null;
      batchReconcilePending = false;
      batchProgress.hidden = true;
      cancelBatchButton.hidden = true;
      setStatus(batchStatusBox, "O servidor foi reiniciado e este lote não está mais disponível. Inicie um novo lote.", "warning");
      syncBatchControls();
      return;
    }
    setStatus(batchStatusBox, `${error.message} Tentando reconectar…`, "warning");
    const nextRevision = ++batchPollRevision;
    batchPollTimer = setTimeout(() => pollBatch(id, nextRevision), 2_000);
  }
}

cancelBatchButton.addEventListener("click", async () => {
  if (!currentBatchId || batchMutationActive || batchReconcilePending) return;
  setBatchMutationActive(true);
  batchRunGeneration += 1;
  clearTimeout(batchPollTimer);
  batchPollRevision += 1;
  try {
    const batch = await api(`/api/batches/${currentBatchId}/cancel`, {
      method: "POST",
      body: "{}",
    });
    renderBatch(batch);
    scheduleBatchPoll(batch);
  } catch (error) {
    if (error.status === 404) {
      currentBatchId = null;
      lastBatch = null;
      batchProgress.hidden = true;
      cancelBatchButton.hidden = true;
      setStatus(batchStatusBox, "O servidor foi reiniciado e este lote não está mais disponível. Inicie um novo lote.", "warning");
    } else {
      setStatus(batchStatusBox, `${error.message} O acompanhamento continuará automaticamente.`, "warning");
      if (!error.status || error.status >= 500) forceBatchRefresh(currentBatchId);
      else if (currentBatchId && lastBatch) scheduleBatchPoll(lastBatch);
    }
  } finally {
    setBatchMutationActive(false);
  }
});

async function retryBatchItem(batchId, itemId, button) {
  if (batchMutationActive || batchReconcilePending) return;
  setBatchMutationActive(true);
  clearTimeout(batchPollTimer);
  batchPollRevision += 1;
  try {
    const batch = await api(`/api/batches/${batchId}/items/${itemId}/retry`, {
      method: "POST",
      body: "{}",
    });
    currentBatchId = batch.id;
    renderBatch(batch);
    scheduleBatchPoll(batch);
  } catch (error) {
    if (error.status === 404) {
      currentBatchId = null;
      lastBatch = null;
      batchReconcilePending = false;
      batchProgress.hidden = true;
      cancelBatchButton.hidden = true;
      setStatus(batchStatusBox, "O servidor foi reiniciado e este lote não está mais disponível. Inicie um novo lote.", "warning");
    } else {
      setStatus(batchStatusBox, error.message);
      if (!error.status || error.status >= 500) forceBatchRefresh(batchId);
      else if (currentBatchId && lastBatch) scheduleBatchPoll(lastBatch);
    }
  } finally {
    setBatchMutationActive(false);
  }
}

archiveLink.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!lastBatch?.archiveUrl || archiveLink.getAttribute("aria-disabled") === "true") return;
  archiveLink.setAttribute("aria-disabled", "true");
  setStatus(batchStatusBox, "Montando o ZIP privado…", "loading");
  try {
    await requestDownload(lastBatch.archiveUrl);
    setStatus(batchStatusBox, "ZIP pronto. O download começou.", "success");
  } catch (error) {
    setStatus(batchStatusBox, error.message);
  } finally {
    archiveLink.removeAttribute("aria-disabled");
  }
});

function setupAds() {
  const clientId = String(adsenseClientId || "").trim();
  const placements = [...document.querySelectorAll("[data-ad-slot-key]")];
  const validClient = /^ca-pub-\d+$/.test(clientId);
  const livePlacements = placements.filter((placement) => /^\d+$/.test(String(adsenseSlots[placement.dataset.adSlotKey] || "")));
  if (!validClient || !livePlacements.length) return;

  for (const placement of livePlacements) {
    const ad = document.createElement("ins");
    ad.className = "adsbygoogle";
    ad.dataset.adClient = clientId;
    ad.dataset.adSlot = adsenseSlots[placement.dataset.adSlotKey];
    ad.dataset.adFormat = "auto";
    ad.dataset.fullWidthResponsive = "true";
    placement.dataset.adState = "loading";
    placement.replaceChildren(ad);
  }

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(clientId)}`;
  script.addEventListener("load", () => {
    window.adsbygoogle = window.adsbygoogle || [];
    for (const placement of livePlacements) {
      try {
        window.adsbygoogle.push({});
        placement.dataset.adState = "live";
      } catch {
        placement.dataset.adState = "error";
        placement.innerHTML = "<p>Publicidade temporariamente indisponível</p>";
      }
    }
  });
  script.addEventListener("error", () => {
    for (const placement of livePlacements) {
      placement.dataset.adState = "error";
      placement.innerHTML = "<p>Publicidade temporariamente indisponível</p>";
    }
  });
  document.head.append(script);
}

setupAds();

async function refreshHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    if (!response.ok) throw new Error("health unavailable");
    downloadsReady = Boolean(health.downloadsReady);
    runtimeBadge.classList.toggle("is-paused", !downloadsReady || !health.workerOnline);
    const label = !downloadsReady
      ? " Online · fila indisponível"
      : health.workerOnline
        ? " Online · Mac conectado"
        : " Online · aguardando o Mac";
    runtimeBadge.replaceChildren(document.createElement("span"), document.createTextNode(label));
    searchButton.disabled = !downloadsReady;
    syncBatchControls();
    if (!downloadsReady) {
      const message = "O site está online, mas a fila híbrida ainda não foi configurada.";
      setStatus(statusBox, message, "warning");
      setStatus(batchStatusBox, message, "warning");
    } else if (!health.workerOnline) {
      const message = "O Mac processador está desconectado. Você pode entrar na fila; o processamento começa quando ele voltar.";
      if (!singleJobActive) setStatus(statusBox, message, "warning");
      if (!lastBatch) setStatus(batchStatusBox, message, "warning");
    } else {
      if (!singleJobActive && statusBox.classList.contains("warning")) setStatus(statusBox, "");
      if (!lastBatch && batchStatusBox.classList.contains("warning")) setStatus(batchStatusBox, "");
      if (!health.zip) setStatus(batchStatusBox, "O download em ZIP está temporariamente indisponível.", "warning");
    }
  } catch {
    downloadsReady = false;
    searchButton.disabled = true;
    syncBatchControls();
    setStatus(statusBox, "O serviço online não respondeu. Tente recarregar a página.");
  }
}

refreshHealth();
setInterval(refreshHealth, 20_000);

authClient.getSession()
  .then(async ({ data }) => {
    if (!data?.user) {
      showSignedOut();
      return;
    }
    await token();
    showAuthenticated(data.user);
  })
  .catch(() => showSignedOut());
