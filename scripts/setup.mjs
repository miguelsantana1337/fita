import { spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = path.join(root, ".tools");
const target = path.join(toolsDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const temporary = `${target}.download`;

function available(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function releaseAsset() {
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
    if (process.arch === "arm") return "yt-dlp_linux_armv7l";
    return "yt-dlp_linux";
  }
  throw new Error(`Sistema não suportado automaticamente: ${process.platform}/${process.arch}`);
}

console.log("Preparando o FITA…");

if (!available("ffmpeg", ["-version"])) {
  console.error("\nFFmpeg não foi encontrado. No macOS com Homebrew, execute: brew install ffmpeg");
  process.exit(1);
}

try {
  const asset = releaseAsset();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`Baixando a versão oficial mais recente do yt-dlp para ${process.platform}/${process.arch}…`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download retornou HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error("arquivo recebido é menor do que o esperado");
  await mkdir(toolsDir, { recursive: true });
  await writeFile(temporary, bytes, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(temporary, 0o755);
  await rm(target, { force: true });
  await rename(temporary, target);
  const version = spawnSync(target, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error("o executável baixado não iniciou corretamente");
  console.log(`yt-dlp ${version.stdout.trim()} instalado.`);
  console.log("\nTudo pronto. Agora execute npm start.");
} catch (error) {
  await rm(temporary, { force: true });
  console.error(`\nNão foi possível instalar o yt-dlp: ${error.message}`);
  process.exit(1);
}
