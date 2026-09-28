# Agent 回复朗读（TTS）— 设计

状态：**§8 第 1–4 步（后端 + 前端）已实现（dev3，2026-09-28），未提交**。第 5 步只在 Chrome 里用拦截的假音频跑过，还没接真实 Azure、也没测 Safari。首个供应商用 Azure Speech，结构上按「供应商注册表」来做，以后接 OpenAI / ElevenLabs / 浏览器本地 TTS 只需加一项。

## 1. 目标与非目标

**目标**

- 悬停 agent 回复时，复制按钮右边多一个喇叭按钮（`Volume2`），点击朗读这条回复。
- 读的是**可听的文本**，不是 markdown 源码：不念 `**`、`#`、表格竖线，也不逐字念代码。
- 长回复要尽快出声，不能等整段合成完再放。
- 同一时刻只播一条；点另一条的喇叭会先停掉当前这条。
- 供应商可替换：密钥、音色列表、SSML 细节都只放在供应商实现里，路由、前端播放器和设置页都不写死 Azure。

**非目标（v1 不做）**

- 自动朗读新回复、边生成边读（streaming 中的消息不给按钮）。
- 逐词高亮 / 跟读。
- 服务端音频缓存、按量计费、用量面板。
- Main Chat / Project Chat 的消息。按钮做成通用组件，之后直接挂上去即可（§6.4）。

## 2. 总体结构

```
AssistantMessage ─ <SpeakButton text={content}>
        │  toSpeakableText(markdown) → chunkForSpeech(text)
        ▼
  ttsPlayer（前端单例，外部 store）
        │  每段一次 POST /api/tts/synthesize  { text, voice? }（语速在播放时由 audio.playbackRate 施加）
        ▼
  hub: tts-routes.ts ── requireAuth + resolveUserId
        │  getTtsConfig(storage, userId) → TTS_PROVIDERS[provider].synthesize(...)
        ▼
  Azure Speech REST（经 proxyManager 的 dispatcher 出站）
```

**关键决定：合成在 hub 上做，worker 不参与。**消息正文在浏览器里本来就有，远程会话也一样。所以 TTS 调用走「浏览器 → hub → 供应商」，隧道契约不变，`reverse-connect-capabilities` 不用加条目，**也不用发 worker**。密钥跟 chat provider 一样按用户存在 hub 的 `user_settings` 里。

## 3. 后端

### 3.1 供应商注册表 `packages/vibedeckx/src/tts/providers.ts`

照 `utils/chat-model.ts` 的 `PROVIDERS` 来写：供应商相关的东西只出现在这一个文件里。

```ts
export type TtsProviderId = "azure";            // 以后：| "openai" | "elevenlabs"

export interface TtsCredentialField {
  key: string;                 // "apiKey" | "region" | "endpoint" …
  label: string;
  secret: boolean;             // true → GET 时打码，PUT 时原样回传打码值 = 不改，空串 = 清空
  envKey?: string;             // 没存值时回退的环境变量
  placeholder?: string;
}

export interface TtsVoice {
  id: string;                  // 供应商自己的音色 id，例如 "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural"
  label: string;
  locale?: string;
  multilingual?: boolean;
  group?: string;              // 供应商定义的分组名（"HD Omni"、"Multilingual"…），选择器按出现顺序分组
}

export interface SynthesizeRequest {
  text: string;                // 已经是纯文本，供应商负责自己的转义 / SSML
  voice: string;
  // 没有 rate：语速是播放端的事（audio.playbackRate），见 §3.7
  signal: AbortSignal;
  dispatcher?: Dispatcher;     // proxyManager.getFetchDispatcher()
}

export interface SynthesizeResult {
  audio: ReadableStream<Uint8Array>;   // 直接 pipe 给响应，不在内存里攒整段
  contentType: string;                 // "audio/mpeg"
}

export interface TtsProviderDef {
  id: TtsProviderId;
  label: string;
  credentialFields: readonly TtsCredentialField[];
  defaultVoice: string;
  /** 单次请求的文本上限（字符数）。前端按它分段，路由也按它拒绝超长请求。 */
  maxCharsPerRequest: number;
  /** 音色 id 的语法校验，防止未校验的值进到 SSML / 请求里。 */
  isValidVoice: (voice: string) => boolean;
  listVoices: (creds: Record<string, string>, opts: { signal: AbortSignal; dispatcher?: Dispatcher }) => Promise<TtsVoice[]>;
  synthesize: (creds: Record<string, string>, req: SynthesizeRequest) => Promise<SynthesizeResult>;
}

export const TTS_PROVIDERS: Record<TtsProviderId, TtsProviderDef> = { azure: azureProvider };
```

