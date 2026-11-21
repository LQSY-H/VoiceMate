"""VoiceMate —— 一站式本地服务。

一个进程负责：
  1. 需要时拉起 breeze-server.exe（8080），就绪后对外服务
  2. 在 8099 提供中文界面（web/）
  3. 把 /v1/* 转发给 breeze-server
  4. 提示词方案（data/presets.json）的增删改查
  5. 音色库的编辑 / 删除
  6. 虚拟麦克风播放（bin/VirtualMicPlayer.exe）

只用标准库，不需要 pip。
"""
import atexit
import http.server
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
BIN = os.path.join(ROOT, "bin")
MODEL = os.path.join(ROOT, "models", "breeze-tts-2-q8_0.gguf")
VOICES = os.path.join(ROOT, "voices")
DATA = os.path.join(ROOT, "data")
PRESETS = os.path.join(DATA, "presets.json")
TEXTS = os.path.join(DATA, "texts.json")
CHIPS = os.path.join(DATA, "chips.json")
MIC_EXE = os.path.join(BIN, "VirtualMicPlayer.exe")
MIC_TMP = os.path.join(tempfile.gettempdir(), "breeze_mic_input.wav")
PID_FILE = os.path.join(tempfile.gettempdir(), "breeze_app_child.pid")

UPSTREAM = "http://127.0.0.1:8080"
API_PORT = 8080
UI_PORT = 8099

HOP = {"host", "connection", "content-length", "transfer-encoding",
       "accept-encoding", "keep-alive"}

LOCK = threading.Lock()
PRESET_LOCK = threading.Lock()
MIC = {"proc": None, "lock": threading.Lock()}
CHILD = {"proc": None}
DEVICE_CACHE = {"at": 0.0, "devices": [], "auto": ""}


# ----------------------------------------------------------------- 工具

def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def port_open(port, host="127.0.0.1", timeout=0.6):
    import socket
    try:
        sock = socket.create_connection((host, port), timeout)
        sock.close()
        return True
    except OSError:
        return False


