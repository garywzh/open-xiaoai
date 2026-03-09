import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { readJsonBody, writeJson } from "./http.js";
import { OpenXiaoAIMediaLibrary } from "./media-library.js";
import {
  createMediaReadStream,
  ensureMediaFileReadable,
  getContentType,
  resolveMediaBaseURL,
  resolveMediaRoot,
} from "./media.js";
import type { XiaoAIMediaLibraryServiceConfig } from "./types.js";

export class XiaoAIMediaLibraryService {
  private readonly library: OpenXiaoAIMediaLibrary;

  constructor(private readonly config: XiaoAIMediaLibraryServiceConfig) {
    this.library = new OpenXiaoAIMediaLibrary(config.media, config.library);
  }

  async start() {
    await this.startAssetServer();
    await this.startApiServer();
    console.log("✅ Media library service 已启动...");
  }

  private async startApiServer() {
    await new Promise<void>((resolve, reject) => {
      const server = createServer(async (request, response) => {
        try {
          await this.handleApiRequest(request, response);
        } catch (error) {
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.on("error", reject);
      server.listen(this.config.library.apiPort, this.config.library.apiHost, () => {
        console.log(`✅ Library API 已启动: ${this.getApiBaseURL()}`);
        resolve();
      });
    });
  }

  private async startAssetServer() {
    const mediaRoot = resolveMediaRoot(this.config.media);
    const baseURL = resolveMediaBaseURL(this.config.media);

    await new Promise<void>((resolve, reject) => {
      const server = createServer(async (request, response) => {
        try {
          await this.handleAssetRequest(request, response);
        } catch (error) {
          writeJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.on("error", reject);
      server.listen(this.config.media.port, this.config.media.host, () => {
        console.log(`✅ Media Asset API 已启动: ${baseURL}`);
        console.log(`📁 Media Root: ${mediaRoot}`);
        resolve();
      });
    });
  }

  private async handleApiRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        apiBaseURL: this.getApiBaseURL(),
        assetBaseURL: resolveMediaBaseURL(this.config.media),
        rootDir: resolveMediaRoot(this.config.media),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/library/status") {
      writeJson(response, 200, {
        ...(await this.library.getStatus()),
        apiBaseURL: this.getApiBaseURL(),
        assetBaseURL: resolveMediaBaseURL(this.config.media),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/library/items") {
      const query = url.searchParams.get("query")?.trim() ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      writeJson(response, 200, await this.library.list(query, limit));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/library/rescan") {
      writeJson(response, 200, await this.library.rescan());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/library/match") {
      const body = await readJsonBody<{ query?: string; limit?: number }>(request);
      if (!body.query?.trim()) {
        writeJson(response, 400, { error: "query is required" });
        return;
      }
      writeJson(response, 200, await this.library.match(body.query, body.limit));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/library/ensure") {
      const body = await readJsonBody<{
        query?: string;
        sourceUrl?: string;
        title?: string;
        artist?: string;
        aliases?: string[];
      }>(request);
      if (!body.query?.trim()) {
        writeJson(response, 400, { error: "query is required" });
        return;
      }
      writeJson(response, 200, await this.library.ensure({
        query: body.query,
        sourceUrl: body.sourceUrl,
        title: body.title,
        artist: body.artist,
        aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      }));
      return;
    }

    writeJson(response, 404, { error: "not found" });
  }

  private async handleAssetRequest(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        rootDir: resolveMediaRoot(this.config.media),
        baseURL: resolveMediaBaseURL(this.config.media),
      });
      return;
    }

    if (request.method !== "GET" || !url.pathname.startsWith("/media/")) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    const relativePath = decodeURIComponent(url.pathname.slice("/media/".length));
    const resolved = await ensureMediaFileReadable(this.config.media, relativePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", getContentType(resolved.absolutePath));
    response.setHeader("Cache-Control", "public, max-age=60");

    await new Promise<void>((resolve, reject) => {
      const stream = createMediaReadStream(resolved.absolutePath);
      stream.on("error", reject);
      response.on("close", resolve);
      stream.pipe(response);
    });
  }

  private getApiBaseURL() {
    return `http://${this.config.library.apiHost}:${this.config.library.apiPort}`;
  }
}