供应商统一抛 `TtsProviderError { kind: "auth" | "quota" | "bad_request" | "upstream" | "network" }`。路由层据此映射 HTTP 状态码，不去解析各家的错误体。

### 3.2 Azure 实现 `tts/azure.ts`

- 凭据字段：`apiKey`（secret，env `AZURE_SPEECH_KEY`）、`region`（env `AZURE_SPEECH_REGION`，例如 `southeastasia`）。
- 合成：`POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`
  - 请求头：`Ocp-Apim-Subscription-Key`、`Content-Type: application/ssml+xml`、`X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3`、`User-Agent: vibedeckx`
  - 请求体：`buildSsml({ text, voice })`，text 必须做 XML 转义（`& < > " '`）。**不发 `<prosody>`**：HD 声音不支持它（见 §3.7）。`xml:lang` 取音色的 locale。
- 音色：`GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list`。只保留 Neural 音色，hub 进程内按 region 缓存 24h。
- **默认音色用 Dragon HD Omni**（`zh-CN-Xiaoxiao:DragonHDOmniLatestNeural`，2026-09-28 从 `zh-CN-XiaoxiaoMultilingualNeural` 改过来）。Omni 是新一代基础模型，700 多个声音全部支持多语言、自动识别语种，agent 回复中英混杂也不用我们做语种检测。
- **HD 声音只在部分区域可用**（2026-09 文档：canadacentral、centralindia、eastus、eastus2、francecentral、southeastasia、swedencentral、westeurope、westus2；eastasia 不在内）。不在代码里写死区域表（会过时）：HD 声音收到 400 时，错误信息附一句「HD voices are only available in some Azure regions」。Region 输入框示例用 `southeastasia`。
- 声音列表：HD 声音不论 `VoiceType` 标什么都保留，按 HD Omni → HD → Multilingual → Standard 分组。音色 ID 允许下划线（Omni 有 `zh-cn-yunze_customer:…` 这类名字）。
- `maxCharsPerRequest`：1500。Azure 单次上限是 10 分钟音频，这里主要是为了首段延迟，不是贴着上限走。
- 状态码映射：401/403 → `auth`，429 → `quota`，400 → `bad_request`，5xx → `upstream`。

### 3.3 配置 `tts/config.ts`

存在 `user_settings`，key 为 `"tts"`。跟 chat provider 一样按用户隔离，solo 模式下 userId 是 `"local"`：

```ts
interface TtsConfig {
  provider: TtsProviderId;
  /** 按供应商分开存。切换供应商不会丢掉另一家的密钥。 */
  credentials: Partial<Record<TtsProviderId, Record<string, string>>>;
  voice: string;          // 属于当前 provider；非法时归一到 defaultVoice
  rate: number;           // 钳到 [0.5, 2]
}
```

- `parseTtsConfig(raw)`：纯函数，用来归一和兜底，写法同 `parseChatProviderConfig`。
- `resolveCredentials(config)`：先取存的值，再回退 `envKey`。
- `isTtsConfigured(config)`：所有非可选字段都有值才算配好。

### 3.4 路由 `routes/tts-routes.ts`

每条路由都走 `requireAuth` + `resolveUserId`。

| 路由 | 说明 |
|---|---|
| `GET /api/settings/tts` | 返回 `{ provider, credentials(secret 打码), voice, rate, configured, providers: [{id,label,credentialFields,defaultVoice,maxCharsPerRequest}] }`。前端设置页完全由这份元数据渲染 |
| `PUT /api/settings/tts` | 用 `userSettings.update` 原子合并。字段不传表示不改；secret 字段原样回传打码值也表示不改，传空串表示清空；换 provider 时如果 voice 不属于新 provider，重置为 defaultVoice |
| `GET /api/tts/voices?provider=` | 调 `listVoices`，按「provider + 凭据哈希」在进程内缓存 24h。未配置返回 409 `tts_not_configured` |
| `POST /api/tts/synthesize` | body `{ text, voice? }`，返回正常语速的 `audio/*` 流 |

`synthesize` 的约束：

