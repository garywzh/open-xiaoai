import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadProjectEnv } from "../openclaw/env.js";
import {
  listMediaFiles,
  resolveMediaFileURL,
  resolveMediaRoot,
} from "../openclaw/media.js";
import { OpenClawClient } from "../openclaw/openclaw-client.js";
import { BridgeRouter } from "../openclaw/router.js";

async function main() {
  loadProjectEnv();
  const { kOpenXiaoAIConfig } = await import("../config.js");

  const args = new Set(process.argv.slice(2));
  const runLiveChecks = args.has("--live");

  await runRouterChecks(kOpenXiaoAIConfig);
  await runMediaChecks(kOpenXiaoAIConfig);
  runActionChecks(kOpenXiaoAIConfig);

  if (runLiveChecks) {
    await runLiveApiChecks(kOpenXiaoAIConfig);
  }

  console.log("✅ smoke test passed");
}

async function runRouterChecks(
  config: Awaited<typeof import("../config.js")>["kOpenXiaoAIConfig"],
) {
  const router = new BridgeRouter(config.router);
  const prefix = config.router.assistantKeywords[0] ?? "请";

  const weather = router.decide(`${prefix} 今天上海天气怎么样`);
  assert.equal(weather.type, "openclaw");
  assert.equal(weather.text, "今天上海天气怎么样");

  const home = router.decide(`${prefix} 打开客厅灯`);
  assert.equal(home.type, "ignore");
  assert.equal(home.text, "打开客厅灯");

  const play = router.decide(`${prefix} 播放 http://127.0.0.1/demo.mp3`);
  assert.equal(play.type, "play_url_direct");
  assert.equal(play.url, "http://127.0.0.1/demo.mp3");

  const ignore = router.decide(prefix);
  assert.equal(ignore.type, "ignore");

  console.log("✓ router checks");
}

async function runMediaChecks(
  config: Awaited<typeof import("../config.js")>["kOpenXiaoAIConfig"],
) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-media-"));

  try {
    await mkdir(path.join(tempRoot, "music"), { recursive: true });
    await writeFile(path.join(tempRoot, "music", "demo.mp3"), Buffer.from("ID3"));

    const mediaConfig = {
      ...config.media,
      rootDir: tempRoot,
      publicOrigin: "http://192.168.1.8:4401",
    };

    assert.equal(resolveMediaRoot(mediaConfig), tempRoot);
    assert.deepEqual(await listMediaFiles(mediaConfig), ["music/demo.mp3"]);
    assert.equal(
      resolveMediaFileURL(mediaConfig, "music/demo.mp3"),
      "http://192.168.1.8:4401/media/music/demo.mp3",
    );

    console.log("✓ media checks");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function runActionChecks(
  config: Awaited<typeof import("../config.js")>["kOpenXiaoAIConfig"],
) {
  const client = new OpenClawClient(config.openclaw);

  assert.deepEqual(client.normalizeAction('{"action":"reply_text","text":"你好"}'), {
    action: "reply_text",
    text: "你好",
  });
  assert.deepEqual(client.normalizeAction('{"action":"play_file","file":"music/demo.mp3"}'), {
    action: "play_file",
    file: "music/demo.mp3",
  });
  assert.deepEqual(client.normalizeAction("普通文本回复"), {
    action: "reply_text",
    text: "普通文本回复",
  });
  assert.deepEqual(client.normalizeAction("NO_REPLY"), {
    action: "no_reply",
  });

  console.log("✓ action checks");
}

async function runLiveApiChecks(
  config: Awaited<typeof import("../config.js")>["kOpenXiaoAIConfig"],
) {
  const baseURL = process.env.OPEN_XIAOAI_DEBUG_BASE_URL?.trim() || `http://127.0.0.1:${config.server.debugPort}`;

  const health = await fetch(`${baseURL}/healthz`);
  assert.equal(health.ok, true, `healthz failed: ${health.status}`);

  const debug = await fetch(`${baseURL}/api/debug/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: `${config.router.assistantKeywords[0] ?? "请"} 今天上海天气怎么样`,
      execute: false,
    }),
  });
  assert.equal(debug.ok, true, `/api/debug/text failed: ${debug.status}`);

  console.log(`✓ live api checks (${baseURL})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

