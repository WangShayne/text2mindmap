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

## Quick start (prebuilt image)

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GitHub Container Registry for every release: `ghcr.io/wangshayne/text2mindmap` with the tags `latest`, `x.y` and `x.y.z`.

One-liner (data and the SQLite database go to `./data`):

```bash
docker run -d --name text2mindmap --restart unless-stopped -p 127.0.0.1:3000:3000 -v "$PWD/data:/data" -e APP_SECRET="$(openssl rand -hex 32)" ghcr.io/wangshayne/text2mindmap:latest
```

Keep the `APP_SECRET` value (it encrypts the API keys saved in Settings); pass the same value on every restart, or put it in an env file with `--env-file .env`. LLM and ASR settings can be entered in **Settings** after login, or passed as env vars (see [Configuration](#configuration)). The setup code is in `docker logs text2mindmap`.

With Docker Compose:

```bash
mkdir text2mindmap && cd text2mindmap
curl -fsSLO https://raw.githubusercontent.com/WangShayne/text2mindmap/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/WangShayne/text2mindmap/main/.env.example -o .env   # set APP_SECRET, LLM_* (or set LLM later in Settings)
docker pull ghcr.io/wangshayne/text2mindmap:latest
docker compose up -d
```

Update: `docker compose pull && docker compose up -d`. Pin a version with `TEXT2MINDMAP_IMAGE=ghcr.io/wangshayne/text2mindmap:0.3.0` in `.env`.

### Build from source (alternative)

```bash
git clone https://github.com/WangShayne/text2mindmap.git
cd text2mindmap
cp .env.example .env        # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (or set them later in Settings)
docker compose up -d --build
```

### First login

Open <http://127.0.0.1:3000> and create the admin account. The setup page asks for a **one-time setup code** that only the server operator can see:

```bash
docker compose logs text2mindmap | grep "SETUP CODE"   # or: cat data/setup-code
```

A new code is generated on every restart until setup is done, and it stops working once the admin exists. Wrong codes are rate-limited. Alternatively, set `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` to create the admin automatically on first start.

By default the port is bound to `127.0.0.1` only. Put a reverse proxy with HTTPS in front of it (see [Reverse proxy](#reverse-proxy)), or set `BIND_ADDRESS=0.0.0.0` to expose it directly.

The image is built from the `Dockerfile` (multi-stage; the runtime image only contains Node and the bundled app, about 170 MB). Release images are built and pushed by `.github/workflows/docker-publish.yml` when a `v*` tag is pushed.

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

Configure it in **Settings → Speech recognition** (Base URL, model, API key, max segment length, *Test connection*, *Fetch models*), or with the `ASR_*` variables. Any service with an OpenAI-compatible `/v1/audio/transcriptions` endpoint works. Which model to pick, what it needs and how to configure it: see [Choosing a speech recognition model](#choosing-a-speech-recognition-model).

For providers without a 30 s limit you can raise *Max segment length* (e.g. 120 s, about 3.8 MB per segment). Longer segments give the model more context but text appears less often.

**Example: SenseVoice as a separate container on the same Docker network** (this is how our demo is set up):

- Build `sensevoice-server` as described in the [FunASR guide](https://www.funasr.com/en/deploy/sensevoice-native-server.html) and package it as an image (there is no official prebuilt image). Name the container / compose service `sensevoice`, listen on `0.0.0.0:8040` inside the container, **do not publish the port on the host**, and attach it only to the network text2mindmap is on. Example command: `sensevoice-server -m model/sensevoice-small-q8.gguf -vad model/fsmn-vad.gguf --threads 8 --max-connections 2 --max-audio-seconds 300 0.0.0.0 8040`.
- In text2mindmap, **Settings → Speech recognition**: Base URL `http://sensevoice:8040/v1`, model `sensevoice-small` (as listed by `/v1/models`), **API key empty** (the server has no authentication; with an empty key no `Authorization` header is sent), max segment length 28.
- Or in `.env`: `ASR_BASE_URL=http://sensevoice:8040/v1` and `ASR_MODEL=sensevoice-small`.
- `--max-connections 2` means two requests at a time. Each browser sends its segments one after another, which is enough for a few users.

If the ASR server runs on the Docker host, use `http://host.docker.internal:<port>/v1` and make it listen on an address the container can reach (the Docker bridge, e.g. `172.17.0.1`, not `127.0.0.1`). Easier: run it as another service in the same `docker-compose.yml` and use `http://<service-name>:<port>/v1`.

**The microphone needs HTTPS** (browsers only allow recording on `https://` pages and `http://localhost`). Uploading audio files works over plain HTTP too. Behind nginx / 1Panel, make sure `client_max_body_size` is larger than one segment (nginx's default of 1 MB just fits a 28 s segment; use `30m` if you raise the segment length).

Limits: audio is decoded in the browser memory, so very long files (more than about an hour) may be slow or fail on low-memory devices. Split them first. The file formats you can upload are the ones your browser can decode (all common browsers handle mp3, m4a/AAC, wav, ogg/opus, webm, flac).

## Choosing a speech recognition model

text2mindmap only calls the OpenAI-compatible `POST {ASR_BASE_URL}/audio/transcriptions`: a multipart form with `file`, `model`, `response_format=json`, plus `language` when a *Spoken language* is picked. With a key it sends `Authorization: Bearer <key>`, and the JSON answer must contain `text`. Three kinds of setup:

> Models that run only in the cloud or only on a GPU are **options for the deployer**; they are never the demo's default.

| Category | Model / service | Resources | Mixed zh/en accuracy | Notes |
|---|---|---|---|---|
| **1. CPU only** | SenseVoice-Small (`sensevoice-server`) | ~0.3 GB RAM; RTF 0.07–0.09 on a 6-core CPU | 5-min mixed CER 14.3%, English WER 50.8%; often cuts English word endings | Lightest, and the only CPU option with `/v1/realtime` streaming. Setup: see the example in [Self-hosted speech recognition](#self-hosted-speech-recognition). No authentication; keep it internal. |
| | Qwen3-ASR-0.6B Q8_0 (llama.cpp `llama-server`) | ~1.4 GiB peak RAM; RTF 0.20–0.26 on a 6-core CPU | 5-min mixed CER 8.4–9.1%, English WER 30–31%, Mandarin CER 1.9–2.0% | More accurate, English word endings mostly intact. llama.cpp audio support is experimental: **pin the version** (we tested `server-b11749`). |
| **2. ≥ 8 GB RAM** | Qwen3-ASR-1.7B Q8_0 (`llama-server`, CPU) or vLLM (GPU) | `llama-server` peak ~4.7 GB; RTF estimated 0.35–0.45 on a 6-core CPU | 5-min mixed CER ~6.0–6.2%, English WER ~20–21% (measured on another machine) | Most accurate. With vLLM / transformers you **must set *Spoken language* to Chinese**, see below. |
| **3. Cloud API key** | See the cloud table below | Nothing local; billed per minute | Not tested | Audio is sent to a third party. |

The SenseVoice and Qwen3-ASR-0.6B numbers were measured on our demo server (6-core CPU) with `scripts/asr-bench`, on 5 minutes of FLEURS Mandarin and 5 minutes of ASCEND mixed Chinese–English. The 1.7B accuracy was measured on another machine; its speed is an estimate.

**Example: Qwen3-ASR-0.6B with `llama-server`** (files from [`ggml-org/Qwen3-ASR-0.6B-GGUF`](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF); you need both the model and the mmproj file):

```sh
llama-server -m Qwen3-ASR-0.6B-Q8_0.gguf --mmproj mmproj-Qwen3-ASR-0.6B-Q8_0.gguf \
  -t 6 -c 2048 -np 1 --cache-ram 0 --temp 0 \
  --host 0.0.0.0 --port 8080 --api-key "$QWEN_ASR_KEY"
```

```env
ASR_BASE_URL=http://qwen-asr:8080/v1
ASR_API_KEY=<same as --api-key>
ASR_MODEL=qwen3-asr-0.6b
```

- In **Settings → Speech recognition**, fill in the same Base URL, API key and model, and keep max segment length at 28. `llama-server` ignores the model name, but text2mindmap requires one, so any name works.
- Use a pinned Docker tag such as `ghcr.io/ggml-org/llama.cpp:server-b11749`, not `latest`. Either set `--api-key` or don't publish the port and keep it on an internal network.
- **Leave *Spoken language* on *Auto language*.** With `language=zh`, silent segments come back as the echoed prompt (`Transcribe audio to text (language: zh).`); without it, 0.6B does not translate mixed speech into English. text2mindmap strips the `language Chinese<asr_text>` prefix, prompt echoes and segments that are only a filler such as 嗯 or "um".
- **On the same 6-core machine as SenseVoice live captions**, lower `-t` to 2–3 to leave CPU for SenseVoice. At 2 threads RTF is about 0.36–0.40.

**1.7B under vLLM / transformers needs Chinese forced**: without a language it translates mixed Chinese–English speech into English (CER rose to 49% in our test). text2mindmap forwards the *Spoken language* selector next to Record / Upload as the `language` field, and vLLM's Qwen3-ASR then fixes the language. The selector is saved per browser and defaults to *Auto language*; the server cannot force it, so tell users to pick 中文. The `llama-server` runs of 1.7B did not show the translation problem.

```sh
vllm serve Qwen/Qwen3-ASR-1.7B   # GPU; see the model card for version and flags
```

```env
ASR_BASE_URL=http://<host>:8000/v1
ASR_MODEL=Qwen/Qwen3-ASR-1.7B
```

**Cloud services** (checked against each provider's official docs, not tested with a key):

| Service | Works directly? | Base URL / model | Notes |
|---|---|---|---|
| **OpenAI** | ✅ | `https://api.openai.com/v1`, model `gpt-transcribe` | 25 MB per request. `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` are deprecated and will be removed on 2027-02-26. |
| **Mistral Voxtral 3** | ⚠️ Same format, untested | `https://api.mistral.ai/v1`, model `voxtral-mini-transcribe-3` (versioned ID `voxtral-mini-transcribe-3-0`) | Docs show Bearer auth and multipart `file` / `model` / `language`, answer with `text`. `response_format` is not among its documented fields; use *Test connection* to check it is ignored. Voxtral 3 is a Public Preview with closed weights; whether Realtime 3 handles Chinese is unconfirmed, and text2mindmap does not use realtime anyway. |
| **Alibaba Cloud Model Studio (Bailian) Qwen3-ASR-Flash** | ❌ Not directly | — | Its OpenAI-compatible mode is only `/compatible-mode/v1/chat/completions` with the audio as `input_audio` in JSON (Base64 or a public URL); there is no `/audio/transcriptions`. `qwen3-asr-flash-filetrans` is an async job API and the realtime model uses WebSocket. You'd need your own translation layer. |
| **Ant Ling** (Ming-3.0-asr-tiny) | ✅ | `https://api.ant-ling.com/v1`, model `Ming-3.0-asr-tiny` | At most 30 s and 10 MB per request, WAV or MP3 only. The defaults already fit. |
| Others | Check the docs | — | Anything with an OpenAI-compatible multipart `/v1/audio/transcriptions` that answers JSON `text` works. Press *Test connection* after filling it in. |

```env
ASR_BASE_URL=https://api.openai.com/v1
ASR_API_KEY=sk-...
ASR_MODEL=gpt-transcribe
```

Self-hosting Ming-3.0-asr-tiny needs one GPU (SGLang-Omni) and is also a deployer option.

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