- 去掉首尾空白后 text 不能为空，长度 ≤ 当前 provider 的 `maxCharsPerRequest`，否则返回 400。分段是客户端的事，服务端只负责兜底拒绝。
- 未配置时返回 **409 `{ code: "tts_not_configured" }`**，前端据此给出「去设置」的引导，不当成普通错误处理。
- 错误映射：`auth` → 502 `tts_auth_failed`（不返回 401，免得前端以为是 Clerk 登录失效），`quota` → 429，其它 → 502。
- body 可带 `voice` 覆盖存储值（设置页试听未保存的音色时用）；voice 要过 provider 的 `isValidVoice`。
- 请求中断时（`reply.raw` 的 `close` 事件且响应未写完）abort 上游 fetch，这样停止播放能真正省掉 Azure 的调用。另有 60s 总超时，免得挂住的上游一直占着并发名额。
- 每个用户最多 2 个并发合成（进程内计数）。播放器最多同时发出「当前段 + 预取段」两个请求，所以这个上限足够，还能防止脚本把别人的额度刷爆。和 chat API 的 64KB 上限一样属于纵深防御。
- 日志只记长度、provider 和耗时，**不记文本**（回复里可能有代码或密钥片段），也不记密钥。

### 3.5 出站代理

合成和取音色列表都带上 `dispatcher: fastify.proxyManager.getFetchDispatcher()`。部署在需要代理才能出网的机器上时，TTS 跟设置页里配的代理走同一条路。

### 3.6 为什么传文本，不传消息 id

另一种做法是 `POST /api/tts/synthesize { sessionId, entryIndex, chunk }`，由 hub 自己去找正文。不这么做，理由如下：

1. **远程会话的正文不在 hub 上。** 正文存在 worker 的 SQLite 里。hub 上只有 `RemotePatchCache` 一份内存缓存，会按 LRU 淘汰，也会截断。要可靠地按 id 取正文，得新增一个 hub→worker 路由：要登记 capability、发 worker、兼容旧 worker 返回的 404。这正好推翻了「TTS 不碰 worker」这个最大的简化。
2. **文本也不是只从消息来。** 设置页的试听和以后的 Main Chat 都没有 agent entry id，所以按文本合成的接口反正要有一个。做 id 接口就等于要维护两个接口。
3. **分段放在客户端更简单。** 用 id 的话，markdown 转朗读文本和分段就得挪到服务端，前端还得额外问一次「一共几段」才能显示进度和预取。纯文本接口保持「一段文本进、一段音频出」，服务端没有状态。
4. **传文本没有越权问题。** 能发出这段文本的用户本来就能看到它。用 id 的话，反而要给每个会话补一道「这个会话属于你」的鉴权，多一个可能出错的地方。

id 方案真正的好处是**服务端能决定念什么**，也就是只能念 transcript 里有的内容，没法把 hub 当成通用 TTS 代理来刷额度。这一点只在「运维给全站配了 env key、又不信任用户」时才重要。用户自带 key 时，只能刷自己的额度。目前靠登录、单段长度上限和并发上限已经够了。如果以后真有滥用，优先加按用户的字数配额，而不是改成按 id 合成。

请求体的大小也不是问题：一段不超过 1500 字符，比返回的音频小两个数量级。
### 3.7 语速在播放端（2026-09-28 改）

最初用 SSML `<prosody rate>` 让 Azure 直接合成出快/慢的语音。改为播放端 `audio.playbackRate`，合成一律按正常语速，理由：

- Azure 的 HD 声音（Dragon HD / Omni）**不支持 `<prosody>`**，默认声音换成 Omni 后原方案直接失效。
- 语速参数各家 TTS 都不一样，放在播放端就和供应商无关，符合注册表的初衷。
- 改语速不用重新合成，缓存可复用。

代价：`playbackRate` 是对音频做时间伸缩，极端倍速下不如模型原生调速自然；设置范围本来就限定在 0.5–2×。浏览器默认 `preservesPitch`，不会变调。实现细节：浏览器加载新 `src` 时会把 `playbackRate` 重置为 `defaultPlaybackRate`，所以两个都要设（真实 Chrome 实测：只设 `playbackRate` 的话换 src 后回到 1×）。

## 4. 前端

### 4.1 纯函数（`lib/tts/`，都有单测）

**`toSpeakableText(markdown): string`**

| 输入 | 处理 |
|---|---|
| 围栏代码块 | 念成「一段 12 行的 TypeScript 代码」/ "a 12-line TypeScript code block"，语言取围栏标注（没有就只说行数），中英按周围文字的语种选 |
| 行内 `code` | 保留内容，去掉反引号（通常是文件名或命令名，念出来有意义） |
| 链接 `[t](u)` | 只念 t；裸 URL 念成「链接」 |
| 标题 / 强调 / 引用 / 列表标记 | 去掉标记，保留文字，标题后补句号 |
| 表格 | 逐行拼成「列1，列2。」 |
| 图片、HTML 标签、`<vfile/>` 之类的内部标记 | 删除 |
| 连续空白 | 压缩 |

