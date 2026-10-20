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
- **Documents**: create, rename, delete, import `.md`, autosave, one-click copy of the Markdown.
- **Export**: Markdown, PNG, SVG, PDF, XMind (browser), OPML and JSON (server).
- **Admin settings**: Base URL, model, API key (stored encrypted, never sent to the browser), editable system prompt with reset, and a *Test connection* button that tells a bad key (401) from a wrong URL / network error from an unknown model (404).
- **Single admin account** created on first start. No public sign-up. Data lives in one SQLite file.
- UI in English and Chinese.

## Quick start (Docker Compose)

```bash
git clone https://github.com/WangShayne/text2mindmap.git
cd text2mindmap
cp .env.example .env        # set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (or set them later in Settings)
docker compose up -d --build
```

Open <http://127.0.0.1:3000>. On first start you create the admin account on a one-time setup page (or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` to create it automatically). Do this right away: until the admin exists, anyone who can reach the page can claim it.

By default the port is bound to `127.0.0.1` only. Put a reverse proxy with HTTPS (Caddy, nginx, Traefik) in front of it, set `TRUST_PROXY=true`, or set `BIND_ADDRESS=0.0.0.0` to expose it directly.

The image is built locally from the `Dockerfile` (multi-stage; the runtime image only contains Node and the bundled app, about 170 MB). There is no prebuilt image yet.

### Calling an LLM on the Docker host

`localhost` inside the container is the container itself. To reach a model server on the host (e.g. Ollama on port 11434), add this to the service in `docker-compose.yml` and use `http://host.docker.internal:11434/v1`:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

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
| `APP_SECRET` | *(generated)* | Secret used to encrypt the API key saved in Settings (AES-256-GCM, key derived with HKDF). If empty, a random one is generated into `data/secret.key` and a warning is logged. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(empty)* | Create the admin on first start instead of using the setup page. Ignored once a user exists. |
| `COOKIE_SECURE` | `auto` | `Secure` flag of the session cookie: `auto` (when HTTPS is detected), `true`, `false`. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` from a reverse proxy. |
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

## Backup and restore

Everything is in `./data`: the SQLite database (`text2mindmap.db` plus `-wal`/`-shm` files) and `secret.key`.

```bash
docker compose stop
tar czf text2mindmap-backup-$(date +%F).tgz data .env
docker compose start
```

Restore by putting `data/` (and `.env`) back and running `docker compose up -d`. Keep `secret.key` (or `APP_SECRET`) with the database: without it the API key saved in Settings cannot be decrypted (you can re-enter it).

## Security notes

- The API key is never returned by any endpoint. Responses only say whether a key is set. A key saved in Settings is encrypted at rest; a key in `LLM_API_KEY` stays in your environment.
- Every API endpoint requires login except `/api/health`, `/api/setup` (only works while no user exists) and `/api/auth/login`. Without login, nobody can spend your LLM quota.
- Passwords are hashed with scrypt. Sessions are random tokens (stored hashed) in an `HttpOnly`, `SameSite=Lax` cookie. Failed logins are rate-limited (10 per 15 minutes per IP).
- State-changing requests must be JSON and same-origin (CSRF protection).
- Serve it over HTTPS when it is reachable from the internet, and set `TRUST_PROXY=true` behind a proxy so rate limiting sees real client IPs.
- The LLM receives the text you paste. Use a provider you trust with it.

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

Only the free plugins shipped in the `simple-mind-map` npm package are used. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for all bundled packages and their licenses.

text2mindmap is released under the [MIT License](LICENSE). © 2026 Shayne Wang
