import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  isPlaylistUrl,
  normalizeBatchSources,
  normalizeYoutubeUrl,
  parseProgressLine,
  safeDownloadName,
  validateConcurrency,
  validateDownloadOptions,
  youtubeIdentity,
} from "../src/lib.js";

test("aceita URLs conhecidas do YouTube", () => {
  assert.equal(normalizeYoutubeUrl("https://youtu.be/abc123"), "https://youtu.be/abc123");
  assert.match(normalizeYoutubeUrl("http://music.youtube.com/watch?v=abc"), /^https:/);
});

test("rejeita hosts externos e protocolos perigosos", () => {
  assert.throws(() => normalizeYoutubeUrl("https://example.com/watch?v=abc"), /apenas links do YouTube/);
  assert.throws(() => normalizeYoutubeUrl("file:///etc/passwd"), /http ou https/);
});

test("valida formato e qualidade", () => {
  assert.deepEqual(validateDownloadOptions("mp3", "192"), { format: "mp3", quality: "192" });
  assert.throws(() => validateDownloadOptions("wav", "192"), /formato/);
  assert.throws(() => validateDownloadOptions("mp3", "999"), /qualidade/);
});

test("formata duração", () => {
  assert.equal(formatDuration(185), "3:05");
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(undefined), null);
});

test("interpreta o progresso do yt-dlp", () => {
  assert.deepEqual(parseProgressLine("download: 42.5%| 1.2MiB/s|00:08"), {
    percent: 42.5,
    speed: "1.2MiB/s",
    eta: "00:08",
  });
  assert.equal(parseProgressLine("[download] outro texto"), null);
});

test("remove caracteres inseguros do nome final", () => {
  assert.equal(safeDownloadName('/tmp/Música "boa".mp3'), "Música _boa_.mp3");
});

test("normaliza lotes, preserva a ordem e remove vídeos duplicados", () => {
  assert.deepEqual(normalizeBatchSources(`
    https://youtu.be/abc123?si=origem

    https://www.youtube.com/watch?v=def456&utm_source=teste
    https://youtube.com/watch?v=abc123
  `), [
    "https://youtu.be/abc123?si=origem",
    "https://www.youtube.com/watch?v=def456&utm_source=teste",
  ]);
  assert.equal(youtubeIdentity("https://youtu.be/abc123"), "video:abc123");
  assert.equal(youtubeIdentity("https://youtube.com/watch?v=abc123"), "video:abc123");
  assert.equal(youtubeIdentity("https://youtube.com/watch?v=abc123&list=PLmix"), "playlist:PLmix");
});

test("valida entradas e o limite do lote", () => {
  assert.throws(() => normalizeBatchSources("\n\n"), /ao menos um link/);
  assert.throws(() => normalizeBatchSources("https://example.com/video"), /apenas links do YouTube/);
  assert.throws(() => normalizeBatchSources([
    "https://youtu.be/um",
    "https://youtu.be/dois",
  ], 1), /no máximo 1/);
});

test("identifica playlists e valida concorrência", () => {
  assert.equal(isPlaylistUrl("https://youtube.com/playlist?list=PL123"), true);
  assert.equal(isPlaylistUrl("https://youtube.com/watch?v=abc&list=PL123"), true);
  assert.equal(isPlaylistUrl("https://youtu.be/abc"), false);
  assert.equal(validateConcurrency(undefined), 3);
  assert.equal(validateConcurrency("4"), 4);
  assert.throws(() => validateConcurrency(0), /entre 1 e 4/);
  assert.throws(() => validateConcurrency(5), /entre 1 e 4/);
});

test("deduplica links diferentes que apontam para a mesma playlist", () => {
  assert.deepEqual(normalizeBatchSources([
    "https://youtube.com/watch?v=um&list=PLmix",
    "https://youtube.com/watch?v=dois&list=PLmix",
  ]), ["https://youtube.com/watch?v=um&list=PLmix"]);
});

test("mantém o progresso entre zero e cem", () => {
  assert.equal(parseProgressLine("download: -2%|NA|NA").percent, 0);
  assert.equal(parseProgressLine("download: 125%|NA|NA").percent, 100);
});
