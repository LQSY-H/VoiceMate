# VoiceMate

**本地中文语音合成工作台（Windows）**

给 [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 套的一层中文界面：选角色、调语气、写台词、
边生成边出声、一键存成 wav。全部在本机跑，不联网、不上传。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![Python](https://img.shields.io/badge/python-3.9%2B-3776ab)
![GPU](https://img.shields.io/badge/GPU-Vulkan-5c6bc0)

![界面截图](docs/screenshot.png)

---

## 目录

- [这是什么](#这是什么)
- [功能](#功能)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [部署](#部署)
  - [方式 A：一键脚本（推荐）](#方式-a一键脚本推荐)
  - [方式 B：手动部署](#方式-b手动部署)
  - [方式 C：用已经打包好的发布目录](#方式-c用已经打包好的发布目录)
- [第一次启动会发生什么](#第一次启动会发生什么)
- [目录结构](#目录结构)
- [配置](#配置)
- [数据格式](#数据格式)
- [HTTP 接口](#http-接口)
- [使用说明](#使用说明)
- [常见问题](#常见问题)
- [开发](#开发)
- [给 AI / 自动化工具](#给-ai--自动化工具)
- [已知限制](#已知限制)
- [许可与致谢](#许可与致谢)

---

## 这是什么

Breeze-TTS-2.cpp 是一个 C++ / GGUF 的语音合成运行时，自带的是英文命令行和一个很朴素的 WebUI。
VoiceMate 是它外面的一层「工坊」：

- 一个 `server.py`（只用 Python 标准库，没有 pip 依赖）负责拉起语音服务、转发接口、存配置、托管页面；
- 一个纯原生 JS / CSS 的中文界面，不打包、不编译，改完刷新就生效；
- 数据都是本地 JSON 和二进制文件，随便备份、随便搬。

**它不包含模型，也不包含语音服务的可执行文件**——这两样太大，请按下面的步骤自己补齐（都是公开可下载的）。

---

## 功能

### 开始配音

| 功能 | 说明 |
| --- | --- |
| 角色选择 | 克隆角色（`.breeze`）或「无角色 · 纯音色设计」 |
| 提示词方案 | 按角色保存的提示词 + 引导强度 + 种子；点一下就套用，**不存正文** |
| 长文断句 | 整段台词一行一句粘进来，勾选或按范围选中，自动拼进正文 |
| 正文 | 要念的文字；支持内联情绪标记 |
| 情绪标记 | 15 个中括号标签：`[笑]` `[大笑]` `[大哭]` `[抽泣]` `[哽咽]` `[叹气]` `[咳嗽]` `[清嗓子]` `[惊讶]` `[尖叫]` `[喘息]` `[低语]` `[停顿]` `[颤抖]` `[咬牙]`，插在光标处，只影响朗读 |
| 提示词 / 语气指令 | 自然语言描述音色与情绪，可以点气泡快速追加 |
| 提示词气泡 | 36 个，四组：语速 4、语气 8、情绪 15、状态 9；可在「预设管理」里改、加、删 |
| 引导强度 / 随机种子 | `cfg_scale` 1~4、`seed` |
| 流式播报 | 首包约 0.5 秒，边合成边播放，不用等整段跑完 |
| 停止预览 / 停止生成 | 前者只掐声音、生成继续跑完；后者直接中断 |

### 预设管理

- **提示词气泡**：分组编辑，支持「互斥」组（同组只能选一个）
- **提示词方案**：标题、提示词、cfg、seed、是否「共用」；不含正文
- **预设文本**：全局正文库，所有角色共用

### 角色

- **创建角色**：5～15 秒参考音频 + 逐字文本 + 角色名，克隆成 `.breeze`
- **随机音色**：不挂参考音频，纯提示词抽一个音色描述
- **音色库**：改描述、查看参考文本、删除（连文件一起删）

### 保存

- 生成完点 **保存语音文件**，文件名自动取 `角色名_正文前8个字.wav`
- 音频统一是 24 kHz 单声道 16-bit WAV

---

## 工作原理

```
┌─────────────────────────────┐
│ 浏览器  http://127.0.0.1:8099│
│  index.html / app.js / css   │
└──────────────┬──────────────┘
               │  fetch /api/*
┌──────────────▼──────────────┐        ┌──────────────────────────┐
│  server.py   :8099          │  HTTP  │  breeze-server.exe :8080 │
│  · 静态页面                  │───────▶│  · GGUF 模型推理          │
│  · /api/* 增删改查           │◀───────│  · /v1/audio/speech      │
│  · /api/speech 流式转发      │  PCM   │  · /v1/voices            │
│  · 拉起 / 守护上面的进程      │        └──────────────────────────┘
└──────────────┬──────────────┘
               │ 读写
      ┌────────▼─────────┐
      │ data/*.json      │  气泡 / 方案 / 预设文本
      │ voices/*.breeze  │  角色
      │ models/*.gguf    │  模型（自己放）
      │ bin/*.exe        │  程序（自己放）
      └──────────────────┘
```

要点：

- `server.py` 启动时先看 `8080` 有没有服务：**有就直接复用，没有才拉起** `bin/breeze-server.exe`；
- 语音合成以 `response_format: pcm` 流式返回，前端按块塞进 Web Audio 播放队列；
- 所有用户数据都在 `app/data` 和 `app/voices`，删掉即恢复出厂；
- 页面和接口都只监听 `127.0.0.1`，不对外网开放。

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 x64 |
| 显卡 | 支持 Vulkan（NVIDIA / AMD / Intel 核显都可），显存建议 **6 GB+** |
| Python | **3.9 及以上**（只用标准库，不需要 pip install） |
| 磁盘 | 约 4 GB（模型 3.3 GB + 程序 0.1 GB + 余量） |
| 端口 | `8099`（界面）、`8080`（语音服务） |

> 模型是 Q8_0 量化，约 3.32 GB；第一次加载会编译 Vulkan 着色器，慢的话 1～2 分钟，之后几秒。

---

## 部署

先拿到仓库：

```powershell
git clone https://github.com/LQSY-H/VoiceMate.git
cd VoiceMate
```

下面三种方式选一种。**方式 A 最省事。**

### 方式 A：一键脚本（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

脚本会：

1. 检查 Python 和目录；
2. 从 [上游 releases](https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases) 下载 Windows x64 Vulkan 压缩包，解压后把 `breeze-server.exe`、`libbreeze.dll` 等放进 `app\bin\`；
3. 从 Hugging Face 下载 `breeze-tts-2-q8_0.gguf`（约 3.3 GB）到 `app\models\`；
4. 打印还差什么。

常用参数：

```powershell
# 只检查，不下载
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Check

# 国内网络用镜像下模型
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Mirror

# 已经有模型/程序，只补其中一边
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipModel
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -SkipBin
```

### 方式 B：手动部署

**1. 装 Python**

```powershell
winget install Python.Python.3.12
# 或者去 https://www.python.org/downloads/windows/ 装 3.9+
```

确认：`python --version`

**2. 放程序**

去 <https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases> 下载最新的
`breeze-tts-2-vX.Y.Z-windows-x64-vulkan.zip`，解压，把里面的东西放进 `app\bin\`。
官方包里有：

```
breeze-server.exe
libbreeze.dll
breeze-cli.exe / breeze-convert.exe / breeze-quantize.exe   （可选，用不到可以删）
```

> 早期版本里还有一个 `VirtualMicPlayer.exe`（第三方/自编译的虚拟声卡播放器），官方 release 里没有。
> 本仓库的界面没有用到它；只有后端 `/api/mic/*` 需要。

**3. 放模型**

从 Hugging Face 下载（二选一）：

```
https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf
https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf   ← 国内
```

放到 `app\models\breeze-tts-2-q8_0.gguf`（**文件名别改**，`server.py` 里写死了这个路径）。

用 `curl` 断点续传更稳：

```powershell
curl.exe -L -C - -o app\models\breeze-tts-2-q8_0.gguf `
  https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf
```

**4. 启动**

```powershell
.\启动.bat
```

等黑窗口打印「界面地址：http://127.0.0.1:8099/」，浏览器会自动打开。

### 方式 C：用已经打包好的发布目录

如果你拿到的是别人打包好的 `VoiceMate\` 目录（里面已经有 `runtime\`、`bin\`、`models\`），
直接双击根目录的 `启动.bat` 就行，不需要装 Python。

---

## 第一次启动会发生什么

1. `启动.bat` 找 Python（优先 `runtime\python.exe`，其次系统 `python`，最后 `D:\Python\python.exe`）；
2. `server.py` 检查 8080：
   - 有服务 → 打印「发现 127.0.0.1:8080 已有服务在跑，直接复用」；
   - 没有 → 拉起 `bin\breeze-server.exe`，日志写到 `app\breeze-server.log`；
3. 轮询 `/health` 直到就绪（30～90 秒，首次更久）；
4. 在 8099 起界面，并自动打开浏览器；
5. 关掉黑窗口 = 停掉全部（会顺手杀掉子进程）。

---

## 目录结构

```
VoiceMate/
├─ 启动.bat                  根启动器：调 app\启动.bat
├─ README.md
├─ AGENTS.md                 给 AI 助手的部署/改动契约（机器可读）
├─ LICENSE                   MIT
├─ scripts/
│  └─ setup.ps1              一键下载程序 + 模型
├─ docs/
│  ├─ screenshot.png
│  └─ API.md                 接口明细
└─ app/
   ├─ 启动.bat               真正干活：找 Python、启动 server.py、退出清理
   ├─ server.py              后端（stdlib only，约 900 行）
   ├─ 使用说明.md             面向使用者的中文手册
   ├─ data/
   │  ├─ chips.json          提示词气泡
   │  ├─ presets.json        提示词方案（默认空）
   │  └─ texts.json          预设文本（默认空）
   ├─ voices/                角色（*.breeze）
   ├─ web/
   │  ├─ index.html          单页界面，5 个 tab
   │  ├─ style.css
   │  ├─ app.js              全部前端逻辑
   │  └─ favicon.*           图标
   ├─ bin/                   ← 自己放，不在仓库里
   └─ models/                ← 自己放，不在仓库里
```

---

## 配置

`app/server.py` 顶部：

```python
UPSTREAM = "http://127.0.0.1:8080"
API_PORT = 8080          # 语音服务端口
UI_PORT  = 8099          # 界面端口
```

改端口就改这两个常量（还要顺手改 `启动.bat` 里没有写死端口的逻辑——它不写死，放心）。

启动语音服务时带的参数：

```
breeze-server.exe models\breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8080 --parallel 4 --voices-dir <app>\voices
```

- `--parallel 4`：并发槽位。`cfg_scale > 1` 会一次吃 2 个槽，所以开 4 才能保证连续生成不撞 409。
- 想换更小的模型（如 `q4_k`），改 `MODEL` 常量，或重新签个软链/改名。显存不够时 `q4_k`（2.36 GB）很实用。

---

## 数据格式

所有文件都是 UTF-8 JSON，输出用两空格缩进。

### `data/chips.json`

```json
{
  "version": 1,
  "groups": [
    {
      "name": "语速",
      "exclusive": true,
      "items": [
        { "label": "偏快", "text": "语速偏快，句子衔接紧凑……" }
      ]
    }
  ]
}
```

- `exclusive: true` 表示同组互斥（点一个新的会顶掉旧的）；
- `label` 是气泡上的字，`text` 是点一下追加到提示词框里的整句；
- 组名、数量都可以随便加，界面按顺序渲染。

### `data/presets.json`

```json
{
  "version": 1,
  "presets": [
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
}
```

`voice_id` 为空表示所有角色可见；非空时只在该角色下显示。

### `data/texts.json`

```json
{
  "version": 1,
  "texts": [
    { "id": "text-1", "title": "日常问候", "content": "回来啦？饭在锅里温着呢。" }
  ]
}
```

### `voices/*.breeze`

上游的二进制音色文件，约 800 字节/秒参考音频，**不要手改**。

---

## HTTP 接口

界面用的就是这些接口，脚本化调用很方便。完整字段见 [docs/API.md](docs/API.md)。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/state` | 就绪状态 + 方案 + 文本 + 气泡 + 麦克风信息 |
| GET | `/api/health` | `{"ready": true}` |
| GET | `/api/voices` | 角色列表（转发 `/v1/voices`） |
| POST | `/api/voices` | 新建角色（multipart：`ref_audio`、`ref_text`、`name`、`description`） |
| PATCH | `/api/voices/{id}` | 改描述 |
| DELETE | `/api/voices/{id}` | 删角色（同时删 `.breeze`） |
| POST | `/api/speech` | 合成，默认流式 PCM |
| GET/POST | `/api/presets` | 方案列表 / 新建或覆盖 |
| PATCH/DELETE | `/api/presets/{id}` | 改 / 删 |
| GET/POST | `/api/texts` | 预设文本 |
| PATCH/DELETE | `/api/texts/{id}` | 改 / 删 |
| GET/PUT | `/api/chips` | 气泡配置 |
| POST | `/api/mic/play` | 把 WAV 送到虚拟声卡（需要 `VirtualMicPlayer.exe`） |
| POST | `/api/mic/stop` | 停 |
| GET | `/api/mic/status` | 是否在播 |

合成示例：

```powershell
curl.exe -X POST http://127.0.0.1:8099/api/speech `
  -H "Content-Type: application/json" `
  -d "{\"input\":\"你好，测试一下。\",\"instructions\":\"温柔的年轻女性\",\"response_format\":\"wav\",\"cfg_scale\":2.0,\"seed\":42}" `
  -o out.wav
```

---

## 使用说明

更细的中文手册在 [`app/使用说明.md`](app/使用说明.md)。一句话流程：

1. 左边选角色（或不用角色）→ 右边写正文、加情绪标记；
2. 下面写提示词，或点气泡；
3. 点 **生成语音**，听到第一句就开始出声；
4. 生成完点 **保存语音文件**。

---

## 常见问题

<details>
<summary>双击 <code>启动.bat</code> 闪一下就没了</summary>

看黑窗口里的报错。最常见的是没装 Python（方式 B），或者 `runtime\python.exe` 被杀毒软件删了（方式 C）。
</details>

<details>
<summary>一直停在「等待模型加载」</summary>

看 `app\breeze-server.log`。多半是显存不够，或者显卡驱动太旧不支持 Vulkan。
换成 `q4_k` 模型、关掉别的占显存的程序、更新显卡驱动。
</details>

<details>
<summary>页面打开是空白</summary>

地址要用 `8099`，不是 `8080`（8080 是纯接口，没有页面）。另外 Ctrl+F5 强刷一次。
</details>

<details>
<summary>生成报 409 / 「上一个还在收尾」</summary>

`--parallel` 不够。`cfg_scale > 1` 一次占两个槽，默认 4 个槽能扛住连续点击；频繁点就等一两秒。
</details>

<details>
<summary>生成报 404 unknown voice</summary>

角色的 `.breeze` 不在当前语音服务的 `voices` 目录里。注意：如果 8080 上是**别的程序**起的服务，
它读的是它自己的目录，本程序删除角色时会两个目录都找一遍。
</details>

<details>
<summary>要发到微信/QQ 语音</summary>

仓库里的界面是「生成 → 保存 wav」的版本。上游服务本身支持虚拟声卡（`VirtualMicPlayer.exe` + VB-CABLE），
`server.py` 保留了 `/api/mic/*` 接口，可以自己接；完整带虚拟麦克风的界面不在这个仓库里。
</details>

<details>
<summary>能改端口吗</summary>

能，改 `server.py` 顶部的 `UI_PORT` / `API_PORT`。注意两者不能相同，也别和别的程序撞。
</details>

---

## 开发

```powershell
# 语法检查
python -m py_compile app\server.py
node --check app\web\app.js

# 启动
python app\server.py
```

- 前端是纯静态文件，改完 **Ctrl+F5** 就生效，不用重启服务；
- 后端改了要重启黑窗口；
- `server.py` 只用标准库，**请不要引入第三方依赖**（这是能一键部署的前提）；
- 日志：界面进程的打印在黑窗口，语音服务的在 `app\breeze-server.log`。

---

## 给 AI / 自动化工具

仓库根目录的 [`AGENTS.md`](AGENTS.md) 是给 AI 助手（以及任何自动化脚本）看的：

- 环境事实、端口约定、目录职责；
- 确定性的安装/校验命令；
- 数据文件 schema；
- 「不要破坏」的约束（比如 `.bat` 必须是 CRLF、`server.py` 不能引入依赖、不要重复起 8080）；
- 验证清单和常见故障的判定方法。

如果你的 AI 工具支持 `AGENTS.md`（Codex、Cursor、Claude Code 等），它会自动读到。
另外还放了两份摘要入口，方便只认特定文件名的工具：

- [`CLAUDE.md`](CLAUDE.md) —— Claude Code
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md) —— GitHub Copilot

接口细节在 [`docs/API.md`](docs/API.md)。

---

## 已知限制

- 只支持 Windows（`启动.bat` 和路径处理都是 Windows 的）；
- 没有鉴权：只监听 `127.0.0.1`，不要把它开到公网；
- 一次只能跑一个实例：两个实例抢 8099/8080；
- 模型和二进制不进仓库，第一次部署要自己下 3.4 GB；
- 生成历史不落盘，刷新就没。

---

## 许可与致谢

- 本仓库的界面外壳（`server.py`、`web/`、`data/` 默认内容、脚本、文档）以 **MIT** 许可发布，见 [LICENSE](LICENSE)。
- 语音合成运行时 [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 与模型权重由上游发布，
  各自遵循其仓库 / 模型页面的许可（仓库为 LGPL 2.0，权重另见模型卡）。本项目**不分发**这些二进制与权重。
- 感谢 Breeze TTS 2 团队与 HoppouAI 的开源工作。
