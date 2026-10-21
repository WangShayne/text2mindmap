# ASR acceptance bench（语音识别验收测试）

用来在服务器上测语音识别服务（比如 SenseVoice）的**速度和准确率**，处理流程和 text2mindmap 浏览器端完全一样：

1. 用 ffmpeg 解码音频，转成 16kHz 单声道；
2. 用 `src/shared/wav.ts` 里同一套算法切段：每段不超过 28 秒，在窗口末尾 3 秒里找最安静的位置切；
3. 每段编码成 16 位 PCM WAV，**按顺序**（一次一个，跟一个浏览器一样）`POST {BASE}/audio/transcriptions`，字段 `model`、`response_format=json`；
4. 去掉 `<|zh|><|NEUTRAL|>…` 这类标签，按同样的规则拼接；
5. 输出：音频时长、段数、每段耗时、总耗时、实时率（RTF）、识别文本、和参考文本对比的字错率（CER）。

**注意**：脚本直接请求 ASR 服务，不经过 text2mindmap 的 `/api/transcribe`（那个接口要登录）。所以它测的是 ASR 服务本身 + 切段策略，不包括 text2mindmap 转发那一跳（转发是流式的，额外开销很小）。

服务器上**不需要装任何东西**：脚本在一次性的 `node:22-alpine` 容器里跑，ffmpeg 装在容器里，跑完容器自动删除。需要能拉取 `node:22-alpine` 镜像和 Alpine 的软件包。

## 在 green 上运行

```bash
# 1. 拿到脚本（任选一种）
cd ~/works/text2mindmap && git pull && cd scripts/asr-bench
#   或者不动现有仓库，单独下载：
# mkdir -p ~/asr-bench && cd ~/asr-bench && curl -L https://codeload.github.com/WangShayne/text2mindmap/tar.gz/main | tar xz --strip-components=3 text2mindmap-main/scripts/asr-bench

# 2. 通过 1panel-network 直连 SenseVoice 容器（推荐，和 text2mindmap 容器访问它的方式一样）
./run.sh

# 3. 或者走宿主机端口
NETWORK=host BASE=http://127.0.0.1:16661/v1 ./run.sh
```

结果在 `results/` 目录：`zh-5min.log` / `mix-50s.log` 是屏幕输出，`.json` 是完整数据（每段耗时和文本、CER 细节、完整识别结果）。把两个 `.log` 发回群里就行。

可调的环境变量：`BASE`（默认 `http://sensevoice:8040/v1`）、`NETWORK`（默认 `1panel-network`）、`MODEL`（默认 `sensevoice-small`）、`SEGMENT`（默认 28 秒）、`ASR_API_KEY`（默认空，不发 Authorization 头）、`FILES`（默认两个测试音频）。

测自己的音频：把文件放到这个目录，`FILES="my.mp3" ./run.sh`。如果旁边有同名的 `my.ref.txt`，会自动算 CER。

单独跑一个文件（有 Node 18+ 和 ffmpeg 的机器上）：

```bash
node bench.mjs --base http://127.0.0.1:16661/v1 --model sensevoice-small audio/zh-5min.m4a
node bench.mjs --help
```

## 测试音频

| 文件 | 内容 | 时长 | 来源 / 许可 |
|---|---|---|---|
| `audio/zh-5min.m4a` | 普通话朗读，27 句，1039 字 | 5:05 | Google FLEURS `cmn_hans_cn` 测试集，**CC BY 4.0** |
| `audio/mix-50s.m4a` | 中英混说（对话），11 句 | 0:51 | HKUST ASCEND 测试集，**CC BY-SA 4.0** |

都是**真人录音，不是 TTS**。参考文本是数据集自带的人工转写（`*.ref.txt`）。详细说明和署名见 [audio/ATTRIBUTION.md](audio/ATTRIBUTION.md)。这些音频不属于 text2mindmap 的 MIT 许可范围。

## 怎么看结果

- **RTF（实时率）** = 总耗时 / 音频时长。小于 1 表示比实时快。比如 RTF 0.1：5 分钟音频 30 秒识别完。录音场景下每段约 8 秒，只要单段耗时明显小于 8 秒，文字就能跟上说话速度。
- **单段耗时**：上传文件时，用户看到的进度就是每段耗时的累加。
- **CER（字错率）**：去掉标点和空格、统一大小写后，按字计算的编辑距离 / 参考字数。数字写法（两 / 2）、繁简体不同也算错，所以 CER 是偏保守的。
- 这里是**一个用户、顺序发送**的情况。SenseVoice 配了最多 2 个连接，多人同时用会排队。

## 在本地验证脚本（不需要真的 ASR 服务）

```bash
node mock-asr.mjs 18040 audio/zh-5min.ref.txt &      # 模拟服务：按时长返回参考文本，带 SenseVoice 标签，超过 30 秒报错
NETWORK=host BASE=http://127.0.0.1:18040/v1 ./run.sh
```

模拟服务是按时间顺序“念”参考文本的，第一个文件 CER 会是 0%；第二个文件时它已经念完了，会返回空文本（CER 100%），这是模拟服务的限制，不是脚本的问题。

## 维护

`wav.mjs` 是由 `src/shared/wav.ts` 生成的 JS 副本（`node scripts/asr-bench/build-wav.mjs`），这样脚本不需要 TypeScript 就能跑。`tests/asr-bench.test.ts` 会检查它是否和源码一致。

---

**English summary**: `./run.sh` benchmarks an OpenAI-compatible ASR server with the same 16 kHz WAV / ≤28 s quiet-point segmentation the text2mindmap browser uses, sending segments sequentially, and reports duration, segment count and latency, wall time, real-time factor, transcript and CER against a reference. It runs inside a throwaway `node:22-alpine` container (ffmpeg installed in the container), so the host needs only Docker. It talks to the ASR server directly, not through text2mindmap's `/api/transcribe`. Test audio is real human speech from FLEURS (CC BY 4.0) and ASCEND (CC BY-SA 4.0); see `audio/ATTRIBUTION.md`.
