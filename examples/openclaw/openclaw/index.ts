import path from "node:path";

import { loadProjectEnv } from "./env.js";
import { OpenClawBridge } from "./bridge.js";

async function main() {
  const loadedFiles = loadProjectEnv();
  if (loadedFiles.length) {
    console.log(`📦 已加载环境文件: ${loadedFiles.map((file) => path.basename(file)).join(", ")}`);
  }

  const { kOpenXiaoAIConfig } = await import("../config.js");
  const bridge = new OpenClawBridge(kOpenXiaoAIConfig);
  await bridge.start();
  process.exit(0);
}

main().catch((error) => {
  console.error("❌ OpenClaw bridge 启动失败:", error);
  process.exit(1);
});