def upstream_health(timeout=3):
    try:
        with urllib.request.urlopen(UPSTREAM + "/health", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def upstream_json(path, method="GET", body=None, ctype="application/json", timeout=60):
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(UPSTREAM + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", ctype)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


# ------------------------------------------------------------ 上游进程

def ensure_upstream():
    """8080 没服务就自己拉一个；已经有（可能是别人的）就直接用。"""
    if upstream_health(1.0):
        log("发现 127.0.0.1:8080 已有服务在跑，直接复用，不重启它")
        return "reused"

    exe = os.path.join(BIN, "breeze-server.exe")
    if not os.path.isfile(exe):
        raise RuntimeError("找不到 bin\\breeze-server.exe")
    if not os.path.isfile(MODEL):
        raise RuntimeError("找不到模型：%s" % MODEL)

    os.makedirs(VOICES, exist_ok=True)
    cmd = [exe, MODEL, "--host", "127.0.0.1", "--port", str(API_PORT),
           "--parallel", "4", "--voices-dir", VOICES]
    log("启动语音服务：%s" % os.path.basename(exe))
    proc = subprocess.Popen(
        cmd, cwd=ROOT,
        stdout=open(os.path.join(ROOT, "breeze-server.log"), "ab"),
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    CHILD["proc"] = proc
    try:
        with open(PID_FILE, "w", encoding="utf-8") as handle:
            handle.write(str(proc.pid))
    except Exception:
        pass

    log("等待模型加载与预热（通常 30~90 秒）…")
    started = time.time()
    while time.time() - started < 420:
        if upstream_health(timeout=2):
            log("语音服务就绪，用时 %.0f 秒" % (time.time() - started))
            return "started"
        if proc.poll() is not None:
            raise RuntimeError("语音服务启动后立刻退出，看 breeze-server.log")
        time.sleep(1.0)
    raise RuntimeError("等待语音服务超时")


START_LOCK = threading.Lock()
START_STATE = {"busy": False, "error": ""}


def ensure_upstream_async():
    """上游没了就在后台重新拉一个，避免界面一直空着。"""
    with START_LOCK:
        if START_STATE["busy"]:
            return False
        proc = CHILD.get("proc")
        if proc is not None and proc.poll() is None:
            return False
        START_STATE["busy"] = True
        START_STATE["error"] = ""

    def run():
        try:
            ensure_upstream()
        except Exception as exc:
            START_STATE["error"] = str(exc)
            log("自动拉起语音服务失败：%s" % exc)
        finally:
            with START_LOCK:
                START_STATE["busy"] = False

    threading.Thread(target=run, daemon=True).start()
    return True


def stop_upstream():
    proc = CHILD.get("proc")
    if proc is not None and proc.poll() is None:
        log("关闭语音服务 …")
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    CHILD["proc"] = None
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except Exception:
        pass


atexit.register(stop_upstream)


# ------------------------------------------------------------ 提示词方案

# 分享版：不内置任何个人预设，首次启动就是空的
DEFAULT_PRESETS = []

DEFAULT_TEXTS = []


DEFAULT_CHIPS = {   'version': 1,
    'groups': [   {   'name': '语速',
                      'exclusive': True,
                      'items': [   {'label': '很慢', 'text': '语速放得很慢，几乎一字一顿，字与字、句与句之间都留出明显的空白，像在斟酌每一个字。'},
                                   {'label': '偏慢', 'text': '语速比平常慢一些，节奏从容舒展，句尾略微拖长，整体给人一种沉稳、不着急的感觉。'},
                                   {'label': '偏快', 'text': '语速偏快，句子衔接紧凑，只在关键处稍作停顿，听起来干脆利落、思路很快。'},
                                   {'label': '很快', 'text': '语速很快，几乎不换气，句子连成一片往前赶，带着急切或亢奋的冲劲。'}]},
                  {   'name': '语气',
                      'exclusive': False,
                      'items': [   {'label': '温柔', 'text': '声音放软放轻，语速平缓，尾音自然下沉，像在照顾对方的情绪，带着耐心和体谅。'},
                                   {'label': '认真', 'text': '咬字清晰有力，语速均匀，句尾收得干净，不带多余起伏，显得郑重而可靠。'},
                                   {'label': '耳语', 'text': '几乎是气声，音量压到最低，像贴在耳边说话，字尾带着气息散开，营造私密感。'},
                                   {'label': '撒娇', 'text': '音调偏高，尾音上扬并拖长，句子中间带一点黏糊的鼻音，像在跟人讨要什么。'},
                                   {'label': '冷淡', 'text': '语调平直，几乎没有起伏，音量偏小，句与句之间停顿生硬，透着疏离和不在意。'},
                                   {'label': '俏皮', 'text': '语气轻快带着笑，尾音往上挑，像在逗人玩，句子收得俏。'},
                                   {'label': '热情', 'text': '音量比平时大一些，语速偏快，情绪外放，句尾有股往前推的劲。'},
                                   {'label': '恳求', 'text': '声音发软，语速偏快，句尾带着哀求的上扬，像怕被拒绝。'}]},
                  {   'name': '情绪',
                      'exclusive': False,
                      'items': [   {'label': '开心', 'text': '声音明亮上扬，语速轻快，笑意藏在句尾，呼吸感明显，像忍不住想笑出来。'},
                                   {'label': '平静', 'text': '语调平稳，起伏很小，语速均匀，像在叙述一件已经过去很久的事。'},
                                   {'label': '得意', 'text': '尾音往上挑，带着一点炫耀和自得，语速偏慢，像在等着别人夸一句。'},
                                   {'label': '期待', 'text': '声音比平时高一点，语速略快，句尾轻轻上扬，透着急切和雀跃。'},
                                   {'label': '难过', 'text': '声音低沉发闷，语速慢，句尾往下掉，气息不稳，像在压着喉咙把话说完。'},
                                   {'label': '生气', 'text': '压低嗓音，气息变重，咬字用力，语速偏快且句子短促，像在克制着怒意。'},
                                   {'label': '厌恶', 'text': '语气发冷，带一点嫌弃的鼻音，字咬得短而利落，像不想多说一个字。'},
                                   {'label': '无奈', 'text': '带一声很轻的叹气，语气发软，语速拖沓，句尾往下塌，透着一股没办法。'},
                                   {'label': '失望', 'text': '声音先扬后塌，说到一半气就泄了，语速变慢，尾音散掉。'},
                                   {'label': '惊讶', 'text': '起句音调突然拔高，气息短促，语速先快后慢，中间带着难以置信的停顿。'},
                                   {'label': '激动', 'text': '声音拔高，语速快而冲，气息顶上来，句子几乎收不住。'},
                                   {'label': '焦虑', 'text': '语速偏快但不稳，说半句停一下又接着往下赶，气息很浅。'},
                                   {'label': '羞愧', 'text': '声音越说越小，句尾含混带过，像不好意思抬头。'},
                                   {'label': '嫉妒', 'text': '语气发紧，尾音带刺，音量压在喉咙里，像咬着牙说出来的。'},
                                   {'label': '烦躁', 'text': '语速快、句子短，尾音往下甩，透着明显的不耐烦。'}]},
                  {   'name': '状态',
                      'exclusive': False,
                      'items': [   {'label': '正在哭泣', 'text': '声音带着明显的哭腔，气息一抽一抽的，句子被抽泣打断，字尾发颤，越说越说不下去。'},
                                   {'label': '受委屈', 'text': '声音发闷发虚，带着不服气又不敢反驳的委屈，句尾往下塌，偶尔抽一下鼻子。'},
                                   {'label': '疼痛', 'text': '气息短促，声音像从牙缝里挤出来，关键处忍不住倒抽一口气，字尾发抖。'},
                                   {'label': '恐惧', 'text': '声音发抖，气息又浅又急，语速不稳，时不时停下来听周围的动静。'},
                                   {'label': '疲惫', 'text': '气息短而浅，语速拖沓，吐字有点含糊，句尾几乎没有力气抬起来。'},
                                   {'label': '强忍', 'text': '拼命压着情绪，声音绷得很紧，字咬得很死，越到后面抖得越明显。'},
                                   {'label': '醉酒', 'text': '吐字发黏，语速忽快忽慢，带着点笑，句尾拖得比平常长。'},
                                   {'label': '刚睡醒', 'text': '声音发闷，音调偏低，吐字含糊，尾音一路往下掉。'},
                                   {'label': '生病', 'text': '鼻音很重，气息弱，说话有气无力，句中偶尔吸一下鼻子。'}]}]}


def load_chips():
    os.makedirs(DATA, exist_ok=True)
    if not os.path.isfile(CHIPS):
        save_chips(DEFAULT_CHIPS)
        return json.loads(json.dumps(DEFAULT_CHIPS))
    try:
        with open(CHIPS, "r", encoding="utf-8") as handle:
            obj = json.load(handle)
        if isinstance(obj, dict) and isinstance(obj.get("groups"), list):
            return obj
    except Exception:
        pass
    return json.loads(json.dumps(DEFAULT_CHIPS))


def save_chips(obj):
    os.makedirs(DATA, exist_ok=True)
    tmp = CHIPS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, CHIPS)


def load_json_list(path, default, key):
    os.makedirs(DATA, exist_ok=True)
    if not os.path.isfile(path):
        save_json_list(path, default, key)
        return [dict(item) for item in default]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            obj = json.load(handle)
        items = obj.get(key, []) if isinstance(obj, dict) else (obj or [])
        return items or []
    except Exception:
        return []


def save_json_list(path, items, key):
    os.makedirs(DATA, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"version": 1, key: items}, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_presets():
    items = load_json_list(PRESETS, DEFAULT_PRESETS, "presets")
    # 老版本把正文也存进了方案，这里统一剔掉：正文属于「预设文本」，不属于方案
    cleaned = []
    for item in items:
        item = {k: v for k, v in item.items() if k != "text"}
        cleaned.append(item)
    return cleaned


def save_presets(items):
    save_json_list(PRESETS, items, "presets")


def load_texts():
    return load_json_list(TEXTS, DEFAULT_TEXTS, "texts")


def save_texts(items):
    save_json_list(TEXTS, items, "texts")


def voice_dirs():
    """本项目自己的 voices 目录，以及上级目录里可能存在的共享 voices。"""
    candidates = [VOICES, os.path.join(os.path.dirname(ROOT), "voices")]
    seen, out = set(), []
    for path in candidates:
        norm = os.path.normcase(os.path.abspath(path))
        if norm in seen:
            continue
        seen.add(norm)
        if os.path.isdir(path):
            out.append(path)
    return out


def new_id(prefix="p"):
    return "%s-%d-%04d" % (prefix, int(time.time() * 1000) % 100000, int(time.time() * 9999) % 10000)


# ------------------------------------------------------------ 虚拟麦克风

def mic_devices(refresh=False):
    now = time.time()
    if not refresh and DEVICE_CACHE["devices"] and now - DEVICE_CACHE["at"] < 30:
        return DEVICE_CACHE
    devices = []
    auto = ""
    if os.path.isfile(MIC_EXE):
        out = os.path.join(tempfile.gettempdir(), "breeze_mic_devices.txt")
        try:
            if os.path.exists(out):
                os.remove(out)
            subprocess.run([MIC_EXE, "--devices", out], timeout=25,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            with open(out, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line.startswith("["):
                        continue
                    mt = re.match(r"\[(\d+)\] virtual=(\w+) name=(.*)$", line)
                    if mt:
                        devices.append({"index": int(mt.group(1)),
                                        "virtual": mt.group(2) == "True",
                                        "name": mt.group(3)})
        except Exception:
            pass
    for dev in devices:
        if "cable input" in dev["name"].lower():
            auto = dev["name"]
            break
    if not auto:
        for dev in devices:
            if dev["virtual"]:
                auto = dev["name"]
                break
    DEVICE_CACHE.update({"at": now, "devices": devices, "auto": auto})
    return DEVICE_CACHE


def mic_kill():
    proc = MIC.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    MIC["proc"] = None


# ------------------------------------------------------------ HTTP 服务

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---- 响应helper ----
    def _send(self, code, body, ctype, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   "application/json; charset=utf-8")

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    # ---- 静态文件 ----
    def _static(self):
        rel = self.path.split("?")[0].lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(WEB, rel))
        if not path.startswith(WEB) or not os.path.isfile(path):
            self._send(404, "not found", "text/plain; charset=utf-8")
            return
        with open(path, "rb") as handle:
            data = handle.read()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, data, ctype)

    # ---- 转发到上游 ----
    def _proxy(self, method, stream=False, target=None):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + (target or self.path), data=body, method=method)
        for key, value in self.headers.items():
            if key.lower() not in HOP:
                req.add_header(key, value)
        try:
            up = urllib.request.urlopen(req, timeout=900)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self._send(exc.code, payload,
                       exc.headers.get("Content-Type", "application/json"))
            return
        except Exception as exc:
            ensure_upstream_async()
            self._send(503, json.dumps(
                {"error": "语音服务没在跑，正在自动启动，请稍候 (%s)" % exc},
                ensure_ascii=False), "application/json; charset=utf-8")
            return

        ctype = up.headers.get("Content-Type") or "application/octet-stream"
        if not stream:
            payload = up.read()
            up.close()
            self._send(up.status, payload, ctype)
            return

        self.send_response(up.status)
        self.send_header("Content-Type", ctype)
        for header in ("X-Sample-Rate", "X-Sample-Format"):
            if up.headers.get(header):
                self.send_header(header, up.headers.get(header))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = up.read(8192)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            up.close()

    # ---- /api ----
    def _api(self, method):
        path = self.path.split("?")[0].rstrip("/")

        if path == "/api/state":
            ready = upstream_health(2)
            if not ready:
                ensure_upstream_async()
            self._json({
                "ready": ready,
                "starting": START_STATE["busy"],
                "error": START_STATE["error"],
                "uiPort": UI_PORT,
                "apiPort": API_PORT,
                "presets": load_presets(),
                "texts": load_texts(),
                "chips": load_chips(),
                "mic": {"exeFound": os.path.isfile(MIC_EXE),
                        "auto": mic_devices()["auto"]},
            })
            return

        if path == "/api/health":
            self._json({"ready": upstream_health(2)})
            return

        # 音色库
        if path == "/api/voices":
            if method == "GET":
                if not upstream_health(2):
                    ensure_upstream_async()
                    self._json({"error": "语音服务没在跑，正在自动启动，请稍候刷新"}, 503)
                    return
                try:
                    data = upstream_json("/v1/voices", timeout=30)
                except Exception as exc:
                    self._json({"error": str(exc)}, 503)
                    return
                self._json(data or [])
                return
            if method == "POST":
                self._proxy("POST", stream=False, target="/v1/voices")
                return

        if path.startswith("/api/voices/"):
            voice_id = urllib.parse.unquote(path[len("/api/voices/"):])
            if method == "PATCH":
                body = self._body()
                try:
                    data = upstream_json("/v1/voices/" + urllib.parse.quote(voice_id),
                                         "PATCH", body,
                                         self.headers.get("Content-Type") or "application/json")
                    self._json(data or {})
                except urllib.error.HTTPError as exc:
                    self._send(exc.code, exc.read(), "application/json; charset=utf-8")
                except Exception as exc:
                    self._json({"error": str(exc)}, 502)
                return
            if method == "DELETE":
                result = {}
                try:
                    result = upstream_json("/v1/voices/" + urllib.parse.quote(voice_id),
                                           "DELETE", timeout=30) or {}
                except Exception:
                    result = {}
                removed = False
                for folder in voice_dirs():
                    target = os.path.join(folder, voice_id + ".breeze")
                    if os.path.isfile(target):
                        try:
                            os.remove(target)
                            removed = True
                        except Exception as exc:
                            self._json({"error": "文件删除失败：%s" % exc}, 500)
                            return
                self._json({"deleted": voice_id, "file_removed": removed, "upstream": result})
                return

        # 合成
        if path == "/api/speech" and method == "POST":
            self._proxy("POST", stream=True, target="/v1/audio/speech")
            return

        # 提示词方案
        if path == "/api/presets":
            with PRESET_LOCK:
                items = load_presets()
                if method == "GET":
                    self._json(items)
                    return
                if method == "POST":
                    try:
                        payload = json.loads(self._body().decode("utf-8") or "{}")
                    except Exception:
                        self._json({"error": "bad json"}, 400)
                        return
                    payload["id"] = payload.get("id") or new_id()
                    payload["updated"] = time.strftime("%Y-%m-%d %H:%M")
                    items = [p for p in items if p.get("id") != payload["id"]] + [payload]
                    save_presets(items)
                    self._json(payload)
                    return
            self._json({"error": "method not allowed"}, 405)
            return

        if path.startswith("/api/presets/"):
            preset_id = urllib.parse.unquote(path[len("/api/presets/"):])
            with PRESET_LOCK:
                items = load_presets()
                if method == "PUT":
                    try:
                        payload = json.loads(self._body().decode("utf-8") or "{}")
                    except Exception:
                        self._json({"error": "bad json"}, 400)
                        return
                    found = None
                    for idx, item in enumerate(items):
                        if item.get("id") == preset_id:
                            payload["id"] = preset_id
                            payload["updated"] = time.strftime("%Y-%m-%d %H:%M")
                            items[idx] = payload
                            found = payload
                            break
                    if found is None:
                        self._json({"error": "not found"}, 404)
                        return
                    save_presets(items)
                    self._json(found)
                    return
                if method == "DELETE":
                    items = [p for p in items if p.get("id") != preset_id]
                    save_presets(items)
                    self._json({"deleted": preset_id})
                    return
            self._json({"error": "method not allowed"}, 405)
            return

        # 预设文本（全局，所有角色共用）
        if path == "/api/texts":
            with PRESET_LOCK:
                items = load_texts()
                if method == "GET":
                    self._json(items)
                    return
                if method == "POST":
                    try:
                        payload = json.loads(self._body().decode("utf-8") or "{}")
                    except Exception:
                        self._json({"error": "bad json"}, 400)
                        return
                    payload["id"] = payload.get("id") or new_id("t")
                    payload["updated"] = time.strftime("%Y-%m-%d %H:%M")
                    items = [t for t in items if t.get("id") != payload["id"]] + [payload]
                    save_texts(items)
                    self._json(payload)
                    return
            self._json({"error": "method not allowed"}, 405)
            return

        if path.startswith("/api/texts/"):
            text_id = urllib.parse.unquote(path[len("/api/texts/"):])
            with PRESET_LOCK:
                items = load_texts()
                if method == "PUT":
                    try:
                        payload = json.loads(self._body().decode("utf-8") or "{}")
                    except Exception:
                        self._json({"error": "bad json"}, 400)
                        return
                    found = None
                    for idx, item in enumerate(items):
                        if item.get("id") == text_id:
                            payload["id"] = text_id
                            payload["updated"] = time.strftime("%Y-%m-%d %H:%M")
                            items[idx] = payload
                            found = payload
                            break
                    if found is None:
                        self._json({"error": "not found"}, 404)
                        return
                    save_texts(items)
                    self._json(found)
                    return
                if method == "DELETE":
                    save_texts([t for t in items if t.get("id") != text_id])
                    self._json({"deleted": text_id})
                    return
            self._json({"error": "method not allowed"}, 405)
            return

        # 提示词气泡（语速 / 语气 / 情绪 / 状态）
        if path == "/api/chips":
            if method == "GET":
                self._json(load_chips())
                return
            if method == "PUT":
                try:
                    payload = json.loads(self._body().decode("utf-8") or "{}")
                except Exception:
                    self._json({"error": "bad json"}, 400)
                    return
                if not isinstance(payload.get("groups"), list):
                    self._json({"error": "groups 必须是数组"}, 400)
                    return
                with PRESET_LOCK:
                    save_chips(payload)
                self._json(payload)
                return
            self._json({"error": "method not allowed"}, 405)
            return

        # 虚拟麦克风
        if path == "/api/mic/info":
            cache = mic_devices(refresh=True)
            self._json({"exeFound": os.path.isfile(MIC_EXE),
                        "auto": cache["auto"], "devices": cache["devices"]})
            return

        if path == "/api/mic/play" and method == "POST":
            data = self._body()
            if not data:
                self._json({"error": "empty body"}, 400)
                return
            if not os.path.isfile(MIC_EXE):
                self._json({"error": "找不到 bin\\VirtualMicPlayer.exe"}, 500)
                return
            args = [MIC_EXE, "--play", MIC_TMP, "--device", "auto"]
            volume = (self.headers.get("X-Mic-Volume") or "").strip()
            if volume.isdigit():
                args += ["--volume", volume]
            if (self.headers.get("X-Mic-Loop") or "") == "1":
                args += ["--loop"]
            with MIC["lock"]:
                mic_kill()
                try:
                    with open(MIC_TMP, "wb") as handle:
                        handle.write(data)
                    MIC["proc"] = subprocess.Popen(
                        args, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as exc:
                    self._json({"error": str(exc)}, 500)
                    return
            self._json({"ok": True, "bytes": len(data)})
            return

        if path == "/api/mic/stop" and method == "POST":
            with MIC["lock"]:
                mic_kill()
            self._json({"ok": True})
            return

        if path == "/api/mic/status":
            proc = MIC.get("proc")
            self._json({"running": proc is not None and proc.poll() is None})
            return

        self._json({"error": "unknown api"}, 404)

    # ---- 路由 ----
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            self._api("GET")
        elif path.startswith("/v1/") or path == "/health":
            self._proxy("GET", stream=False)
        else:
            self._static()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            self._api("POST")
        elif path.startswith("/v1/"):
            self._proxy("POST", stream=False)
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

    def do_PUT(self):
        self._api("PUT")

    def do_PATCH(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            self._api("PATCH")
        elif path.startswith("/v1/"):
            self._proxy("PATCH", stream=False)
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

    def do_DELETE(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            self._api("DELETE")
        elif path.startswith("/v1/"):
            self._proxy("DELETE", stream=False)
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 浏览器中途关连接是常态，不要在控制台刷一大段 traceback
        if isinstance(sys.exc_info()[1],
                      (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


# ------------------------------------------------------------ 入口

def serves_our_ui(timeout=2):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/" % UI_PORT, timeout=timeout) as resp:
            head = resp.read(600)
            return resp.status == 200 and "VoiceMate".encode("utf-8") in head
    except Exception:
        return False


def main():
    url = "http://127.0.0.1:%d/" % UI_PORT

    # 已经开着一个就别再来一遍（否则会白白多加载一份模型）
    if port_open(UI_PORT) and serves_our_ui():
        print("界面已经在运行：%s" % url)
        print("（不需要再启动一次，下面直接打开浏览器）", flush=True)
        webbrowser.open(url)
        time.sleep(2)
        return 0

    print("=" * 62)
    print("  VoiceMate")
    print("=" * 62, flush=True)

    try:
        ensure_upstream()
    except Exception as exc:
        print("\n[启动失败] %s" % exc, flush=True)
        print("按回车退出 …", flush=True)
        try:
            input()
        except Exception:
            pass
        return 1

    os.makedirs(VOICES, exist_ok=True)
    if not os.path.isfile(PRESETS):
        save_presets(DEFAULT_PRESETS)
    if not os.path.isfile(TEXTS):
        save_texts(DEFAULT_TEXTS)

    try:
        server = Server(("127.0.0.1", UI_PORT), Handler)
    except OSError as exc:
        print("\n[启动失败] 端口 %d 被占用：%s" % (UI_PORT, exc), flush=True)
        print("按回车退出 …", flush=True)
        try:
            input()
        except Exception:
            pass
        return 1

    print("")
    print("  界面地址：%s" % url)
    print("  关闭本窗口即停止全部服务")
    print("", flush=True)
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        mic_kill()
        stop_upstream()
    return 0


if __name__ == "__main__":
    sys.exit(main())