用 `marked` 的 lexer 遍历 token 实现，不用正则硬扒。marked@16 本来就是 streamdown 的依赖，只是提成了直接依赖，不会多下载东西。

另有 `hasSpeakableContent(markdown)`：不计代码块播报，只看有没有正文。整条回复只有代码块时只会念「Shell code block, 1 line」，毫无意义，所以不给按钮。

**`chunkForSpeech(text, maxChars): string[]`**

先按段落切，再按句末标点（`。！？.!?` 以及换行）切，然后贪心合并到 ≤ maxChars。单句超长时按逗号切，最后才硬切。**第一段刻意切短（约 200 字）**，这样首段合成快，大约 1 秒内就能出声；后面的段落再放大到 maxChars。

### 4.2 播放器单例 `lib/tts/tts-player.ts`

外部 store，组件通过 `useSyncExternalStore` 订阅（Main Chat 的 ChatStream 也是这个模式）：

```ts
type TtsState =
  | { status: "idle" }
  | { status: "loading" | "playing"; ownerKey: string; chunk: number; total: number }
  | { status: "error"; ownerKey: string; code: "not_configured" | "failed"; message: string };

ttsPlayer.play(ownerKey, markdown)   // 如果有别的 owner 在播，先停掉
ttsPlayer.stop()
ttsPlayer.subscribe / getSnapshot
```

- **只用一个 `HTMLAudioElement`**，在点击的同步调用栈里创建或复用并先 `play()` 一次解锁。后面每段只换 `src`，这样异步拿到音频后也不会被浏览器的 autoplay 策略拦下（Safari 尤其严格）。
- 流水线：播第 n 段的同时预取第 n+1 段，最多 2 个请求在途。每段的音频转成 `URL.createObjectURL`，播完 `revokeObjectURL`。
- `stop()`：abort 所有在途 fetch，暂停 audio，释放 blob URL，状态回到 idle。
- 同一 owner 的最近一次合成结果按 `text + voice` 缓存（不含语速，改语速后可直接复用）在内存里，只留最后一条。重播同一条回复时直接出声，不再调 Azure。
- 切换会话或卸载对话面板时调用 `stop()`。单条消息卸载（例如滚动虚拟化）**不**停止播放：状态在外部 store 里，消息重新挂载后会重新接上。
- `ownerKey` = `${sessionId}:${entryIndex}:${内容 hash}`。`entryIndex` 是持久化的 entry 下标（即对话列表的 `messageEntryIndices`），用来区分内容相同的两条回复；不用 `messageIndex`，因为它是数组下标，加载更早的历史时会整体偏移。

### 4.3 按钮 `components/agent/speak-button.tsx`

通用组件，签名为 `<SpeakButton ownerKey text />`，放在 `AssistantMessage` 的复制按钮之后：

| 状态 | 图标 | 可见性 | 点击 |
|---|---|---|---|
| idle | `Volume2`（喇叭） | 跟其它按钮一样，hover / focus 时才显示 | 播放 |
| loading（本条） | `Loader2` 旋转 | **常显** | 停止 |
| playing（本条） | `Volume2` 高亮 + 脉动 | **常显**，title 带 `(2/5)` 段进度 | 停止 |
| error（本条） | `VolumeX` + title 显示原因 | 常显约 3s 后回到 idle | 重试 |

- 正在播放或加载时必须常显，不能只靠 hover，否则鼠标一移开用户就找不到停止按钮。
- `streaming` 为 true 时不渲染按钮，内容还没写完。
- `hasSpeakableContent` 为假（整条都是代码块）时不渲染按钮。
- `not_configured`：弹出 toast，提示去 Settings → Speech 配置。设置页目前没有按分区深链的机制，所以 toast 里没有链接。
- v1 只做「播放 / 停止」，不做暂停。回复一般只有几十秒，暂停会让按钮多一个状态；以后有需要可以在 `Square` 旁边加。
- aria-label：`Read aloud` / `Stop reading`，与 copy 按钮的 `Copy source` 保持同一风格。

### 4.4 设置页 `components/settings/tts-settings.tsx`

settings-view 里新增「Speech」分区，放在 Chat provider 之后：

