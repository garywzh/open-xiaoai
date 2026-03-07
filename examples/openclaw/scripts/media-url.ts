import path from "node:path";

import { loadProjectEnv } from "../openclaw/env.js";
import {
  detectLanIPv4,
  listMediaFiles,
  resolveMediaBaseURL,
  resolveMediaFileURL,
  resolveMediaRoot,
} from "../openclaw/media.js";

async function main() {
  const loadedFiles = loadProjectEnv();
  if (loadedFiles.length) {
    console.log(`Loaded env: ${loadedFiles.map((file) => path.basename(file)).join(", ")}`);
  }

  const { kOpenXiaoAIConfig } = await import("../config.js");
  const [modeOrFile, maybeFile] = process.argv.slice(2);

  console.log(`Media Root: ${resolveMediaRoot(kOpenXiaoAIConfig.media)}`);
  console.log(`Detected LAN IP: ${detectLanIPv4()}`);
  console.log(`Media Base URL: ${resolveMediaBaseURL(kOpenXiaoAIConfig.media)}`);

  if (!modeOrFile || modeOrFile === "--list") {
    const files = await listMediaFiles(kOpenXiaoAIConfig.media);
    if (!files.length) {
      console.log("No media files found.");
      return;
    }

    console.log("Available media files:");
    for (const file of files) {
      console.log(`- ${file}`);
    }
    return;
  }

  const file = modeOrFile === "--file" ? maybeFile : modeOrFile;
  if (!file) {
    console.error("Usage: pnpm media:url -- <file> | --list");
    process.exit(1);
  }

  console.log(`Resolved URL: ${resolveMediaFileURL(kOpenXiaoAIConfig.media, file)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
