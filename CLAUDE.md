# CLAUDE.md

本仓库的 AI 部署/改动说明统一维护在 [`AGENTS.md`](AGENTS.md)，请先读它，再用 [`docs/API.md`](docs/API.md) 查接口。

要点：

- 仅 Windows；后端 `app/server.py` 只允许 Python 标准库；前端 `app/web/` 无构建步骤
- 端口：界面 8099，上游语音服务 8080（8080 活着就复用，不要重复起）
- 模型与上游二进制不在仓库里：用 `scripts/setup.ps1`，或手动放
  `app/models/breeze-tts-2-q8_0.gguf`、`app/bin/breeze-server.exe`
- `.bat` 必须保持 CRLF（`.gitattributes` 已标成 `-text`）
- 改完跑：`python -m py_compile app/server.py` → 启动 → `/api/state` 的 `ready` 为 true →
  `POST /api/speech` 能生成一段 wav
