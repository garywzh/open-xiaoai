import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { listMediaFiles, resolveMediaFileURL, resolveMediaRoot } from "./media.js";
import type { XiaoAIMediaAssetConfig, XiaoAIMediaLibraryConfig } from "./types.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const kDefaultMatchLimit = 5;

type MediaLibraryTrack = {
  id: string;
  query: string;
  aliases: string[];
  title?: string;
  artist?: string;
  file: string;
  sourceUrl?: string;
  sourceHost?: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes?: number;
  durationSec?: number;
  managed?: boolean;
};

type MediaLibraryIndex = {
  version: 1;
  tracks: Record<string, MediaLibraryTrack>;
};

type MatchStatus = "hit" | "miss" | "ambiguous";

type MatchItem = ReturnType<OpenXiaoAIMediaLibrary["serializeTrack"]> & {
  matchScore: number;
};

export class OpenXiaoAIMediaLibrary {
  private readonly rootDir: string;
  private readonly downloadDir: string;
  private readonly indexPath: string;
  private readonly inflightEnsures = new Map<string, Promise<Record<string, unknown>>>();

  constructor(
    private readonly mediaConfig: XiaoAIMediaAssetConfig,
    private readonly libraryConfig: XiaoAIMediaLibraryConfig,
  ) {
    this.rootDir = resolveMediaRoot(mediaConfig);
    this.downloadDir = path.join(this.rootDir, normalizeRelativePath(libraryConfig.downloadSubdir));
    this.indexPath = path.join(this.rootDir, normalizeRelativePath(libraryConfig.indexFile));
  }

  async getStatus() {
    const index = await this.loadAndSyncIndex();
    return {
      ok: true,
      rootDir: this.rootDir,
      indexPath: this.indexPath,
      downloadDir: this.downloadDir,
      trackCount: Object.keys(index.tracks).length,
      proxy: resolveProxy(this.libraryConfig.proxy),
      cookiesPath: this.libraryConfig.cookiesPath,
      ytDlpBin: this.libraryConfig.ytDlpBin,
      ffmpegBin: this.libraryConfig.ffmpegBin,
      ffprobeBin: this.libraryConfig.ffprobeBin,
    };
  }

  async list(query = "", limit = 50) {
    const index = await this.loadAndSyncIndex();
    const normalizedQuery = query.trim() ? normalizeLookupText(query) : "";
    const items = this.rankTracks(index, normalizedQuery || undefined)
      .slice(0, clampLimit(limit, 200))
      .map((item) => this.serializeTrack(item.track, item.score));

    return {
      ok: true,
      query: query || undefined,
      normalizedQuery: normalizedQuery || undefined,
      total: items.length,
      items,
    };
  }

  async match(rawQuery: string, limit = kDefaultMatchLimit) {
    const normalizedQuery = normalizeLookupText(rawQuery);
    const index = await this.loadAndSyncIndex();
    const managedTarget = this.buildManagedTarget(normalizedQuery);

    if (existsSync(managedTarget.absolutePath)) {
      const exact = await this.ensureManagedTrackIndexed(index, normalizedQuery, managedTarget.file);
      return {
        ok: true,
        query: rawQuery,
        normalizedQuery,
        status: "hit" satisfies MatchStatus,
        total: 1,
        best: this.serializeTrack(exact, 1000),
        items: [this.serializeTrack(exact, 1000)],
      };
    }

    const ranked = this.rankTracks(index, normalizedQuery).slice(0, clampLimit(limit, 20));
    if (ranked.length === 0) {
      return {
        ok: true,
        query: rawQuery,
        normalizedQuery,
        status: "miss" satisfies MatchStatus,
        total: 0,
        items: [],
      };
    }

    const items = ranked.map((item) => this.serializeTrack(item.track, item.score));
    const top = ranked[0];
    const second = ranked[1];
    const isConfidentHit = !second || top.score >= second.score + 120 || top.score >= 900;

    return {
      ok: true,
      query: rawQuery,
      normalizedQuery,
      status: (isConfidentHit ? "hit" : "ambiguous") satisfies MatchStatus,
      total: items.length,
      best: isConfidentHit ? this.serializeTrack(top.track, top.score) : undefined,
      items,
    };
  }

