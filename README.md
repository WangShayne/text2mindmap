# text2mindmap

English | [简体中文](README.zh-CN.md)

Turn text into an editable mind map with any OpenAI-compatible LLM. Self-hosted, one Docker container.

Paste an article, notes or a transcript, and the LLM writes a Markdown outline that grows into a mind map as it streams. Edit the Markdown on the left or the map on the right: both stay in sync. Export to Markdown, PNG, SVG, PDF, XMind or OPML.

## Features

- **Generate from text** with any OpenAI-compatible API (OpenAI, DeepSeek, Qwen, Kimi, OpenRouter, Ollama, New API / one-api gateways…). The answer streams in and the map grows live. Chinese and English both work.
- **Long texts** are split by paragraph into parts, each part is outlined, then the parts are merged into one tree.
- **Regenerate**: replace the whole document (asks before overwriting your edits) or **expand the selected node** with new children.
- **Two-way editing**: Markdown editor (CodeMirror 6) on the left, mind map ([simple-mind-map](https://github.com/wanglin2/mind-map)) on the right. On the map: Tab adds a child, Enter a sibling, F2 edits, Del deletes, drag to move a node to a new parent, Ctrl+Z / Ctrl+Y undo and redo, `/` folds a branch.
- **Stop** a running generation (the upstream request is cancelled). If the model answers with prose instead of an outline, it retries once, then shows a clear error.
- **Voice input**: record from the microphone or upload an audio file; it is transcribed by any OpenAI-compatible speech-to-text API (self-hosted SenseVoice / Qwen3-ASR / Ming-3.0-asr-tiny, or a cloud API) and the text goes into the input box. See [Self-hosted speech recognition](#self-hosted-speech-recognition).
- **Map style**: 6 themes (Light, Dark, Ocean, Forest, Sunset, Mono) and 3 structures (logic chart, mind map, org chart), picked with the 🎨 button in the map header. Saved per user and used for every document and for PNG/SVG/PDF exports.
- **Documents**: create, rename, delete, import `.md`, autosave, one-click copy of the Markdown.
- **Export**: Markdown, PNG, SVG, PDF, XMind (browser), OPML and JSON (server).
- **Admin settings**: Base URL, model, API key (stored encrypted, never sent to the browser), editable system prompt with reset, and a *Test connection* button that tells a bad key (401) from a wrong URL / network error from an unknown model (404), and a *Fetch models* button that loads the provider's `/models` list into a searchable dropdown (you can still type any model name).
- **Single admin account** created on first start. No public sign-up. Data lives in one SQLite file.
- UI in English and Chinese.

## Quick start (Docker Compose)

```bash
git clone https://github.com/WangShayne/text2mindmap.git
cd text2mindmap
cp .env.example .env        # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (or set them later in Settings)
docker compose up -d --build
```

Open <http://127.0.0.1:3000> and create the admin account. The setup page asks for a **one-time setup code** that only the server operator can see:

```bash
docker compose logs text2mindmap | grep "SETUP CODE"   # or: cat data/setup-code
```

A new code is generated on every restart until setup is done, and it stops working once the admin exists. Wrong codes are rate-limited. Alternatively, set `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` to create the admin automatically on first start.

By default the port is bound to `127.0.0.1` only. Put a reverse proxy with HTTPS in front of it (see [Reverse proxy](#reverse-proxy)), or set `BIND_ADDRESS=0.0.0.0` to expose it directly.

The image is built locally from the `Dockerfile` (multi-stage; the runtime image only contains Node and the bundled app, about 170 MB). There is no prebuilt image yet.

### Calling an LLM on the Docker host

`localhost` inside the container is the container itself. To reach a model server running on the host (Ollama, New API, one-api, LM Studio…), use `http://host.docker.internal:<port>/v1`, for example:

```env
LLM_BASE_URL=http://host.docker.internal:11434/v1   # Ollama
LLM_BASE_URL=http://host.docker.internal:3001/v1    # a New API / one-api gateway on port 3001
```

`docker-compose.yml` already maps `host.docker.internal` to the host (`extra_hosts: host-gateway`). The model server must listen on an address the container can reach (for Ollama: `OLLAMA_HOST=0.0.0.0`), not only on `127.0.0.1`.

Container logs use the `json-file` driver, rotated at 10 MB × 3 files.

## Configuration

All settings are environment variables (put them in `.env`). LLM settings are defaults: the admin can override Base URL, model, API key and system prompt in **Settings**, and those overrides are stored in the database.

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL, including `/v1`. `/chat/completions` is appended. |
| `LLM_API_KEY` | *(empty)* | API key sent as `Authorization: Bearer …`. Optional for local servers. |
| `LLM_MODEL` | `gpt-4o-mini` | Model name. |
| `LLM_TEMPERATURE` | *(not sent)* | Optional sampling temperature. |
| `LLM_TIMEOUT_MS` | `180000` | Timeout of one LLM request. |
| `LLM_CHUNK_CHARS` | `12000` | Texts longer than this are split into parts and merged. |
| `MAX_INPUT_CHARS` | `200000` | Largest accepted input text. |
| `ASR_BASE_URL` | *(empty: voice input off)* | OpenAI-compatible speech-to-text base URL including `/v1`; `/audio/transcriptions` is appended. See [Self-hosted speech recognition](#self-hosted-speech-recognition). |
| `ASR_API_KEY` | *(empty)* | Key for the ASR server. Optional for local servers. |
| `ASR_MODEL` | *(empty)* | ASR model name, e.g. `SenseVoiceSmall`, `Ming-3.0-asr-tiny`, `gpt-transcribe`. |
| `ASR_SEGMENT_SECONDS` | `28` | Longest audio segment per request (5–600). Keep ≤ 28 for providers with a 30 s limit. |
| `ASR_TIMEOUT_MS` | `120000` | Timeout of one transcription request. |
| `ASR_MAX_UPLOAD_MB` | `25` | Upload limit per `/api/transcribe` request. |
| `APP_SECRET` | *(generated)* | Secret used to encrypt the API key saved in Settings (AES-256-GCM, key derived with HKDF). **Recommended.** If empty, a random one is generated into `data/secret.key` and a warning is logged. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(empty)* | Create the admin on first start instead of using the setup page (no setup code needed). Ignored once a user exists. |
| `COOKIE_SECURE` | `auto` | `Secure` flag of the session cookie: `auto` (when HTTPS is detected), `true`, `false`. |
| `TRUST_PROXY` | `false` | **Set to `true` behind a reverse proxy** (or to the number of proxies in front of the app). Then `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are trusted. See [Reverse proxy](#reverse-proxy). |
| `SESSION_DAYS` | `30` | Session lifetime. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address inside the container. |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the SQLite database and `secret.key` live. |
| `BIND_ADDRESS` / `HOST_PORT` | `127.0.0.1` / `3000` | Port mapping used by `docker-compose.yml`. |

## Markdown mapping

Markdown is the single source of truth. The map is always derived from it, and edits on the map are written back as Markdown.

- The document has **one root**: the level-1 heading `# Title`.
- `##` … `######` headings nest by level. A heading is a child of the nearest heading above it with a lower level (skipped levels are fine).
- List items (`-`, `*`, `+`, `1.`) are children of the heading above them and nest by indentation (a tab counts as 4 spaces; any deeper indent makes a child).
- A plain text line becomes a child of the current heading; an indented line right after a list item continues that item.
- Code fences, blockquote markers, horizontal rules, blank lines, task boxes (`[ ]`) and `<think>` blocks from reasoning models are ignored.
- If there is no single top-level node, the document title becomes the root.

When the map writes Markdown back, it uses a canonical form: `#` for the root, `##`–`######` for heading nodes, then `- ` bullets indented by two spaces. Each node remembers whether it was a heading or a bullet, so round trips keep your structure. Nodes created on the map take the kind of their siblings. Inline Markdown such as `**bold**` or links stays as plain text in the node.

### How the two-way sync works

1. Typing in the editor → (250 ms debounce) → parse Markdown to a tree → render the map.
2. Editing the map → the map emits the new tree → it is serialized to canonical Markdown → the editor is updated **only if the structure differs** from what the editor already contains, so your own formatting is kept.
3. Feedback loops are avoided in two ways: editor changes made by the map are tagged and never re-render the map, and the app remembers the canonical Markdown currently on the map and ignores change events that match it (echoes of its own renders).

The renderer sits behind a small interface (`src/web/src/mindmap/adapter.ts`), and the Markdown/tree conversion lives in `src/shared/`, so simple-mind-map could be replaced (for example with mind-elixir) by writing another adapter.

## Self-hosted speech recognition

The toolbar (and the cards on an empty document) has three entries: **Text**, **Record** and **Upload**. *Record* starts recording with one click; a small panel shows the timer and the text as it is recognized (every ~8 s). After *Stop* you can edit the text, then click *Generate map*. *Upload* (or dropping a file onto the page) picks the route from the file type: audio (mp3, m4a, wav, webm, ogg, flac…) is transcribed the same way, `.md` is imported as the map directly (no LLM), and `.txt` opens the text dialog prefilled. When a node is selected, you can choose to replace the map or append the result under that node.

How it works: the browser decodes the audio with the Web Audio API, converts it to **16 kHz mono 16-bit WAV** and splits it into segments of at most *Max segment length* (default **28 s**, cut at a quiet moment so words stay whole). Segments are sent one by one to `POST /api/transcribe`, which streams them to `{ASR Base URL}/audio/transcriptions` (OpenAI-compatible multipart, `response_format=json`; `text` and `verbose_json` answers are accepted too). Nothing is converted on the server, so the Docker image needs no ffmpeg. The ASR key is stored encrypted like the LLM key and never sent to the browser.

Configure it in **Settings → Speech recognition** (Base URL, model, API key, max segment length, *Test connection*, *Fetch models*), or with the `ASR_*` variables below. Any service with an OpenAI-compatible `/v1/audio/transcriptions` endpoint works:

| Option | Base URL / model | Notes |
|---|---|---|
| **CPU only: SenseVoice-Small** via FunASR [`sensevoice-server`](https://www.funasr.com/en/deploy/sensevoice-native-server.html) | `http://<host>:8040/v1`, model `SenseVoiceSmall` (check `/v1/models`) | Recommended for a small server. One C++ binary, no Python runtime, GGUF model, server-side VAD. Chinese, Cantonese, English, Japanese, Korean. Run it as a separate service or container next to text2mindmap. It has no authentication: keep it on `127.0.0.1` or a private Docker network. |
| **GPU: Qwen3-ASR** + vLLM | e.g. `vllm serve Qwen/Qwen3-ASR-1.7B` → `http://<host>:8000/v1`, model `Qwen/Qwen3-ASR-1.7B` | Higher accuracy, many languages. Apache-2.0. See the model card for the vLLM version and flags. |
| **GPU: [Ming-3.0-asr-tiny](https://huggingface.co/inclusionAI/Ming-3.0-asr-tiny)** (inclusionAI, 9B, MIT) | your server's `/v1`, model `Ming-3.0-asr-tiny` | Fits a single GPU. Works through any server that exposes it as an OpenAI-compatible `/v1/audio/transcriptions` endpoint. |
| **Cloud: Ant Ling** (Ming-3.0-asr-tiny) | `https://api.ant-ling.com/v1`, model `Ming-3.0-asr-tiny` | At most **30 s and 10 MB per request**, WAV or MP3 only, JSON answers only. The defaults (16 kHz WAV, 28 s segments, `response_format=json`) already fit. |
| **Cloud: OpenAI** | `https://api.openai.com/v1`, model `gpt-transcribe` | 25 MB per request. OpenAI marks `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` as deprecated; use `gpt-transcribe` for new setups. |

For providers without a 30 s limit you can raise *Max segment length* (e.g. 120 s, about 3.8 MB per segment). Longer segments give the model more context but text appears less often.

**Example: SenseVoice as a separate container on the same Docker network** (this is how our demo is set up):

- Build `sensevoice-server` as described in the [FunASR guide](https://www.funasr.com/en/deploy/sensevoice-native-server.html) and package it as an image (there is no official prebuilt image). Name the container / compose service `sensevoice`, listen on `0.0.0.0:8040` inside the container, **do not publish the port on the host**, and attach it only to the network text2mindmap is on. Example command: `sensevoice-server -m model/sensevoice-small-q8.gguf -vad model/fsmn-vad.gguf --threads 8 --max-connections 2 --max-audio-seconds 300 0.0.0.0 8040`.
- In text2mindmap, **Settings → Speech recognition**: Base URL `http://sensevoice:8040/v1`, model `sensevoice-small` (as listed by `/v1/models`), **API key empty** (the server has no authentication; with an empty key no `Authorization` header is sent), max segment length 28.
- Or in `.env`: `ASR_BASE_URL=http://sensevoice:8040/v1` and `ASR_MODEL=sensevoice-small`.
- `--max-connections 2` means two requests at a time. Each browser sends its segments one after another, which is enough for a few users.

If the ASR server runs on the Docker host, use `http://host.docker.internal:<port>/v1` and make it listen on an address the container can reach (the Docker bridge, e.g. `172.17.0.1`, not `127.0.0.1`). Easier: run it as another service in the same `docker-compose.yml` and use `http://<service-name>:<port>/v1`.

**The microphone needs HTTPS** (browsers only allow recording on `https://` pages and `http://localhost`). Uploading audio files works over plain HTTP too. Behind nginx / 1Panel, make sure `client_max_body_size` is larger than one segment (nginx's default of 1 MB just fits a 28 s segment; use `30m` if you raise the segment length).

Limits: audio is decoded in the browser memory, so very long files (more than about an hour) may be slow or fail on low-memory devices. Split them first. The file formats you can upload are the ones your browser can decode (all common browsers handle mp3, m4a/AAC, wav, ogg/opus, webm, flac).

## Reverse proxy

Behind a reverse proxy, **`TRUST_PROXY=true` is required**. What it changes:

- **Client IP** for login and setup-code rate limiting is read from `X-Forwarded-For`, counting `TRUST_PROXY` entries from the right (the address your proxy appended), so a client cannot dodge the limit by sending its own `X-Forwarded-For`. Without it, every visitor shares the proxy's IP and one attacker can lock everyone out for 15 minutes.
- **Secure cookie**: with the default `COOKIE_SECURE=auto`, the session cookie gets the `Secure` flag when `X-Forwarded-Proto` is `https`.
- **Same-origin check** compares the browser's `Origin` with `X-Forwarded-Host` (falls back to `Host`).

When `TRUST_PROXY` is `false` (default), all `X-Forwarded-*` headers are ignored. Do not enable it when the port is reachable without the proxy, because then clients could forge those headers. Use `TRUST_PROXY=2` if there are two proxies (e.g. Cloudflare → nginx → app).

Generation streams over Server-Sent Events, so turn off response buffering and allow long reads.

**Caddy** (gets HTTPS certificates automatically; sets `X-Forwarded-*` and streams by default):

```caddyfile
mindmap.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name mindmap.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 30m;   # audio segments for speech recognition

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        # Server-Sent Events (streaming generation)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

## Backup and restore

Everything is in `./data`: the SQLite database (`text2mindmap.db` plus `-wal`/`-shm` files), `secret.key` (only when `APP_SECRET` is not set) and, before the admin exists, `setup-code`.

```bash
docker compose stop
tar czf text2mindmap-backup-$(date +%F).tgz data .env
docker compose start
```

Restore by putting `data/` (and `.env`) back and running `docker compose up -d`.

**When migrating to another machine, copy the whole `data/` directory, not just the database.** If `APP_SECRET` is not set, the encryption key was generated into `data/secret.key`; without that file the API key saved in Settings cannot be decrypted (the app then falls back to `LLM_API_KEY`, and you have to enter the key again). We recommend setting `APP_SECRET` in `.env` (`openssl rand -hex 32`) and keeping `.env` with your backups.

## Security notes

- The API key is never returned by any endpoint. Responses only say whether a key is set. A key saved in Settings is encrypted at rest; a key in `LLM_API_KEY` stays in your environment.
- Every API endpoint requires login except `/api/health`, `/api/setup` and `/api/auth/login`. Without login, nobody can spend your LLM quota.
- First-run setup needs a random one-time setup code (10 characters) that is only printed in the server log and stored in `data/setup-code` (mode 0600). It is compared in constant time, wrong codes are rate-limited, and the code is invalidated as soon as the admin exists. After that the setup endpoint is closed and there is no sign-up.
- Passwords are hashed with scrypt. Sessions are random tokens (stored hashed) in an `HttpOnly`, `SameSite=Lax` cookie. Failed logins are rate-limited (10 per 15 minutes per IP).
- State-changing requests must be JSON and same-origin (CSRF protection).
- Serve it over HTTPS when it is reachable from the internet, and set `TRUST_PROXY=true` behind a proxy (see [Reverse proxy](#reverse-proxy)).
- The LLM receives the text you paste, and the ASR server receives your audio. Use providers you trust with it.
- The ASR key follows the same rules as the LLM key: stored encrypted, never returned. Audio uploads (`/api/transcribe`) need login, must be sent as `audio/*` (not a CORS-simple type, so cross-site pages cannot post them), are size-limited per request and are not stored.

## Development

Requires Node 22.13+.

```bash
npm install
npm run dev        # API server with reload on :3000 (uses ./data)
npm run dev:web    # Vite dev server on :5173, proxies /api to :3000
npm test           # unit + integration tests (mock OpenAI-compatible server)
npm run typecheck
npm run build && npm start
npm run license-check   # fails on GPL/AGPL/LGPL/SSPL/BUSL/CC-NC dependencies
npm run notices         # regenerates THIRD_PARTY_NOTICES.md
```

`npm run mock-llm` starts a fake OpenAI-compatible server on `:4010` (key `sk-test-secret`, model `mock-model`) for trying the app without a real model; `scripts/smoke.sh` runs an end-to-end API check against a running instance.

Project layout:

```
src/shared/      Markdown <-> outline tree, tree <-> map data (used by server and browser)
src/server/      Hono API: auth, documents, settings, LLM proxy (SSE), chunking, prompts
src/web/         React app: editor, map adapter, dialogs, i18n
tests/           Vitest tests
scripts/         build, mock LLM, smoke test, license check
```

## Credits and license

本产品思维导图基于SimpleMindMap项目开发，版权归源项目所有（<https://github.com/wanglin2/mind-map>）。
The mind map in this product is built on the [SimpleMindMap](https://github.com/wanglin2/mind-map) project (MIT).

Speech recognition: the recommended self-hosted model is [SenseVoice](https://github.com/QwenAudio/SenseVoice) (SenseVoice-Small, code under MIT; see its repository for the model license), served by FunASR's `sensevoice-server`. No model is bundled with text2mindmap; you run the ASR server yourself.

Only the free plugins shipped in the `simple-mind-map` npm package are used. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for all bundled packages and their licenses.

text2mindmap is released under the [MIT License](LICENSE). © 2026 Shayne Wang

The test audio in `scripts/asr-bench/audio/` is **not** covered by the MIT License: it comes from Google FLEURS (CC BY 4.0) and HKUST ASCEND (CC BY-SA 4.0). See [scripts/asr-bench/DATA_LICENSE.md](scripts/asr-bench/DATA_LICENSE.md).
