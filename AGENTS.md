# AGENTS.md — VoiceMate 部署与改动契约（给 AI 助手）

> 这份文件是给自动化代理 / AI 编码助手读的。目标：**不需要人类再解释，就能把项目跑起来、改对、验证通过。**
> 人看的使用说明在 [`README.md`](README.md) 和 `app/使用说明.md`；接口细节在 [`docs/API.md`](docs/API.md)。

---

## 1. 一句话

Windows 本机的中文 TTS 工作台：`app\server.py`（Python 标准库）在 `127.0.0.1:8099` 提供页面和 `/api/*`，
并按需拉起 `app\bin\breeze-server.exe`（`127.0.0.1:8080`）做推理；数据在 `app\data/*.json` 和 `app\voices/*.breeze`。

**仓库里没有模型和二进制**（太大）。部署 = 放好 `app\models\breeze-tts-2-q8_0.gguf` + `app\bin\breeze-server.exe` 等。

---

## 2. 环境事实（不要凭猜测改）

| 事实 | 值 |
| --- | --- |
| 目标系统 | Windows 10 / 11 x64 |
| Python | 3.9+，**只用标准库**（`http.server`、`urllib`、`subprocess`…），无 requirements.txt |
| 前端 | 原生 HTML/CSS/JS，无构建步骤，无框架 |
| 端口 | UI `8099`，上游语音服务 `8080`（都只绑 `127.0.0.1`） |
| 模型路径 | `app\models\breeze-tts-2-q8_0.gguf`（`server.py` 里写死；换模型要改 `MODEL`） |
| 上游启动参数 | `breeze-server.exe <MODEL> --host 127.0.0.1 --port 8080 --parallel 4 --voices-dir <app>\voices` |
| 音频格式 | 24 kHz、单声道、16-bit PCM；界面最终存 WAV |
| 数据编码 | UTF-8 JSON；`.bat` 必须 CRLF |

---

## 3. 部署（确定性步骤）

```powershell
git clone https://github.com/LQSY-H/VoiceMate.git
cd VoiceMate

# 一键（下载二进制 + 模型）
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1

# 只检查不下载
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Check
```

等价的手动步骤：

```powershell
# 1) 二进制：从上游 releases 取 windows-x64-vulkan.zip，解压后把 exe/dll 放进 app\bin
#    https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases
# 2) 模型（3.32 GB）
curl.exe -L -C - -o app\models\breeze-tts-2-q8_0.gguf `
  https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf
# 3) 启动
.\启动.bat
```

---

## 4. 运行与验证（照抄即可）

```powershell
# 语法
python -m py_compile app\server.py
node --check app\web\app.js   # 可选

# 启动（前台，另开一个终端验证）
python app\server.py

# 健康检查（就绪前 starting=true）
curl.exe -s http://127.0.0.1:8099/api/health
curl.exe -s http://127.0.0.1:8099/api/state

# 合成 1 秒测试音频，应得到一个 > 10 KB 的 wav
curl.exe -s -X POST http://127.0.0.1:8099/api/speech `
  -H "Content-Type: application/json" `
  -d "{\"input\":\"你好\",\"instructions\":\"温柔的女声\",\"response_format\":\"wav\",\"cfg_scale\":2.0,\"seed\":42}" `
  -o test.wav
```

判定标准：

- `/api/state` 返回 `"ready": true`；
- `test.wav` 大小随文本长度变化，能正常播放；
- 页面 `http://127.0.0.1:8099/` 的 `<title>` 是 `VoiceMate`，控制台无报错。

---

## 5. 文件职责（写操作前先确认改哪一层）

| 路径 | 职责 | 改动注意 |
| --- | --- | --- |
| `app/server.py` | 启动/守护上游、反向代理、静态托管、`/api/*` 增删改查 | 只用标准库；`_api()` 里按 path 分发；改完必须重启 |
| `app/web/index.html` | 单页结构：5 个 tab | 新控件要同时在 `app.js` 绑定 |
| `app/web/app.js` | 全部前端逻辑（IIFE，`S` 是状态） | 无模块系统；改完刷新即可 |
| `app/web/style.css` | 浅色主题、CSS 变量 `--blue/--teal/...` | 图标是内联 SVG |
| `app/data/chips.json` | 气泡配置（组 + 项） | `exclusive` 控制互斥 |
| `app/data/presets.json` | 方案（不含正文） | 数组为空也要保留文件 |
| `app/data/texts.json` | 预设文本 | 同上 |
| `app/voices/*.breeze` | 上游二进制音色 | **不要**手改/生成 |
| `app/models/` | 模型 | 不进 git |
| `app/bin/` | 上游可执行文件 | 不进 git |
| `启动.bat` / `app/启动.bat` | 启动器 | **必须 CRLF**；`.gitattributes` 把它们标成 `-text` |

---

## 6. 不变量（破坏任何一条都会出问题）