  async ensure(input: {
    query: string;
    sourceUrl?: string;
    title?: string;
    artist?: string;
    aliases?: string[];
  }) {
    const normalizedQuery = normalizeLookupText(input.query);
    const matchResult = await this.match(input.query);

    if (matchResult.status === "hit" && matchResult.best) {
      return {
        ok: true,
        query: input.query,
        normalizedQuery,
        status: "ready",
        cached: true,
        item: matchResult.best,
      };
    }

    const sourceUrl = input.sourceUrl?.trim();
    if (!sourceUrl) {
      return {
        ok: true,
        query: input.query,
        normalizedQuery,
        status: matchResult.status === "ambiguous" ? "ambiguous" : "source_required",
        cached: false,
        best: matchResult.best,
        items: matchResult.items,
      };
    }

    validateSourceUrl(sourceUrl);

    const ensureKey = createHash("sha1").update(`${normalizedQuery}\n${sourceUrl}`).digest("hex");
    const inflight = this.inflightEnsures.get(ensureKey);
    if (inflight) {
      return inflight;
    }

    const task = this.performEnsure({
      query: input.query,
      normalizedQuery,
      sourceUrl,
      title: input.title,
      artist: input.artist,
      aliases: input.aliases,
    }).finally(() => {
      this.inflightEnsures.delete(ensureKey);
    });

    this.inflightEnsures.set(ensureKey, task);
    return task;
  }

  async rescan() {
    const index = await this.loadIndex();
    await this.syncIndexWithFilesystem(index);
    await this.saveIndex(index);
    return this.getStatus();
  }

  private async performEnsure(input: {
    query: string;
    normalizedQuery: string;
    sourceUrl: string;
    title?: string;
    artist?: string;
    aliases?: string[];
  }) {
    await mkdir(this.downloadDir, { recursive: true });
    await assertCommandAvailable(this.libraryConfig.ytDlpBin, ["--version"]);
    await assertCommandAvailable(this.libraryConfig.ffmpegBin, ["-version"]);

    const target = this.buildManagedTarget(input.normalizedQuery, input.artist, input.title);
    const tempStem = `${target.absolutePath}.tmp-${Date.now()}`;
    const outputTemplate = `${tempStem}.%(ext)s`;
    const proxy = resolveProxy(this.libraryConfig.proxy);

    const args = [
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
    ];

    if (proxy) {
      args.push("--proxy", proxy);
    }
    if (this.libraryConfig.cookiesPath?.trim()) {
      args.push("--cookies", this.libraryConfig.cookiesPath.trim());
    }

    args.push(input.sourceUrl);

    await runCommand(this.libraryConfig.ytDlpBin, args);

    const tempMp3 = `${tempStem}.mp3`;
    if (!existsSync(tempMp3)) {
      throw new Error(`yt-dlp did not produce expected mp3: ${tempMp3}`);
    }

    if (existsSync(target.absolutePath)) {
      await rm(tempMp3, { force: true });
    } else {
      await rename(tempMp3, target.absolutePath);
    }

    const index = await this.loadAndSyncIndex();
    const now = new Date().toISOString();
    const currentStat = await stat(target.absolutePath);
    const metadata = await probeMedia(this.libraryConfig.ffprobeBin, target.absolutePath);
    const existing = index.tracks[target.id];
    const aliases = mergeAliases(
      input.normalizedQuery,
      existing?.aliases ?? [],
      input.aliases ?? [],
      buildArtistTitleAliases(input.artist, input.title),
    );

    const track: MediaLibraryTrack = {
      id: target.id,
      query: input.normalizedQuery,
      aliases,
      title: input.title || existing?.title,
      artist: input.artist || existing?.artist,
      file: target.file,
      sourceUrl: input.sourceUrl,
      sourceHost: safeUrlHost(input.sourceUrl),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      sizeBytes: currentStat.size,
      durationSec: metadata.durationSec,
      managed: true,
    };

    index.tracks[track.id] = track;
    await this.saveIndex(index);

    return {
      ok: true,
      query: input.query,
      normalizedQuery: input.normalizedQuery,
      status: "ready",
      cached: false,
      item: this.serializeTrack(track, 1000),
    };
  }

