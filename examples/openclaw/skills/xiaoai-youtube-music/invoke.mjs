#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const openclawDir = path.resolve(baseDir, "../..");
const mediaRoot = resolveMediaRoot(process.env.OPEN_XIAOAI_MEDIA_ROOT || "./media");
const subDir = normalizeRelativeDir(process.env.XIAOAI_YOUTUBE_SUBDIR || "music/youtube");
const cacheDir = path.join(mediaRoot, subDir);
const indexPath = path.join(cacheDir, ".cache-index.json");

const { command, options } = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  switch (command) {
    case "inspect": {
      const query = requireOption(options.query, "query");
      const result = await inspectTrack(query);
      printJson({ command, ...result });
      return;
    }
    case "ensure": {
      const query = requireOption(options.query, "query");
      const sourceUrl = requireOption(options.url, "url");
      const result = await ensureTrack(query, sourceUrl);
      printJson({ command, ...result });
      return;
    }
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function inspectTrack(rawQuery) {
  const normalizedQuery = normalizeQuery(rawQuery);
  const cacheKey = buildCacheKey(normalizedQuery);
  const target = buildTarget(normalizedQuery, cacheKey);
  const index = await readIndex();
  const indexedEntry = index.tracks[cacheKey];

  if (indexedEntry?.file) {
    const indexedPath = path.join(mediaRoot, indexedEntry.file);
    if (existsSync(indexedPath)) {
      return buildResult({
        cached: true,
        normalizedQuery,
        cacheKey,
        file: normalizeRelativePath(indexedEntry.file),
        absolutePath: indexedPath,
        sourceUrl: indexedEntry.sourceUrl,
      });
    }
  }

  if (existsSync(target.absolutePath)) {
    index.tracks[cacheKey] = {
      file: target.file,
      normalizedQuery,
      updatedAt: new Date().toISOString(),
    };
    await writeIndex(index);

    return buildResult({
      cached: true,
      normalizedQuery,
      cacheKey,
      file: target.file,
      absolutePath: target.absolutePath,
    });
  }

  return buildResult({
    cached: false,
    normalizedQuery,
    cacheKey,
    file: target.file,
    absolutePath: target.absolutePath,
  });
}

async function ensureTrack(rawQuery, sourceUrl) {
  validateYouTubeURL(sourceUrl);

  const inspected = await inspectTrack(rawQuery);
  if (inspected.cached) {
    return {
      ...inspected,
      ready: true,
      downloaded: false,
      sourceUrl: inspected.sourceUrl || sourceUrl,
    };
  }

  await mkdir(cacheDir, { recursive: true });
  await assertCommandAvailable("yt-dlp", ["--version"]);
  await assertCommandAvailable("ffmpeg", ["-version"]);

  const proxy = resolveProxy(options.proxy ?? process.env.XIAOAI_YTDLP_PROXY);
  const stem = path.basename(inspected.absolutePath, ".mp3");
  const tempBase = path.join(cacheDir, `${stem}.tmp-${Date.now()}`);
  const outputTemplate = `${tempBase}.%(ext)s`;

  const ytDlpArgs = [
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--no-playlist",
    "--no-progress",
    "--newline",
    "--no-keep-video",
    "-o",
    outputTemplate,
    sourceUrl,
  ];

  if (proxy) {
    ytDlpArgs.unshift(proxy);
    ytDlpArgs.unshift("--proxy");
  }

  await runCommand("yt-dlp", ytDlpArgs);

  const tempMp3 = `${tempBase}.mp3`;
  if (!existsSync(tempMp3)) {
    throw new Error(`yt-dlp did not produce expected mp3: ${tempMp3}`);
  }

  if (existsSync(inspected.absolutePath)) {
    await rm(tempMp3, { force: true });
  } else {
    await rename(tempMp3, inspected.absolutePath);
  }

  const index = await readIndex();
  index.tracks[inspected.cacheKey] = {
    file: inspected.file,
    normalizedQuery: inspected.normalizedQuery,
    sourceUrl,
    updatedAt: new Date().toISOString(),
  };
  await writeIndex(index);

  return {
    ...inspected,
    cached: false,
    ready: true,
    downloaded: true,
    sourceUrl,
  };
}

function buildResult({ cached, normalizedQuery, cacheKey, file, absolutePath, sourceUrl }) {
  return {
    cached,
    ready: cached,
    normalizedQuery,
    cacheKey,
    file: normalizeRelativePath(file),
    absolutePath,
    mediaRoot,
    sourceUrl,
  };
}

function normalizeQuery(value) {
  const compact = value
    .normalize("NFKC")
    .replace(/[，。！？、,.!?]+$/g, "")
    .replace(/^(请|麻烦你)?\s*(帮我|给我)?\s*(播放|放一下|放|来一首|来首|来个|播一下)\s*/u, "")
    .trim();

  if (!compact) {
    throw new Error("query is empty after normalization");
  }
  return compact.replace(/\s+/g, " ");
}

function buildCacheKey(normalizedQuery) {
  return createHash("sha1").update(normalizedQuery).digest("hex").slice(0, 12);
}

function buildTarget(normalizedQuery, cacheKey) {
  const safeStem = toSafeStem(normalizedQuery);
  const fileName = `${safeStem}-${cacheKey}.mp3`;
  const file = normalizeRelativePath(path.posix.join(subDir.replace(/\\/g, "/"), fileName));
  const absolutePath = path.join(mediaRoot, file);
  return { file, absolutePath };
}

function toSafeStem(value) {
  const stem = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return stem || "track";
}

async function readIndex() {
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.tracks && typeof parsed.tracks === "object") {
      return { version: 1, tracks: parsed.tracks };
    }
  } catch {}
  return { version: 1, tracks: {} };
}

