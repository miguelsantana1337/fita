import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const envText = await readFile(path.join(root, ".env.local"), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator < 1 || line.trimStart().startsWith("#")) continue;
  const key = line.slice(0, separator).trim();
  if (process.env[key] !== undefined) continue;
  let value = line.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[key] = value;
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const sql = neon(process.env.DATABASE_URL);
const migration = await readFile(path.join(root, "migrations", "001_cloud_runtime.sql"), "utf8");
const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
for (const statement of statements) await sql.query(statement);
console.log(`Applied ${statements.length} migration statements.`);