  private buildManagedTarget(normalizedQuery: string, artist?: string, title?: string) {
    const id = createHash("sha1").update(normalizedQuery).digest("hex").slice(0, 12);
    const displayName = buildDisplayName(normalizedQuery, artist, title);
    const fileName = `${toSafeStem(displayName)}-${id}.mp3`;
    const file = path.posix.join(normalizeRelativePath(this.libraryConfig.downloadSubdir), fileName);
    return {
      id,
      file,
      absolutePath: path.join(this.rootDir, file),
    };
  }

  private async ensureManagedTrackIndexed(
    index: MediaLibraryIndex,
    normalizedQuery: string,
    file: string,
  ) {
    const id = createHash("sha1").update(normalizedQuery).digest("hex").slice(0, 12);
    const existing = index.tracks[id];
    const absolutePath = path.join(this.rootDir, file);
    const currentStat = await stat(absolutePath);
    const now = new Date().toISOString();
    const track: MediaLibraryTrack = {
      id,
      query: normalizedQuery,
      aliases: mergeAliases(normalizedQuery, existing?.aliases ?? []),
      title: existing?.title,
      artist: existing?.artist,
      file,
      sourceUrl: existing?.sourceUrl,
      sourceHost: existing?.sourceHost,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      sizeBytes: currentStat.size,
      durationSec: existing?.durationSec,
      managed: true,
    };
    index.tracks[id] = track;
    await this.saveIndex(index);
    return track;
  }

  private async loadAndSyncIndex() {
    const index = await this.loadIndex();
    const changed = await this.syncIndexWithFilesystem(index);
    if (changed) {
      await this.saveIndex(index);
    }
    return index;
  }

