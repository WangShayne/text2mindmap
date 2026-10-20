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
- **文档**：新建、重命名、删除、导入 `.md`、自动保存、一键复制 Markdown。
- **导出**：Markdown、PNG、SVG、PDF、XMind（浏览器端）；OPML、JSON（服务端）。
- **管理员设置**：Base URL、模型名、API Key（加密存储，永远不会发给浏览器）、可编辑的系统提示词（可恢复默认）、「测试连接」按钮，能区分 Key 错误（401）、地址错误或网络不通、模型不存在（404）。
- **单管理员账号**：首次启动时创建，不开放注册。数据都在一个 SQLite 文件里。
- 界面支持中文和英文。

## 快速开始（Docker Compose）

```bash
git clone https://github.com/WangShayne/text2mindmap.git
cd text2mindmap
cp .env.example .env        # 填 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（也可以之后在「设置」里填）
docker compose up -d --build
```

打开 <http://127.0.0.1:3000>。首次启动会显示一次性的初始化页面，用来创建管理员账号（也可以在 `.env` 里设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 自动创建）。请尽快完成：管理员创建之前，任何能访问这个页面的人都可以抢先创建。

默认只绑定 `127.0.0.1`。对外提供服务时，请在前面加一层带 HTTPS 的反向代理（Caddy、nginx、Traefik），并设置 `TRUST_PROXY=true`；或者设置 `BIND_ADDRESS=0.0.0.0` 直接暴露端口。

镜像由 `Dockerfile` 在本地构建（多阶段构建，运行镜像里只有 Node 和打包好的程序，约 170 MB），目前没有发布预构建镜像。

### 调用宿主机上的模型

容器里的 `localhost` 指的是容器自己。要访问宿主机上的模型服务（比如 11434 端口的 Ollama），在 `docker-compose.yml` 的服务下加上下面的配置，然后用 `http://host.docker.internal:11434/v1`：

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

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
| `MAX_INPUT_CHARS` | `200000` | 单次最多接受的输入字数。 |
| `APP_SECRET` | 自动生成 | 用来加密「设置」里保存的 API Key（AES-256-GCM，密钥用 HKDF 派生）。不填时会随机生成并保存到 `data/secret.key`，同时在日志里给出警告。 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 空 | 首次启动时直接创建管理员，不用初始化页面。已有用户后忽略。 |
| `COOKIE_SECURE` | `auto` | 会话 Cookie 的 `Secure` 标记：`auto`（检测到 HTTPS 时开启）、`true`、`false`。 |
| `TRUST_PROXY` | `false` | 信任反向代理传来的 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`。 |
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

## 备份和恢复

所有数据都在 `./data` 目录：SQLite 数据库（`text2mindmap.db` 以及 `-wal`、`-shm` 文件）和 `secret.key`。

```bash
docker compose stop
tar czf text2mindmap-backup-$(date +%F).tgz data .env
docker compose start
```

恢复时把 `data/`（和 `.env`）放回原处，再执行 `docker compose up -d`。`secret.key`（或 `APP_SECRET`）要和数据库一起保存：没有它，「设置」里保存的 API Key 就解不开了（重新填一次即可）。

## 安全说明

- 任何接口都不会返回 API Key，只会告诉前端「是否已设置」。在「设置」里保存的 Key 加密存储；写在 `LLM_API_KEY` 里的 Key 只存在于你的环境变量中。
- 除了 `/api/health`、`/api/setup`（只在还没有用户时可用）和 `/api/auth/login`，所有接口都要登录，别人拿到地址也用不了你的模型额度。
- 密码用 scrypt 哈希。会话是随机令牌（数据库里只存哈希），放在 `HttpOnly`、`SameSite=Lax` 的 Cookie 里。登录失败有频率限制（每个 IP 15 分钟内最多 10 次）。
- 修改数据的请求必须是 JSON 且同源（防 CSRF）。
- 对公网开放时请使用 HTTPS；放在反向代理后面时设置 `TRUST_PROXY=true`，频率限制才能拿到真实 IP。
- 你粘贴的文本会发给模型服务商，请选择你信得过的服务。

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

只使用了 `simple-mind-map` npm 包自带的免费插件。所有打包进来的第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

text2mindmap 使用 [MIT 许可证](LICENSE)。© 2026 Shayne Wang
