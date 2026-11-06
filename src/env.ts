/**
 * Load .env from the project root into process.env before any other module
 * reads it. ai.ts and db.ts read their settings (ANTHROPIC_API_KEY,
 * XLIKES_*) when they are imported, so every entry point imports this module
 * first. Variables already set in the environment win over the file.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".env");
try {
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);
} catch {
  /* ignore: the environment may already be set another way */
}
