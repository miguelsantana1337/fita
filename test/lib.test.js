import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  normalizeYoutubeUrl,
  parseProgressLine,
  safeDownloadName,
  validateDownloadOptions,
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
