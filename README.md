# dsh-tts-reader

把助手的回答**默认用小艺（`zh-CN-XiaoyiNeural`）的声音念出来**。

它替换掉 SKILL `multilingual-tts-audio` 那条路子：那个 SKILL 每次都要
`uv run --with edge-tts python …`（解析依赖 + 起 Python + 等整个 MP3 写完），而且要我
**主动**去调它。这个插件常驻进程内、逐句流式合成，而且边写边念。

## 两个入口

| 位置 | 作用 |
|---|---|
| 输入框右侧的喇叭 | 整个会话的实时朗读开关（**默认开**），状态存在 `localStorage` |
| 每条回答下方的喇叭 | 在「显示 / 复制 / 点赞 / 用量 / 时间」那一行，**重读这一条**；再点一下停 |

两者是**独立的两条队列**：点「重读某条」会临时接管扬声器（否则两边抢着说话），
读完自动把实时朗读接回——从**下一句**开始，不补播期间错过的内容。
实时朗读不受影响：它的队列和游标始终是分开的。

## 它是怎么工作的

```
agent/assistant-stream            GET /dsh-tts/tail?session=…&since=…
   （模型正在写的原文）                  （base64 MP3，按句游标拉取）
        │                                       ▲
        ▼                                       │
   lib/index.js  ──► lib/feed.js ──► lib/edge-tts.js
   宿主半边           逐句队列          零依赖 Edge TTS 客户端
                                              │
   Session.snapshotEvents()  ────────────────┤
   （某条历史回答的正文）  GET /dsh-tts/message?session=…&id=…&since=…
        │                                     │
        └──────────────► lib/feed.js ─────────┤
                                              │
                              lib/client.js ──┘
                              页面半边：Web Audio 无缝连播 + 两个开关
```

- **为什么在宿主侧合成**：Edge 的朗读服务只在请求带浏览器 `User-Agent` 时才
  101 升级，而浏览器的 `WebSocket` 无法自定义请求头；Node 可以，所以合成放在宿主侧。
- **为什么监听 `agent/assistant-stream`**：这是模型输出的**原始流**，比 DOM 早。
  一句话在屏幕上还没排完，声音已经出来了。
- **「重读某条」的正文从哪来**：`ctx.sessions.get(id).snapshotEvents()` 里那条
  `assistant/message` 事件带的 `stream` 正是可见正文（不含推理和工具调用）。
  被查看的会话一定是活的，所以**整个可见历史都能读**，不受插件安装时间限制。
- **为什么是"拉"而不是"推"**：页面每 400 ms 用游标拉一次。没人拉就不合成，
  没有听众的会话不花任何代价。

## 改代码之后怎么生效

| 改了哪半边 | 生效方式 |
|---|---|
| `lib/client.js` | **刷新页面**即可（Ctrl+F5 / CDP reload）——客户端 bundle 按 URL 现取 |
| `lib/index.js` / `lib/feed.js` / `lib/edge-tts.js` | **必须重启应用**。宿主模块被 Node 的 ESM 缓存按 URL 锁住，`plugin_manager` 关掉再打开条目**没有用**（实测：路由依旧 404） |

⚠️ 实测警告：往 profile patch 的 `hmr` 条目里加 `root` 目录（见下）**并没有**让宿主
半边热重载——配完之后改文件，`/dsh-tts/message` 依旧 404。该配置先留着，重启后再验证一次
是否生效；在那之前，**改宿主半边一律按"要重启"来预期**。

另外：**别用 `plugin_manager set_plugin` 去关/开这个插件**。实测这会留下半死状态——
路由还在，但 `agent/assistant-stream` 监听被停掉，于是不再产生新句子、实时朗读静默失效，
而条目看起来是 enabled。要停就用输入框那个喇叭按钮。

## 配置

改 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里 `dsh-tts-reader` 那条的 `config`
（本插件没有导出 `Config` schema，Cordis 会把整块 config 原样交给 `apply`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 宿主侧总开关 |
| `voice` | `zh-CN-XiaoyiNeural` | Edge TTS 短名，启动时向官方声音目录核对 |
| `rate` / `volume` / `pitch` | `+0%` / `+0%` / `+0Hz` | 合成参数 |
| `maxPerRequest` | `3` | 每次拉取最多返回几句 |

## 朗读内容会怎么处理

念的是**给人听的**版本，不是屏幕上的 Markdown：

- 围栏代码块 → 整块丢掉（念代码没有意义）
- 行内代码 → 保留里面的字
- 表格 → 单元格用「，」连起来，分隔行丢掉
- 链接 → 只念文字，裸 URL 变成「链接」
- 标题 `#`、加粗 `**`、引用 `>`、列表符号 → 去掉
- **推理过程和工具调用参数永远不念**

## 两个协议坑（都实测过，别再踩）

1. **SSML 里必须写语音全名。**
   `zh-CN-XiaoyiNeural` 是短名，服务端只认
   `Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoyiNeural)`。
   写短名不会报错 —— 服务端接受 101 升级，然后**静默 reset 连接**。
   插件启动时拉一次官方声音目录做映射，离线兜底按 `locale-Name` 推导。

2. **二进制音频帧没有空行分隔。**
   帧结构是 `[2 字节大端头长度][ASCII 头][MP3]`，音频从 `headerLength + 2` 开始。
   不要去找 `\r\n\r\n` —— 找不到，会得到 0 字节"成功"。

另外：`Sec-MS-GEC` 必须用**浮点**算法（`ticks *= 1e9/100` 后取 `toFixed(0)`），
精确整数运算得到的是另一个哈希；`CHROMIUM_FULL_VERSION` 写死 `143.0.3650.75`，
微软轮换版本号时改这一行。

## 自测

```powershell
cd E:\development\dsh-tts-reader
node test/feed.mjs        # 逐句队列：游标、预热、失败、剪枝（纯离线）
node test/client-load.mjs # 客户端半边：模块封装、槽位注册、渲染（纯离线）
node test/host-e2e.mjs    # 宿主半边端到端：假事件 → 真路由 → 真 MP3（需联网）
node test/smoke.mjs       # 语音目录 + 合成 + 文本清洗（需联网）
```

调试时 `$env:DSH_TTS_DEBUG=1` 会打印 WebSocket 帧级日志。