async function writeIndex(index) {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function resolveMediaRoot(rawValue) {
  const value = rawValue.trim();
  if (!value) {
    return path.join(openclawDir, "media");
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(openclawDir, value);
}

function normalizeRelativeDir(value) {
  return normalizeRelativePath(value).replace(/^\.+\//, "").replace(/^\//, "");
}

function normalizeRelativePath(value) {
  return value.replace(/\\/g, "/").replace(/^\//, "");
}

function resolveProxy(rawValue) {
  const value = rawValue == null ? "http://127.0.0.1:7890" : String(rawValue).trim();
  if (!value) {
    return "http://127.0.0.1:7890";
  }
  if (["0", "off", "false", "none", "no"].includes(value.toLowerCase())) {
    return undefined;
  }
  return value;
}

async function assertCommandAvailable(commandName, args) {
  try {
    await runCommand(commandName, args, { quiet: true });
  } catch (error) {
    throw new Error(`${commandName} is required: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runCommand(commandName, args, options = {}) {
  const { quiet = false } = options;
  await new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.on("error", reject);

    if (!quiet) {
      child.stdout.on("data", (chunk) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${commandName} exited with code ${code}`));
    });
  });
}

function validateYouTubeURL(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("url must be a valid URL");
  }

  const host = parsed.hostname.toLowerCase();
  if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be")) {
    throw new Error("url must point to YouTube");
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`unknown argument: ${token}`);
    }
    const name = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }

  return { command, options };
}

function requireOption(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printUsage() {
  console.log(`Usage:
  node invoke.mjs inspect --query "许嵩 素颜"
  node invoke.mjs ensure --query "许嵩 素颜" --url "https://www.youtube.com/watch?v=..."

Environment:
  OPEN_XIAOAI_MEDIA_ROOT   default: ./media (relative to examples/openclaw)
  XIAOAI_YTDLP_PROXY       default: http://127.0.0.1:7890
  XIAOAI_YOUTUBE_SUBDIR    default: music/youtube`);
}