  private async loadIndex(): Promise<MediaLibraryIndex> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MediaLibraryIndex>;
      if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.tracks) {
        return {
          version: 1,
          tracks: Object.fromEntries(
            Object.entries(parsed.tracks)
              .filter(([, value]) => value && typeof value === "object")
              .map(([key, value]) => [key, this.normalizeTrack(value as MediaLibraryTrack)]),
          ),
        };
      }
    } catch {
      // ignore missing/corrupt index and rebuild on demand
    }

    return {
      version: 1,
      tracks: {},
    };
  }

  private async saveIndex(index: MediaLibraryIndex) {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  private async syncIndexWithFilesystem(index: MediaLibraryIndex) {
    const files = (await listMediaFiles(this.mediaConfig)).filter((file) => isSupportedAudioFile(file));
    const byFile = new Map<string, string>();
    for (const [trackId, track] of Object.entries(index.tracks)) {
      byFile.set(track.file, trackId);
    }

    let changed = false;
    const fileSet = new Set(files);

    for (const [trackId, track] of Object.entries(index.tracks)) {
      if (fileSet.has(track.file)) {
        continue;
      }
      delete index.tracks[trackId];
      changed = true;
    }

    for (const file of files) {
      const absolutePath = path.join(this.rootDir, file);
      const existingTrackId = byFile.get(file);
      const fileStat = await stat(absolutePath);
      if (existingTrackId) {
        const current = index.tracks[existingTrackId];
        if (!current) {
          continue;
        }
        if (current.sizeBytes !== fileStat.size) {
          current.sizeBytes = fileStat.size;
          current.updatedAt = new Date().toISOString();
          changed = true;
        }
        continue;
      }

      const derivedQuery = normalizeLookupText(path.basename(file, path.extname(file)));
      const syntheticId = createHash("sha1").update(`file:${file}`).digest("hex").slice(0, 12);
      index.tracks[syntheticId] = {
        id: syntheticId,
        query: derivedQuery,
        aliases: mergeAliases(derivedQuery, path.basename(file, path.extname(file))),
        file,
        createdAt: fileStat.birthtime.toISOString(),
        updatedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size,
        managed: false,
      };
      changed = true;
    }

    return changed;
  }

  private normalizeTrack(track: MediaLibraryTrack): MediaLibraryTrack {
    return {
      ...track,
      query: normalizeLookupText(track.query || path.basename(track.file, path.extname(track.file))),
      aliases: mergeAliases(track.query || "", track.aliases ?? [], path.basename(track.file, path.extname(track.file))),
      file: normalizeRelativePath(track.file),
    };
  }

  private rankTracks(index: MediaLibraryIndex, normalizedQuery?: string) {
    const ranked = Object.values(index.tracks)
      .filter((track) => existsSync(path.join(this.rootDir, track.file)))
      .map((track) => ({
        track,
        score: normalizedQuery ? calculateMatchScore(track, normalizedQuery) : 0,
      }))
      .filter(({ score }) => !normalizedQuery || score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.track.updatedAt.localeCompare(left.track.updatedAt);
      });

    return ranked;
  }

  private serializeTrack(track: MediaLibraryTrack, matchScore?: number) {
    const absolutePath = path.join(this.rootDir, track.file);
    return {
      id: track.id,
      query: track.query,
      aliases: track.aliases,
      title: track.title,
      artist: track.artist,
      file: track.file,
      absolutePath,
      url: resolveMediaFileURL(this.mediaConfig, track.file),
      sourceUrl: track.sourceUrl,
      sourceHost: track.sourceHost,
      sizeBytes: track.sizeBytes,
      durationSec: track.durationSec,
      managed: track.managed ?? false,
      updatedAt: track.updatedAt,
      ...(typeof matchScore === "number" ? { matchScore } : {}),
    };
  }
}

function clampLimit(value: number, max: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return kDefaultMatchLimit;
  }
  return Math.min(Math.trunc(value), max);
}

function isSupportedAudioFile(file: string) {
  return AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function normalizeLookupText(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[，。！？、,.!?]+$/g, "")
    .replace(/^(请|麻烦你)?\s*(帮我|给我)?\s*(播放|放一下|放|来一首|来首|来个|播一下)\s*/u, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) {
    throw new Error("query is required");
  }

  return normalized;
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\//, "").replace(/^\.+\//, "");
}

function toSafeStem(value: string) {
  const stem = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return stem || "track";
}

function buildDisplayName(normalizedQuery: string, artist?: string, title?: string) {
  if (artist?.trim() && title?.trim()) {
    return `${artist.trim()}-${title.trim()}`;
  }
  if (title?.trim()) {
    return title.trim();
  }
  return normalizedQuery;
}

function buildArtistTitleAliases(artist?: string, title?: string) {
  if (!artist?.trim() || !title?.trim()) {
    return [];
  }

  const cleanArtist = artist.trim();
  const cleanTitle = title.trim();
  return [
    `${cleanArtist} ${cleanTitle}`,
    `${cleanArtist}-${cleanTitle}`,
    `${cleanArtist}的${cleanTitle}`,
    cleanTitle,
  ];
}

function mergeAliases(...groups: Array<Array<string> | string>) {
  const aliases = new Set<string>();

  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      aliases.add(trimmed);
      aliases.add(trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim());
      aliases.add(trimmed.replace(/\s+/g, ""));
      aliases.add(trimmed.replace(/\s*的\s*/g, " ").replace(/\s+/g, " ").trim());
      aliases.add(comparableText(trimmed));
    }
  }

  return Array.from(aliases).filter(Boolean);
}

