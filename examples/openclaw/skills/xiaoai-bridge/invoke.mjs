#!/usr/bin/env node

const baseURL = (process.env.OPEN_XIAOAI_BRIDGE_BASE_URL || "http://127.0.0.1:4400").replace(/\/$/, "");
const [command, ...rest] = process.argv.slice(2);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  switch (command) {
    case "status": {
      await request("GET", "/api/status");
      return;
    }
    case "debug-text": {
      const text = rest.join(" ").trim();
      ensureArgument(text, "text");
      await request("POST", "/api/debug/text", { text, execute: false });
      return;
    }
    case "speak": {
      const text = rest.join(" ").trim();
      ensureArgument(text, "text");
      await request("POST", "/api/speak", { text });
      return;
    }
    case "play": {
      const url = rest.join(" ").trim();
      ensureArgument(url, "url");
      await request("POST", "/api/play", { url });
      return;
    }
    case "ask-xiaoai": {
      const text = rest.join(" ").trim();
      ensureArgument(text, "text");
      await request("POST", "/api/ask-xiaoai", { text });
      return;
    }
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function request(method, pathname, body) {
  const response = await fetch(`${baseURL}${pathname}`, {
    method,
    headers: body
      ? {
          "Content-Type": "application/json",
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}: ${text}`);
  }

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function ensureArgument(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

function printUsage() {
  console.log(`Usage:
  node invoke.mjs status
  node invoke.mjs debug-text <text>
  node invoke.mjs speak <text>
  node invoke.mjs play <url>
  node invoke.mjs ask-xiaoai <text>`);
}
