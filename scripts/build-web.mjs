import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");
const outDir = path.join(root, "dist");

async function loadLocalEnv() {
  try {
    const text = await readFile(path.join(root, ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      if (process.env[key] !== undefined && process.env[key] !== "[SENSITIVE]") continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Vercel injects environment variables during the build.
  }
}

await loadLocalEnv();
const authUrl = process.env.NEON_AUTH_BASE_URL;
if (!authUrl) throw new Error("NEON_AUTH_BASE_URL is required to build the web client");

await mkdir(outDir, { recursive: true });
await Promise.all([
  cp(path.join(publicDir, "index.html"), path.join(outDir, "index.html")),
  cp(path.join(publicDir, "styles.css"), path.join(outDir, "styles.css")),
]);

await build({
  entryPoints: [path.join(publicDir, "app.js")],
  outfile: path.join(outDir, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  define: {
    __NEON_AUTH_URL__: JSON.stringify(authUrl),
  },
});
