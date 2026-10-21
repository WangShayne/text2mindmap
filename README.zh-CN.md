# text2mindmap

[English](README.md) | 简体中文

用任意 OpenAI 兼容的大模型，把文本整理成可编辑的思维导图。自部署，一个 Docker 容器就能跑。

粘贴文章、笔记或会议记录，模型会边生成 Markdown 大纲，导图边长出来。左边改 Markdown、右边改导图，两边始终同步。可以导出 Markdown、PNG、SVG、PDF、XMind 和 OPML。

## 功能

- **从文本生成**：支持任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、Kimi、OpenRouter、Ollama、New API / one-api 网关等）。流式返回，导图实时生长。中英文都可以。
- **长文本**：按段落切分，每段先整理成大纲，再合并成一棵树。
- **重新生成**：可以替换整个文档（会先确认，避免覆盖手动修改），也可以**扩展选中的节点**，为它生成子节点。
- **双向编辑**：左边是 Markdown 编辑器（CodeMirror 6），右边是思维导图（[simple-mind-map](https://github.com/wanglin2/mind-map)）。导图上 Tab 添加子节点、Enter 添加同级节点、F2 编辑、Del 删除、拖动节点可换父节点、Ctrl+Z / Ctrl+Y 撤销重做、`/` 展开收起。
- **停止**：生成过程中可以随时停止，会同时取消对模型的请求。模型如果返回的是段落文字而不是大纲，会自动重试一次，仍不行就给出明确的错误提示。
- **语音输入**：可以录音或上传音频文件，用任意 OpenAI 兼容的语音识别接口转成文字（自托管的 SenseVoice / Qwen3-ASR / Ming-3.0-asr-tiny，或云服务），文字会放进输入框。见[自托管语音识别](#自托管语音识别)。
- **文档**：新建、重命名、删除、导入 `.md`、自动保存、一键复制 Markdown。
- **导出**：Markdown、PNG、SVG、PDF、XMind（浏览器端）；OPML、JSON（服务端）。
- **管理员设置**：Base URL、模型名、API Key（加密存储，永远不会发给浏览器）、可编辑的系统提示词（可恢复默认）、「测试连接」按钮，能区分 Key 错误（401）、地址错误或网络不通、模型不存在（404）；「获取模型列表」按钮会调用服务商的 `/models` 接口，把模型列表放进可搜索的下拉框（也可以直接手动输入模型名）。
- **单管理员账号**：首次启动时创建，不开放注册。数据都在一个 SQLite 文件里。
- 界面支持中文和英文。

## 快速开始（Docker Compose）

```bash
git clone https://github.com/WangShayne/text2mindmap.git
cd text2mindmap
cp .env.example .env        # 填 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（也可以之后在「设置」里填）
docker compose up -d --build
```

打开 <http://127.0.0.1:3000> 创建管理员账号。初始化页面需要填写一个**一次性初始化码**，只有服务器管理员能在日志里看到：

```bash
docker compose logs text2mindmap | grep "SETUP CODE"   # 或者：cat data/setup-code
```

完成初始化之前，每次重启都会生成新的初始化码；管理员创建后，初始化码立即失效。输错初始化码有频率限制。也可以在 `.env` 里设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，首次启动时自动创建管理员。

默认只绑定 `127.0.0.1`。对外提供服务时，请在前面加一层带 HTTPS 的反向代理（见[反向代理](#反向代理)），或者设置 `BIND_ADDRESS=0.0.0.0` 直接暴露端口。

镜像由 `Dockerfile` 在本地构建（多阶段构建，运行镜像里只有 Node 和打包好的程序，约 170 MB），目前没有发布预构建镜像。

### 调用宿主机上的模型

容器里的 `localhost` 指的是容器自己。要访问宿主机上的模型服务（Ollama、New API、one-api、LM Studio 等），请用 `http://host.docker.internal:<端口>/v1`，例如：

```env
LLM_BASE_URL=http://host.docker.internal:11434/v1   # Ollama
LLM_BASE_URL=http://host.docker.internal:3001/v1    # 3001 端口上的 New API / one-api
```

`docker-compose.yml` 已经默认把 `host.docker.internal` 指向宿主机（`extra_hosts: host-gateway`）。模型服务要监听容器能访问到的地址（Ollama 需要设置 `OLLAMA_HOST=0.0.0.0`），不能只监听 `127.0.0.1`。

容器日志使用 `json-file` 驱动，单个文件最大 10 MB，最多保留 3 个。

## 配置项

所有配置都是环境变量（写在 `.env` 里）。模型相关的配置是默认值：管理员可以在「设置」里覆盖 Base URL、模型名、API Key 和系统提示词，覆盖的值保存在数据库里。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容接口地址，包含 `/v1`，程序会在后面拼上 `/chat/completions`。 |
| `LLM_API_KEY` | 空 | 以 `Authorization: Bearer …` 发送。本地模型可以不填。 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名。 |
| `LLM_TEMPERATURE` | 不发送 | 可选的采样温度。 |
| `LLM_TIMEOUT_MS` | `180000` | 单次模型请求的超时时间。 |
| `LLM_CHUNK_CHARS` | `12000` | 超过这个字数的文本会分段整理再合并。 |
| `MAX_INPUT_CHARS` | `200000` | 最多接受的输入字数。 |
| `ASR_BASE_URL` | 空（不开启语音输入） | OpenAI 兼容的语音识别接口地址，包含 `/v1`，程序会拼上 `/audio/transcriptions`。见[自托管语音识别](#自托管语音识别)。 |
| `ASR_API_KEY` | 空 | 语音识别服务的 Key，本地服务可以不填。 |
| `ASR_MODEL` | 空 | 语音识别模型名，比如 `SenseVoiceSmall`、`Ming-3.0-asr-tiny`、`gpt-transcribe`。 |
| `ASR_SEGMENT_SECONDS` | `28` | 每次请求的最长音频时长（5–600 秒）。服务商限制 30 秒时保持 28 以内。 |
| `ASR_TIMEOUT_MS` | `120000` | 单次识别请求的超时时间。 |
| `ASR_MAX_UPLOAD_MB` | `25` | `/api/transcribe` 单次上传上限。 |
| `APP_SECRET` | 自动生成 | 用来加密「设置」里保存的 API Key（AES-256-GCM，密钥用 HKDF 派生）。**建议设置。** 不填时会随机生成并保存到 `data/secret.key`，同时在日志里给出警告。 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 空 | 首次启动时直接创建管理员，不用初始化页面，也不需要初始化码。已有用户后忽略。 |
| `COOKIE_SECURE` | `auto` | 会话 Cookie 的 `Secure` 标记：`auto`（检测到 HTTPS 时开启）、`true`、`false`。 |
| `TRUST_PROXY` | `false` | **放在反向代理后面时必须设为 `true`**（或者设为前面代理的层数）。开启后信任 `X-Forwarded-For`、`X-Forwarded-Proto`、`X-Forwarded-Host`。见[反向代理](#反向代理)。 |
| `SESSION_DAYS` | `30` | 登录有效天数。 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 容器内的监听地址。 |
| `DATA_DIR` | Docker 里是 `/data`，否则是 `./data` | SQLite 数据库和 `secret.key` 的存放目录。 |
| `BIND_ADDRESS` / `HOST_PORT` | `127.0.0.1` / `3000` | `docker-compose.yml` 使用的端口映射。 |

## Markdown 和导图的对应规则

Markdown 是唯一的数据源。导图始终由 Markdown 生成，在导图上的修改会写回 Markdown。

- 文档只有**一个根节点**，就是一级标题 `# 标题`。
- `##` 到 `######` 按级别嵌套：一个标题是它上方最近的、级别更高的标题的子节点（跳级也可以）。
- 列表项（`-`、`*`、`+`、`1.`）是它上方标题的子节点，按缩进嵌套（Tab 算 4 个空格，缩进更深就是子节点）。
- 普通文字行会成为当前标题的子节点；紧跟在列表项后面、有缩进的行算作该列表项的续行。
- 代码块标记、引用符号、分隔线、空行、任务框（`[ ]`）以及推理模型输出的 `<think>` 内容都会被忽略。
- 如果顶层不止一个节点，就用文档标题作为根节点。

导图写回 Markdown 时使用统一格式：根节点用 `#`，标题类节点用 `##`–`######`，其余用 `- ` 列表，每级缩进两个空格。每个节点会记住自己原来是标题还是列表项，所以来回转换不会打乱结构。在导图上新建的节点沿用同级节点的类型。`**加粗**`、链接这类行内 Markdown 会作为普通文字保留在节点里。

### 双向同步的实现

1. 在编辑器里输入 → 250 毫秒防抖 → 把 Markdown 解析成树 → 渲染导图。
2. 在导图上修改 → 导图给出新的树 → 序列化成统一格式的 Markdown → **只有结构确实不同时**才更新编辑器，所以你自己的书写格式会保留。
3. 用两种方式避免循环触发：由导图写入编辑器的修改带有标记，不会再去重绘导图；程序记住导图当前显示内容对应的 Markdown，收到相同内容的变更事件（也就是自己渲染引起的回声）直接忽略。

导图渲染器被封装在一个小接口后面（`src/web/src/mindmap/adapter.ts`），Markdown 和树的互相转换在 `src/shared/` 里。以后想把 simple-mind-map 换成 mind-elixir 等其他库，只要再写一个适配器。

## 自托管语音识别

「生成」对话框可以先把语音转成文字，再生成导图：**录音**（每隔约 8 秒出一段文字），或者**上传音频文件**（mp3、m4a、wav、webm、ogg、flac 等）。识别结果会放进输入框，点「开始」之前可以先修改。

工作方式：浏览器用 Web Audio API 解码音频，统一转成 **16kHz 单声道 16 位 WAV**，再按「单段最长时长」切段（默认 **28 秒**，在说话停顿处切，不会把一个词切成两半）。各段依次发给 `POST /api/transcribe`，由服务端以流的方式转发到 `{ASR Base URL}/audio/transcriptions`（OpenAI 兼容的 multipart 格式，`response_format=json`，返回 `text` 或 `verbose_json` 也能识别）。服务端不做转码，所以 Docker 镜像里不需要 ffmpeg。ASR 的 Key 和 LLM 的 Key 一样加密保存，不会发给浏览器。

在 **设置 → 语音识别** 里配置（Base URL、模型名、API Key、单段最长时长、「测试连接」、「获取模型列表」），也可以用下面的 `ASR_*` 环境变量。只要提供 OpenAI 兼容的 `/v1/audio/transcriptions` 接口的服务都可以用：

| 方案 | Base URL / 模型名 | 说明 |
|---|---|---|
| **只有 CPU：SenseVoice-Small**，用 FunASR 的 [`sensevoice-server`](https://www.funasr.com/en/deploy/sensevoice-native-server.html) | `http://<主机>:8040/v1`，模型名 `SenseVoiceSmall`（以 `/v1/models` 返回的为准） | 小服务器首选。单个 C++ 程序，不需要 Python，GGUF 模型，自带 VAD。支持中文、粤语、英语、日语、韩语。作为独立的服务或容器跟 text2mindmap 一起跑。它本身没有鉴权，只监听 `127.0.0.1` 或内部 Docker 网络。 |
| **有 GPU：Qwen3-ASR** + vLLM | 例如 `vllm serve Qwen/Qwen3-ASR-1.7B` → `http://<主机>:8000/v1`，模型名 `Qwen/Qwen3-ASR-1.7B` | 准确率更高，支持多种语言，Apache-2.0。vLLM 版本和参数见模型卡片。 |
| **有 GPU：[Ming-3.0-asr-tiny](https://huggingface.co/inclusionAI/Ming-3.0-asr-tiny)**（inclusionAI，9B，MIT） | 你的服务地址 `/v1`，模型名 `Ming-3.0-asr-tiny` | 单卡可跑。需要用提供 OpenAI 兼容 `/v1/audio/transcriptions` 接口的服务来部署。 |
| **云服务：蚂蚁百灵 Ant Ling**（Ming-3.0-asr-tiny） | `https://api.ant-ling.com/v1`，模型名 `Ming-3.0-asr-tiny` | 单次请求最多 **30 秒、10MB**，只接受 WAV 或 MP3，只返回 JSON。默认设置（16kHz WAV、28 秒一段、`response_format=json`）已经满足。 |
| **云服务：OpenAI** | `https://api.openai.com/v1`，模型名 `gpt-transcribe` | 单次 25MB。OpenAI 已把 `whisper-1`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe` 标为弃用，新配置请用 `gpt-transcribe`。 |

没有 30 秒限制的服务可以把「单段最长时长」调大，比如 120 秒（每段约 3.8MB）。段越长，模型能参考的上下文越多，但文字出来得越慢。

**示例：SenseVoice 作为独立容器，和 text2mindmap 在同一个 Docker 网络里**（我们自己的演示环境就是这样部署的）：

- 按 [FunASR 的文档](https://www.funasr.com/en/deploy/sensevoice-native-server.html) 编译 `sensevoice-server`，打包成镜像（官方没有提供现成的镜像），容器名或服务名叫 `sensevoice`，监听容器内 `0.0.0.0:8040`，**不映射到宿主机端口**，只加入 text2mindmap 所在的网络。启动参数示例：`sensevoice-server -m model/sensevoice-small-q8.gguf -vad model/fsmn-vad.gguf --threads 8 --max-connections 2 --max-audio-seconds 300 0.0.0.0 8040`。
- 在 text2mindmap 的「设置 → 语音识别」里填：Base URL `http://sensevoice:8040/v1`，模型名 `sensevoice-small`（以 `/v1/models` 返回为准），**API Key 留空**（这个服务没有鉴权，留空时不会发送 `Authorization` 头），单段最长时长保持 28。
- 或者写进 `.env`：`ASR_BASE_URL=http://sensevoice:8040/v1`、`ASR_MODEL=sensevoice-small`。
- `--max-connections 2` 表示同时最多处理 2 个请求。text2mindmap 每个浏览器是一段一段依次发送的，人少的时候够用。

如果 ASR 服务跑在 Docker 宿主机上，Base URL 用 `http://host.docker.internal:<端口>/v1`，并且让它监听容器能访问到的地址（Docker 网桥，比如 `172.17.0.1`，不要只监听 `127.0.0.1`）。更省事的做法是把它作为同一个 `docker-compose.yml` 里的另一个服务，用 `http://<服务名>:<端口>/v1` 访问。

**录音必须用 HTTPS 访问**（浏览器只允许 `https://` 页面和 `http://localhost` 使用麦克风），上传音频文件不受影响。用 nginx / 1Panel 反代时，`client_max_body_size` 要大于一段音频的大小（nginx 默认 1MB，刚好够 28 秒一段；如果调大了单段时长，建议设成 `30m`）。

限制：音频是在浏览器内存里解码的，特别长的文件（超过 1 小时左右）在内存小的设备上可能很慢或失败，建议先切开。能上传哪些格式取决于浏览器能解码哪些格式（主流浏览器都支持 mp3、m4a/AAC、wav、ogg/opus、webm、flac）。

## 反向代理

放在反向代理后面时，**必须设置 `TRUST_PROXY=true`**。它的作用：

- **客户端 IP**：登录和初始化码的频率限制从 `X-Forwarded-For` 里取 IP，从右往左数第 `TRUST_PROXY` 个（也就是你的代理追加的那个地址），客户端自己伪造的 `X-Forwarded-For` 绕不过限制。不开启的话，所有访客都显示成代理的 IP，一个人输错密码就可能把所有人锁住 15 分钟。
- **Secure Cookie**：在默认的 `COOKIE_SECURE=auto` 下，`X-Forwarded-Proto` 为 `https` 时，会话 Cookie 会带上 `Secure` 标记。
- **同源检查**：用浏览器的 `Origin` 和 `X-Forwarded-Host` 比较（没有时用 `Host`）。

`TRUST_PROXY` 为 `false`（默认）时，所有 `X-Forwarded-*` 头都会被忽略。如果端口不经过代理也能直接访问，不要开启，否则客户端可以伪造这些头。有两层代理时（比如 Cloudflare → nginx → 应用）设为 `TRUST_PROXY=2`。

生成过程用 Server-Sent Events 流式返回，代理要关闭响应缓冲，并允许较长的读取时间。

**Caddy**（自动申请 HTTPS 证书，默认就会设置 `X-Forwarded-*`）：

```caddyfile
mindmap.example.com {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

**nginx**：

```nginx
server {
    listen 443 ssl http2;
    server_name mindmap.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 30m;   # 语音识别的音频分段

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        # Server-Sent Events（流式生成）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

## 备份和恢复

所有数据都在 `./data` 目录：SQLite 数据库（`text2mindmap.db` 以及 `-wal`、`-shm` 文件）、`secret.key`（只在没有设置 `APP_SECRET` 时存在），以及管理员创建之前的 `setup-code`。

```bash
docker compose stop
tar czf text2mindmap-backup-$(date +%F).tgz data .env
docker compose start
```

恢复时把 `data/`（和 `.env`）放回原处，再执行 `docker compose up -d`。

**迁移到另一台机器时，请复制整个 `data/` 目录，而不只是数据库文件。** 没有设置 `APP_SECRET` 时，加密密钥是自动生成在 `data/secret.key` 里的；缺了这个文件，「设置」里保存的 API Key 就无法解密（程序会退回使用 `LLM_API_KEY`，需要重新填写 Key）。建议在 `.env` 里设置 `APP_SECRET`（`openssl rand -hex 32`），并把 `.env` 和备份放在一起。

## 安全说明

- 任何接口都不会返回 API Key，只会告诉前端「是否已设置」。在「设置」里保存的 Key 加密存储；写在 `LLM_API_KEY` 里的 Key 只存在于你的环境变量中。
- 除了 `/api/health`、`/api/setup` 和 `/api/auth/login`，所有接口都要登录，别人拿到地址也用不了你的模型额度。
- 首次初始化需要一个随机的一次性初始化码（10 位），只打印在服务日志里，并保存在 `data/setup-code`（权限 0600）。比对使用恒定时间算法，输错有频率限制，管理员创建后立即失效。之后初始化接口关闭，也不开放注册。
- 密码用 scrypt 哈希。会话是随机令牌（数据库里只存哈希），放在 `HttpOnly`、`SameSite=Lax` 的 Cookie 里。登录失败有频率限制（每个 IP 15 分钟内最多 10 次）。
- 修改数据的请求必须是 JSON 且同源（防 CSRF）。
- 对公网开放时请使用 HTTPS；放在反向代理后面时设置 `TRUST_PROXY=true`（见[反向代理](#反向代理)）。
- 你粘贴的文本会发给模型服务商，音频会发给语音识别服务，请选择你信得过的服务。
- 语音识别的 Key 和 LLM 的 Key 规则一样：加密保存，任何接口都不返回。上传音频（`/api/transcribe`）需要登录，只接受 `audio/*` 类型（不是 CORS 简单请求类型，其他网站无法跨站提交），单次大小有上限，音频不会保存。

## 开发

需要 Node 22.13 及以上。

```bash
npm install
npm run dev        # API 服务，3000 端口，自动重载（数据在 ./data）
npm run dev:web    # Vite 开发服务器，5173 端口，/api 转发到 3000
npm test           # 单元测试和集成测试（使用模拟的 OpenAI 兼容服务）
npm run typecheck
npm run build && npm start
npm run license-check   # 依赖里出现 GPL/AGPL/LGPL/SSPL/BUSL/CC-NC 许可证时报错
npm run notices         # 重新生成 THIRD_PARTY_NOTICES.md
```

`npm run mock-llm` 会在 4010 端口启动一个模拟的 OpenAI 兼容服务（Key 是 `sk-test-secret`，模型是 `mock-model`），没有真实模型也能试用；`scripts/smoke.sh` 可以对运行中的实例做一遍端到端的接口检查。

## 致谢和许可证

本产品思维导图基于SimpleMindMap项目开发，版权归源项目所有（<https://github.com/wanglin2/mind-map>）。
The mind map in this product is built on the [SimpleMindMap](https://github.com/wanglin2/mind-map) project (MIT).

语音识别推荐自托管的 [SenseVoice](https://github.com/QwenAudio/SenseVoice) 模型（SenseVoice-Small，代码为 MIT 许可证，模型许可见其仓库），由 FunASR 的 `sensevoice-server` 提供服务。text2mindmap 不附带任何模型，语音识别服务需要自行部署。

只使用了 `simple-mind-map` npm 包自带的免费插件。所有打包进来的第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

text2mindmap 使用 [MIT 许可证](LICENSE)。© 2026 Shayne Wang

`scripts/asr-bench/audio/` 里的测试音频**不在 MIT 许可证范围内**，分别来自 Google FLEURS（CC BY 4.0）和港科大 ASCEND（CC BY-SA 4.0），详见 [scripts/asr-bench/DATA_LICENSE.md](scripts/asr-bench/DATA_LICENSE.md)。
