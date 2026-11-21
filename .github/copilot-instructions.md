# Copilot instructions for VoiceMate

Read `AGENTS.md` at the repo root first — it is the authoritative deployment/contribution contract.
Short version:

- Windows-only project. Backend is `app/server.py` (Python 3.9+, **standard library only**, no pip).
- Frontend is `app/web/` (vanilla HTML/CSS/JS, no build step).
- Two ports: UI `127.0.0.1:8099`, upstream TTS `127.0.0.1:8080`. Never start a second upstream if 8080 is alive.
- Model and upstream binaries are NOT in the repo. Deploy with `scripts/setup.ps1`, or place
  `app/models/breeze-tts-2-q8_0.gguf` and `app/bin/breeze-server.exe` manually.
- `.bat` files must stay CRLF (`.gitattributes` marks them `-text`). Do not "normalize" them.
- Do not add third-party Python dependencies; the project must run with a bare Python install.
- Data lives in `app/data/*.json` and `app/voices/*.breeze`; schemas are in `AGENTS.md` and `docs/API.md`.
- After changes: `python -m py_compile app/server.py`, start it, check `/api/state` → `ready: true`,
  and generate a short clip through `POST /api/speech`.
