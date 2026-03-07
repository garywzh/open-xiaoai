import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kProjectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function resolveProjectRoot() {
  return kProjectRoot;
}

export function loadProjectEnv(options?: { projectRoot?: string; files?: string[] }) {
  const projectRoot = options?.projectRoot ?? kProjectRoot;
  const files = options?.files ?? [".env", ".env.local"];
  const inheritedKeys = new Set(Object.keys(process.env));
  const loadedKeys = new Set<string>();
  const loadedFiles: string[] = [];

  for (const file of files) {
    const filePath = path.resolve(projectRoot, file);
    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (inheritedKeys.has(key) && !loadedKeys.has(key)) {
        continue;
      }

      process.env[key] = value;
      loadedKeys.add(key);
    }

    loadedFiles.push(filePath);
  }

  return loadedFiles;
}

function parseEnvFile(source: string) {
  const entries: Record<string, string> = {};
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    entries[key] = normalizeEnvValue(rawValue);
  }

  return entries;
}

function normalizeEnvValue(rawValue: string) {
  const value = rawValue.trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, "").trim();
}
