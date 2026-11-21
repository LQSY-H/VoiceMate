# VoiceMate HTTP API

界面（`app/web/app.js`）用的就是这套接口，脚本化调用同样可用。
所有接口只监听 `127.0.0.1:8099`，返回 UTF-8 JSON；错误统一是 `{"error": "中文说明"}` + 对应状态码。

- 基址：`http://127.0.0.1:8099`
- 前端实际调用时都用相对路径（`/api/...`）
- `/v1/*` 与 `/health` 会被透明转发给上游 `127.0.0.1:8080`

---

## 目录

- [状态](#状态)
- [合成](#合成)
- [角色](#角色)
- [提示词方案](#提示词方案)
- [预设文本](#预设文本)
- [气泡](#气泡)
- [虚拟声卡（可选）](#虚拟声卡可选)
- [错误码](#错误码)

---

## 状态

### `GET /api/state`

页面启动时拉一次，也用于轮询就绪状态。

```json
{
  "ready": true,
  "starting": false,
  "error": "",
  "uiPort": 8099,
  "apiPort": 8080,
  "presets": [],
  "texts": [],
  "chips": { "version": 1, "groups": [] },
  "mic": { "exeFound": false, "auto": "" }
}
```

| 字段 | 说明 |
| --- | --- |
| `ready` | 上游 `/health` 是否 200 |
| `starting` | 后台是否正在拉起上游 |
| `error` | 拉起失败时的原因 |
| `mic.exeFound` | `bin\VirtualMicPlayer.exe` 是否存在 |
| `mic.auto` | 自动挑到的虚拟声卡设备名 |

如果 `ready=false`，这个接口会顺手触发一次后台启动，稍后再查即可。

### `GET /api/health`

```json
{ "ready": true }
```

---

## 合成

### `POST /api/speech`

转发到上游 `POST /v1/audio/speech`。**流式**：`response_format=pcm` 时返回裸 PCM（16-bit little-endian、24 kHz、单声道），
`wav` 时返回完整 WAV。

请求头：`Content-Type: application/json`

```json
{
  "input": "你好，今天天气不错。",
  "instructions": "一位温柔的年轻女性，语速偏慢。",
  "voice": "my_voice",
  "response_format": "pcm",
  "cfg_scale": 2.0,
  "seed": 42
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 要朗读的文本，可含 `[笑]` 这类内联标记 |
| `instructions` | 否 | 提示词；缺省时上游用默认 |
| `voice` | 否 | 角色 id（不带 `.breeze`）；不传就是纯音色设计 |
| `response_format` | 否 | `pcm`（流式）/ `wav` / `mp3` |
| `cfg_scale` | 否 | 引导强度，1–4；`> 1` 会占 2 个并发槽 |
| `seed` | 否 | 随机种子 |

示例：

```powershell
curl.exe -s -X POST http://127.0.0.1:8099/api/speech `
  -H "Content-Type: application/json" `
  -d "{\"input\":\"你好\",\"instructions\":\"温柔的女声\",\"response_format\":\"wav\",\"cfg_scale\":2.0,\"seed\":42}" `
  -o out.wav
```

状态码：

- `200` 成功
- `409` 并发槽位被占满（等 1–2 秒重试）
- `503` 上游还没起来

---

## 角色

### `GET /api/voices`

转发 `GET /v1/voices`，返回数组：

```json
[
  {
    "id": "linna",
    "frames": 129,
    "seconds": 10.32,
    "saved": true,
    "ref_text": "参考音频里说的那句话",
    "description": "年轻女声",
    "metadata": {}
  }
]
```

上游未就绪时返回 `503`，同时触发后台启动。

### `POST /api/voices`

`multipart/form-data`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ref_audio` | 是 | 参考音频文件（wav / mp3 / m4a…） |
| `ref_text` | 是 | 音频的逐字文本，必须一字不差 |
| `name` | 是 | 角色 id，`[A-Za-z0-9_-]{1,64}`，同时是文件名 |
| `description` | 否 | 显示用描述 |

```powershell
curl.exe -X POST http://127.0.0.1:8099/api/voices `
  -F "ref_audio=@ref.wav" -F "ref_text=参考文本" -F "name=linna" -F "description=年轻女声"
```

同名会覆盖。

### `PATCH /api/voices/{id}`

```json
{ "description": "新的描述" }
```

### `DELETE /api/voices/{id}`

删除音色：先让上游删，再在 `app\voices` 和 `..\voices` 两个目录里找同名 `.breeze` 删掉。

```json
{ "deleted": "linna", "file_removed": true, "upstream": {} }
```

---

## 提示词方案

### `GET /api/presets` → 数组

```json
[
  {
    "id": "seed-1",
    "title": "旁白 · 温柔",
    "voice_id": "",
    "instruction": "一位温柔的年轻女性……",
    "cfg": 1.5,
    "seed": 42,
    "shared": true,
    "updated": "2026-11-10 23:05"
  }
]
```

### `POST /api/presets`

```json
{
  "title": "旁白 · 温柔",
  "instruction": "一位温柔的年轻女性……",
  "cfg": 1.5,
  "seed": 42,
  "shared": true,
  "voice_id": ""
}
```

- `id` 可省略，服务端生成；
- 带 `id` 时是**覆盖**同 id 的记录；
- 会自动补 `updated`。

### `PATCH /api/presets/{id}`

允许的字段：`title`、`instruction`、`cfg`、`seed`、`shared`、`voice_id`。

### `DELETE /api/presets/{id}`

返回 `{"deleted": "<id>"}`；不存在返回 404。

---

## 预设文本

结构与方案类似。

### `GET /api/texts`

```json
[ { "id": "text-1", "title": "日常问候", "content": "回来啦？" } ]
```

### `POST /api/texts`

```json
{ "title": "日常问候", "content": "回来啦？饭在锅里温着呢。" }
```

### `PATCH /api/texts/{id}` / `DELETE /api/texts/{id}`

---

## 气泡

### `GET /api/chips`

```json
{
  "version": 1,
  "groups": [
    {
      "name": "状态",
      "exclusive": false,
      "items": [
        { "label": "正在哭泣", "text": "声音带着明显的哭腔……" }
      ]
    }
  ]
}
```

### `PUT /api/chips`

整份覆盖，body 必须有 `groups` 数组，缺 `version` 时补 1。

---

## 虚拟声卡（可选）

需要 `app\bin\VirtualMicPlayer.exe`，并且系统里装了 VB-CABLE 之类的虚拟声卡。
仓库自带的界面没有暴露这几个入口，但接口可用。

### `POST /api/mic/play`

`Content-Type: application/octet-stream`，body 是 WAV 字节。

| 请求头 | 说明 |
| --- | --- |
| `X-Mic-Volume` | 0–100，默认 100 |
| `X-Mic-Loop` | `1` / `0`，默认 0 |
| `X-Mic-Device` | 指定设备名，默认自动挑 CABLE |

返回 `{"ok": true, "bytes": 12345}`。

### `POST /api/mic/stop`

停掉当前播放：`{"ok": true}`。

### `GET /api/mic/status`

```json
{ "running": true }
```

### `GET /api/mic/info`

```json
{ "exeFound": true, "auto": "CABLE Input (VB-Audio Virtual Cable)" }
```

---

## 错误码

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求体不是合法 JSON / 缺字段 |
| 404 | 资源不存在，或未知 `/api/*` |
| 405 | 方法不允许 |
| 409 | 上游并发槽位满（`cfg_scale > 1` 一次占 2 个） |
| 500 | 服务端错误（文件删除失败等） |
| 502 | 上游返错 |
| 503 | 上游没起来（本服务会顺手拉起，稍后重试） |
