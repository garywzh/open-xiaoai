import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";

import type { OpenClawBridgeConfig } from "./types.js";

const CONTENT_TYPES = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
]);

export function resolveMediaRoot(config: OpenClawBridgeConfig["media"]) {
  return path.resolve(process.cwd(), config.rootDir);
}

export function resolveMediaFilePath(config: OpenClawBridgeConfig["media"], file: string) {
  const rootDir = resolveMediaRoot(config);
  const safeRelativePath = path.normalize(file).replace(/^([.]{2}[\\/])+/, "");
  const absolutePath = path.resolve(rootDir, safeRelativePath);

  if (!absolutePath.startsWith(rootDir)) {
    throw new Error("invalid media path");
  }

  return {
    rootDir,
    relativePath: safeRelativePath.replace(/\\/g, "/"),
    absolutePath,
  };
}

export function resolveMediaBaseURL(config: OpenClawBridgeConfig["media"]) {
  if (config.publicOrigin?.trim()) {
    return config.publicOrigin.replace(/\/$/, "");
  }

  const ip = detectLanIPv4();
  return `http://${ip}:${config.port}`;
}

export function resolveMediaFileURL(config: OpenClawBridgeConfig["media"], file: string) {
  const { relativePath } = resolveMediaFilePath(config, file);
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${resolveMediaBaseURL(config)}/media/${encodedPath}`;
}

export function detectLanIPv4() {
  const interfaces = networkInterfaces();
  for (const interfaceItems of Object.values(interfaces)) {
    for (const item of interfaceItems ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        return item.address;
      }
    }
  }
  return "127.0.0.1";
}

export function getContentType(filePath: string) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

export async function listMediaFiles(config: OpenClawBridgeConfig["media"]) {
  const rootDir = resolveMediaRoot(config);
  return walkMediaDirectory(rootDir, rootDir);
}

async function walkMediaDirectory(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMediaDirectory(rootDir, absolutePath)));
      continue;
    }

    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
    files.push(relativePath);
  }

  return files.sort();
}

export async function ensureMediaFileReadable(config: OpenClawBridgeConfig["media"], file: string) {
  const resolved = resolveMediaFilePath(config, file);
  const fileStat = await stat(resolved.absolutePath);
  if (!fileStat.isFile()) {
    throw new Error("media target is not a file");
  }
  return resolved;
}

export function createMediaReadStream(filePath: string) {
  return createReadStream(filePath);
}
