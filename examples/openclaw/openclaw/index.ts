import path from "node:path";

import { loadProjectEnv } from "./env.js";
import { XiaoAIGateway } from "./gateway.js";
import { XiaoAIMediaLibraryService } from "./media-library-service.js";

async function main() {
  const loadedFiles = loadProjectEnv();
  if (loadedFiles.length) {
    console.log(`📦 已加载环境文件: ${loadedFiles.map((file) => path.basename(file)).join(", ")}`);
  }

  const { kOpenXiaoAIConfig } = await import("../config.js");
  const mediaLibraryService = new XiaoAIMediaLibraryService(kOpenXiaoAIConfig.mediaLibraryService);
  const gateway = new XiaoAIGateway(kOpenXiaoAIConfig.gateway);
  await mediaLibraryService.start();
  await gateway.start();
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ OpenClaw services 启动失败:", error);
  process.exit(1);
});