function calculateMatchScore(track: MediaLibraryTrack, normalizedQuery: string) {
  const normalizedAliases = mergeAliases(track.query, track.aliases, track.title ?? "", track.artist ?? "");
  const queryCompact = normalizedQuery.replace(/\s+/g, "");
  const queryComparable = comparableText(normalizedQuery);
  const baseName = path.basename(track.file, path.extname(track.file));
  const comparableBaseName = comparableText(baseName);
  let score = 0;

  for (const alias of normalizedAliases) {
    const compactAlias = alias.replace(/\s+/g, "");
    const comparableAlias = comparableText(alias);
    if (alias === normalizedQuery || compactAlias === queryCompact || comparableAlias === queryComparable) {
      score = Math.max(score, 1200);
      continue;
    }
    if (alias.startsWith(normalizedQuery) || comparableAlias.startsWith(queryComparable)) {
      score = Math.max(score, 900);
      continue;
    }
    if (alias.includes(normalizedQuery) || compactAlias.includes(queryCompact) || comparableAlias.includes(queryComparable)) {
      score = Math.max(score, 700);
      continue;
    }
  }

  const compactBaseName = baseName.replace(/\s+/g, "").toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  if (
    baseName.toLowerCase() === lowerQuery
    || compactBaseName === queryCompact.toLowerCase()
    || comparableBaseName === queryComparable
  ) {
    score = Math.max(score, 950);
  } else if (
    baseName.toLowerCase().includes(lowerQuery)
    || compactBaseName.includes(queryCompact.toLowerCase())
    || comparableBaseName.includes(queryComparable)
  ) {
    score = Math.max(score, 650);
  }

  for (const token of lowerQuery.split(/\s+/)) {
    if (!token) {
      continue;
    }
    if (baseName.toLowerCase().includes(token)) {
      score += 40;
    }
    if ((track.artist || "").toLowerCase().includes(token)) {
      score += 60;
    }
    if ((track.title || "").toLowerCase().includes(token)) {
      score += 80;
    }
  }

  if (track.managed) {
    score += 20;
  }

  return score;
}

function comparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s\-_]+/g, "")
    .replace(/[()（）\[\]【】{}·.,，。!?！？:：'"`]/g, "")
    .replace(/的/g, "");
}

function resolveProxy(rawValue?: string) {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  if (["0", "off", "false", "none", "no"].includes(value.toLowerCase())) {
    return undefined;
  }
  return value;
}

function validateSourceUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("sourceUrl must be a valid URL");
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error("sourceUrl must use http or https");
  }
}

function safeUrlHost(value?: string) {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

async function assertCommandAvailable(commandName: string, args: string[]) {
  await runCommand(commandName, args, { quiet: true, maxOutputBytes: 1024 });
}

async function runCommand(
  commandName: string,
  args: string[],
  options: {
    quiet?: boolean;
    maxOutputBytes?: number;
  } = {},
) {
  const { quiet = false, maxOutputBytes = 24_000 } = options;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    let stdout = "";

    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (!quiet) {
        process.stderr.write(text);
      }
      if (stdout.length < maxOutputBytes) {
        stdout += text;
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (!quiet) {
        process.stderr.write(text);
      }
      if (stderr.length < maxOutputBytes) {
        stderr += text;
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${commandName} exited with code ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}

async function probeMedia(ffprobeBin: string, filePath: string) {
  try {
    const output = await captureCommand(ffprobeBin, [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate",
      "-of",
      "json",
      filePath,
    ]);
    const parsed = JSON.parse(output) as {
      format?: {
        duration?: string;
      };
    };
    const duration = Number(parsed.format?.duration);
    return {
      durationSec: Number.isFinite(duration) ? duration : undefined,
    };
  } catch {
    return {
      durationSec: undefined,
    };
  }
}

async function captureCommand(commandName: string, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";

    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${commandName} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