- Provider 下拉框（v1 只有 Azure，也照样渲染，给以后的供应商留好位置）。
- 凭据输入框**由 `credentialFields` 元数据生成**：secret 字段用 password 输入框，显示打码值，只有被改动过的字段才提交，逻辑同 chat-provider-settings 的 `keyDirty`。
- Voice：可搜索的下拉框（Popover + Command），保存凭据后调 `GET /api/tts/voices` 加载，按供应商给的 `group` 分组。当前选中的声音即使不在列表里也会显示；搜索框里可以直接输入任意声音 ID（「Use …」项），保存时由服务端校验。
- Speed 滑块：0.5–2.0，播放时生效。
- 「试听」按钮：用同一个 `ttsPlayer` 念一句固定示例，顺便验证密钥和 region。
- 说明文字：「朗读时，消息文本会发送给所选语音服务商」。

`lib/api.ts` 里加 `getTtsSettings` / `updateTtsSettings` / `listTtsVoices` / `synthesizeSpeech(text, {signal}) → Blob`，都走 `authFetch`。

## 5. 以后怎么加一个供应商

以 OpenAI 为例：

1. `tts/openai.ts`：实现 `TtsProviderDef`。凭据是 `apiKey`（env `OPENAI_API_KEY`）；`voices` 是固定列表；`synthesize` 调 `/v1/audio/speech`，返回的 body 流直接透传。
2. 在 `TtsProviderId` 和 `TTS_PROVIDERS` 里各加一项。
3. 不用改其它地方：路由、配置归一、设置页和播放器都只认注册表。

浏览器本地的 `speechSynthesis`（零成本、无需密钥）不适合放进服务端注册表。以后要支持的话，在前端 `ttsPlayer` 下面加一层 `TtsBackend` 接口（`remote` = 现在这条 HTTP 路径，`browser` = Web Speech），设置里的 provider 值 `"browser"` 就不经过 hub。v1 不做，但 `ttsPlayer` 内部应该把「拿音频」和「播音频」分成两个函数，给这一步留出口。

## 6. 其它考虑

1. **兼容性**：只改 hub 和前端，隧道契约与 capability 注册表都不动，不需要发 worker。
2. **隐私**：功能默认关闭，要用户自己配置密钥才会启用，设置页写明文本会发给第三方；服务端不落盘、不记录文本。
3. **多租户**：密钥按用户存。SaaS 模式下每个用户用自己的 Azure 额度；运维也可以用环境变量给全站一个默认 key。环境变量的回退对所有用户生效，跟 chat provider 的行为一致，要在部署文档里写明。
4. **Main Chat 复用**：`SpeakButton` 和 `ttsPlayer` 都不依赖 agent 会话，Project Chat 的助手消息只需要传入 `ownerKey = chat:${threadId}:${messageId}`。

## 7. 测试

- 后端：`parseTtsConfig` 的归一与兜底；PUT 合并（secret 打码不覆盖、换 provider 时重置 voice）；Azure `buildSsml` 的转义且不含 prosody；synthesize 路由（mock fetch，覆盖超长、未配置 409、401→502、客户端断开时 abort 上游）；并发上限。
- 前端：`toSpeakableText` / `chunkForSpeech` 的表驱动用例（中英混合、代码块、表格、超长单句）；`ttsPlayer` 的状态机（mock Audio 与 fetch：切换 owner 会停掉前一个、stop 会 abort、预取不超过 2 个）；`SpeakButton` 仿照 `agent-message.copy-source.test.tsx`，覆盖 aria-label 切换、streaming 时不渲染、播放中常显。
- 真机：用 Azure 试用 key 在 Chrome 和 Safari 上各跑一次长回复，确认首段延迟和段落衔接没有明显停顿。

## 8. 实施顺序

1. 后端注册表 + Azure + config + 路由 + 单测。可以用 curl 单独验证。
2. 前端 `lib/tts` 纯函数 + 播放器 + 单测。
3. `SpeakButton` 接入 `AssistantMessage`。
4. 设置页 Speech 分区 + 试听。
5. 真机验证（Chrome / Safari，本地会话和远程会话各一次）。

## 9. 已定事项（2026-09-28）

- 代码块念成「一段 N 行的 X 代码」（§4.1）。
- v1 只做播放 / 停止，不做暂停（§4.3）。
- 不设每日字数配额，只保留并发上限（§3.4）。以后如果全站 key 被滥用再加。
- 合成接口直接传文本，不传消息 id（§3.6）。