1. **`.bat` 必须 CRLF。** cmd 对 LF 的解析会错位（曾出现 `'er.exe' is not recognized`）。
   `.gitattributes` 用 `*.bat -text` 把文件原样存 CRLF，别改成 `text eol=crlf`。
2. **`server.py` 不许引入第三方依赖。** 部署目标是「装个 Python 就能跑」。
3. **不要抢跑第二个上游。** 8080 已有服务就复用（可能是用户自己的），`ensure_upstream()` 已处理，别绕过。
4. **改模型文件名要同步改 `MODEL` 常量**，否则启动即失败（报「找不到 bin\breeze-server.exe」类似错误其实可能是模型路径问题）。
5. **`/api/speech` 必须流式转发**（`stream=True`），前端靠 chunk 边播边攒；不要改成先读完整 body。
6. **数据文件缺失时不要静默重建用户内容。** `load_presets/load_texts/load_chips` 有默认值，但分享版默认全空。
7. **别把 `127.0.0.1` 改成 `0.0.0.0`** 发到公网——没有鉴权。

---

## 7. 数据 schema

### chips.json
```json
{"version":1,"groups":[{"name":"语速","exclusive":true,
  "items":[{"label":"偏快","text":"语速偏快……"}]}]}
```

### presets.json
```json
{"version":1,"presets":[{"id":"seed-1","title":"…","voice_id":"","instruction":"…",
  "cfg":1.5,"seed":42,"shared":true,"updated":"2026-11-10 23:05"}]}
```

### texts.json
```json
{"version":1,"texts":[{"id":"text-1","title":"…","content":"…"}]}
```

`voice_id` 为空 = 所有角色；非空 = 仅该角色。

---

## 8. 接口一览（详见 docs/API.md）

```
GET    /api/state            {ready, starting, error, uiPort, apiPort, presets[], texts[], chips{}, mic{}}
GET    /api/health           {ready}
GET    /api/voices           -> 转发 GET /v1/voices
POST   /api/voices           multipart: ref_audio, ref_text, name, description
PATCH  /api/voices/{id}      {description}
DELETE /api/voices/{id}      删记录 + 删 .breeze
POST   /api/speech           {input, instructions, voice?, response_format, cfg_scale, seed}
GET    /api/presets          -> 数组
POST   /api/presets          {id?, title, instruction, cfg, seed, shared?, voice_id?}
PATCH  /api/presets/{id}     {title?, instruction?, cfg?, seed?, shared?}
DELETE /api/presets/{id}
GET    /api/texts            -> 数组
POST   /api/texts            {title, content, id?}
PATCH  /api/texts/{id}       {title?, content?}
DELETE /api/texts/{id}
GET    /api/chips            -> {version, groups[]}
PUT    /api/chips            {groups:[...]}
POST   /api/mic/play         body=wav bytes，头 X-Mic-Volume / X-Mic-Loop
POST   /api/mic/stop
GET    /api/mic/status       {running}
```

错误约定：`{"error": "中文说明"}` + 4xx/5xx；409 = 并发槽位满；503 = 上游没起来。

---

## 9. 故障判定树

| 现象 | 先查 | 结论/动作 |
| --- | --- | --- |
| 8099 连不上 | `netstat -ano \| findstr 8099`；黑窗口是否退出 | 端口被占 / Python 启动失败 |
| `/api/state` ready=false 很久 | `app\breeze-server.log` | 显存不足 / 模型路径错 / 驱动不支持 Vulkan |
| 启动即退，日志里 `unknown voice` | `app\voices` 与上游 `--voices-dir` 是否一致 | 8080 被别的实例占用时目录不同 |
| 409 | 生成请求频率 | `--parallel` 调大，或等 1–2 秒 |
| 页面空白 | 用 8099 而非 8080；Ctrl+F5 | 静态缓存 |
| 音频没声音但保存有文件 | 浏览器自动播放策略 | 用户点过「生成」即可解锁 |

---

## 10. 改动后必须跑的检查

1. `python -m py_compile app\server.py`
2. 启动 → `/api/state` `ready=true`
3. `/api/speech` 生成一段，能存 wav
4. 前端 `<title>` 与顶部标题是 `VoiceMate`，控制台无 error
5. 若改了 `.bat`：确认文件仍是 CRLF（`git ls-files --eol | findstr bat` 应显示 `i/crlf`）

---

## 11. 扩展点

- **换模型**：`MODEL` 常量 + 文件；显存小用 `q4_k`（2.36 GB）。
- **加气泡组**：改 `data/chips.json` 的 `groups`，前端自动渲染；互斥组用 `exclusive: true`。
- **加接口**：在 `_api()` 里加分支，前端用 `api("/api/xxx")`。
- **换端口**：`UI_PORT` / `API_PORT`，注意两者不同且未被占用。
- **Windows 之外**：`启动.bat` 与 `os.startfile`/路径需替换；`server.py` 本身是跨平台的。
