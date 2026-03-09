---
name: xiaoai_youtube_music
description: Find a requested song on YouTube with the web search tool, cache it as an MP3 under the local Open-XiaoAI media directory via yt-dlp through the 7890 proxy, and then play it on XiaoAI. Use when the user says things like “播放许嵩的素颜”, “来一首周杰伦晴天”, or asks to search YouTube and play music on the speaker. Prefer a cached local MP3 first; after playback starts, reply NO_REPLY.
metadata: {"openclaw":{"emoji":"🎵","requires":{"bins":["node","yt-dlp","ffmpeg"]}}}
---

# XiaoAI YouTube Music

Use this skill when the user wants the XiaoAI speaker to play a specific song, and it is acceptable to source the audio from YouTube.

This skill is a **sibling** of `xiaoai-bridge`; do not edit or depend on changing that original skill.

## Preferred Workflow

1. Normalize the request into a stable lookup key such as `许嵩 素颜` or `周杰伦 晴天`.
   - Remove fillers like `播放`、`来一首`、`帮我放一下`.
   - Keep artist and song title.
2. Check the local XiaoAI media library first with `xiaoai_media_match`.

3. If `xiaoai_media_match` returns `status: "hit"`, prefer:
   - `xiaoai_play_url` with `best.url`
   - then reply `NO_REPLY`
4. If the result is `miss` or `ambiguous`, use the **web search tool** to search YouTube for the song.
   - Prefer official MV / official audio / topic uploads.
   - Avoid Shorts, covers, live, remix, DJ, cut, speed-up, and lyric videos unless the user explicitly asked for those versions.
   - Prefer full-length results whose artist and song title both match.
5. Download and cache the chosen video as MP3 with `xiaoai_media_ensure`:
   - `query`: the normalized request such as `许嵩 素颜`
   - `sourceUrl`: the selected YouTube URL
   - `artist` / `title` when you can infer them confidently

6. After `xiaoai_media_ensure` returns `status: "ready"`, play it:
   - Use `xiaoai_play_url` with `item.url`
   - then reply `NO_REPLY`

## Tool Reference

Prefer these tools:

- `xiaoai_media_match`
- `xiaoai_media_ensure`
- `xiaoai_play_url`

## Fallback CLI

```bash
node {baseDir}/invoke.mjs inspect --query "许嵩 素颜"
node {baseDir}/invoke.mjs ensure --query "许嵩 素颜" --url "https://www.youtube.com/watch?v=..."
```

Both commands print JSON to stdout.

### `inspect`

- Only checks the deterministic cache path.
- Returns whether the MP3 already exists.
- Does not call YouTube or the bridge.

### `ensure`

- Requires a YouTube URL.
- Downloads audio with `yt-dlp`.
- Uses `ffmpeg` extraction to create MP3.
- Stores the file under the local media root and returns a ready-to-play asset URL.

## Environment

- `OPEN_XIAOAI_MEDIA_ROOT`
  - Optional.
  - Defaults to `examples/openclaw/media`.
- `XIAOAI_YTDLP_PROXY`
  - Optional.
  - Defaults to `http://127.0.0.1:7890`.
  - Set to `off` / `false` / `none` to disable the proxy.
- `XIAOAI_YOUTUBE_SUBDIR`
  - Optional.
  - Defaults to `music/youtube`.

## Selection Heuristics

- Prefer exact artist + song title matches.
- Prefer official channels, Topic uploads, or clearly labeled full audio.
- Avoid ambiguous results when artist names collide.
- If the request is genuinely ambiguous, ask a short clarification question instead of downloading the wrong song.

## Safety

- Only pass YouTube URLs into `ensure`.
- Do not redownload when `xiaoai_media_match` already found a confident cached file.
- Keep replies short; once playback is triggered successfully, return `NO_REPLY`.
- Do not claim download success unless `xiaoai_media_ensure` returned `status: "ready"`.
