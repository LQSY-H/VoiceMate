/* VoiceMate —— 前端逻辑（原生 JS，无依赖） */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SAMPLE_RATE = 24000;

  const S = {
    voices: [],
    presets: [],
    texts: [],
    voiceId: "",
    presetId: "",
    blob: null,
    // 流式播放
    ctx: null,
    gain: null,
    nextTime: 0,
    sources: [],
    reader: null,
    busy: false,
    // 台词文本
    scriptLines: [],
    chips: { groups: [] },
    lastText: "",
    scriptAnchor: -1,
  };

  /* ================= 基础工具 ================= */

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ cache: "no-store" }, opts || {}));
    const ctype = res.headers.get("Content-Type") || "";
    let body;
    if (ctype.includes("application/json")) {
      body = await res.json();
    } else {
      body = await res.blob();
    }
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      if (body && body.error) {
        msg = typeof body.error === "string" ? body.error : (body.error.message || msg);
      }
      throw new Error(msg);
    }
    return body;
  }

  let toastTimer = 0;
  function toast(msg, isErr) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return "—";
    return sec.toFixed(1) + " 秒";
  }

  /* ================= 页面内弹框（不用浏览器 prompt/confirm） ================= */

  let modalResolve = null;

  function closeModal(result) {
    $("modal").classList.remove("show");
    const fn = modalResolve;
    modalResolve = null;
    if (fn) fn(result);
  }

  function openModal(opt) {
    const o = opt || {};
    $("modalTitle").textContent = o.title || "";
    const hint = $("modalHint");
    hint.textContent = o.hint || "";
    hint.style.display = o.hint ? "block" : "none";

    const input = $("modalInput");
    const area = $("modalText");

    input.style.display = o.confirm ? "none" : "block";
    input.value = o.value || "";
    input.placeholder = o.placeholder || "";

    area.style.display = o.text !== undefined && o.text !== null ? "block" : "none";
    area.value = o.text || "";

    $("modalOk").textContent = o.okText || "确定";
    $("modalCancel").textContent = o.cancelText || "取消";

    $("modal").classList.add("show");
    setTimeout(() => {
      if (o.confirm) $("modalOk").focus();
      else if (o.text !== undefined && o.text !== null) area.focus();
      else input.focus();
    }, 30);

    return new Promise((resolve) => { modalResolve = resolve; });
  }

  function askTitle(title, hint, value) {
    return openModal({ title, hint, value, placeholder: "给个名字" });
  }

  function askTextItem(title, hint, item) {
    return openModal({
      title, hint,
      value: item.title || "",
      text: item.content || "",
      okText: "保存",
    });
  }

  async function askConfirm(title, hint) {
    const r = await openModal({ title, hint, confirm: true, okText: "确定删除" });
    return r.ok === true;
  }

  $("modalCancel").addEventListener("click", () => closeModal({ ok: false }));
  $("modalOk").addEventListener("click", () => {
    closeModal({
      ok: true,
      value: $("modalInput").value.trim(),
      text: $("modalText").value,
    });
  });
  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal")) closeModal({ ok: false });
  });
  document.addEventListener("keydown", (e) => {
    if (!$("modal").classList.contains("show")) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal({ ok: false }); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target.tagName === "INPUT")) {
      e.preventDefault();
      $("modalOk").click();
    }
  });

  /* ================= 标签页 ================= */

  function switchView(name) {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.id === "view-" + name);
    });
    if (location.hash !== "#" + name) {
      history.replaceState(null, "", "#" + name);
    }
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  /* ================= 数据加载 ================= */

  let retryTimer = 0;

  function setBanner(text, kind) {
    const el = $("banner");
    if (!text) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.className = "banner " + (kind || "");
    el.textContent = text;
    el.style.display = "block";
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      refreshAll({ quiet: true });
    }, 3000);
  }

  function renderEverything() {
    renderVoices();
    renderPresets();
    renderTextChips();
    renderLibrary();
    renderPresetManage();
    renderTextManage();
    renderMoodChips();
    renderChipAdmin();
  }

  async function refreshAll(opt) {
    const quiet = opt && opt.quiet;
    let state = null;
    try {
      state = await api("/api/state");
    } catch (e) {
      setReady(false);
      setBanner("连不上本机服务：" + e.message + "（界面进程可能已经退出）", "err");
      if (!quiet) toast("连不上本机服务：" + e.message, true);
      return;
    }

    S.presets = state.presets || [];
    S.texts = state.texts || [];
    S.chips = state.chips || { groups: [] };
    setReady(state.ready);

    if (!state.ready) {
      setBanner(state.starting
        ? "语音服务没在运行，正在自动启动…模型加载约需 30~90 秒，好了会自动刷新，角色库稍后回来。"
        : "语音服务没在运行，正在尝试拉起…", "");
      // 保留已有列表，不要清空
      renderEverything();
      scheduleRetry();
      return;
    }

    setBanner("");
    try {
      S.voices = await api("/api/voices");
    } catch (e) {
      // 拉取失败就保留旧数据，不要显示成空库
      if (!quiet) toast("读取角色失败：" + e.message, true);
      scheduleRetry();
    }
    renderEverything();
  }

  function setReady(ok) {
    const pill = $("statusPill");
    pill.className = "pill " + (ok ? "pill-ok" : "pill-bad");
    pill.textContent = ok ? "● 服务正常" : "● 服务未就绪";
  }

  /* ================= 气泡版下拉（替换原生 select） ================= */

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.csel === "1") return null;
    sel.dataset.csel = "1";
    sel.classList.add("native-hidden");

    const wrap = document.createElement("div");
    wrap.className = "csel";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "csel-btn";

    const label = document.createElement("span");
    label.className = "csel-label";

    const caret = document.createElement("span");
    caret.className = "csel-caret";
    caret.textContent = "▾";

    btn.appendChild(label);
    btn.appendChild(caret);

    const panel = document.createElement("div");
    panel.className = "csel-panel";

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    function close() {
      panel.classList.remove("open");
      btn.classList.remove("open");
    }

    function refresh() {
      const current = sel.value;
      const chosen = sel.options[sel.selectedIndex];
      label.textContent = chosen ? chosen.textContent : "";
      panel.innerHTML = "";

      if (!sel.options.length) {
        const empty = document.createElement("div");
        empty.className = "csel-empty";
        empty.textContent = "（暂无可选项）";
        panel.appendChild(empty);
        return;
      }

      Array.prototype.forEach.call(sel.options, (opt) => {
        const row = document.createElement("div");
        row.className = "csel-opt" + (opt.value === current ? " on" : "");

        const text = document.createElement("span");
        text.textContent = opt.textContent;
        row.appendChild(text);

        if (opt.value === current) {
          const tick = document.createElement("span");
          tick.className = "tick";
          tick.textContent = "✓";
          row.appendChild(tick);
        }

        row.addEventListener("click", () => {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
          close();
        });

        panel.appendChild(row);
      });
    }

    function open() {
      document.querySelectorAll(".csel-panel.open").forEach((p) => p.classList.remove("open"));
      document.querySelectorAll(".csel-btn.open").forEach((b) => b.classList.remove("open"));
      refresh();
      panel.classList.add("open");
      btn.classList.add("open");
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (panel.classList.contains("open")) close();
      else open();
    });

    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", close);
    sel.addEventListener("change", refresh);

    wrap.__refresh = refresh;
    refresh();
    return wrap;
  }

  function refreshChipSelects() {
    document.querySelectorAll(".csel").forEach((wrap) => {
      if (wrap.__refresh) wrap.__refresh();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".csel-panel.open").forEach((p) => p.classList.remove("open"));
      document.querySelectorAll(".csel-btn.open").forEach((b) => b.classList.remove("open"));
    }
  });

  /* ================= 角色 ================= */

  function renderVoices() {
    const sel = $("voiceSelect");
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（无角色 · 纯音色设计）";
    sel.appendChild(none);

    S.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.id + "  ·  " + fmtTime(v.seconds || 0);
      sel.appendChild(opt);
    });

    if (S.voiceId && !S.voices.some((v) => v.id === S.voiceId)) S.voiceId = "";
    sel.value = S.voiceId;

    const cur = S.voices.find((v) => v.id === S.voiceId);
    $("voiceHint").textContent = cur
      ? "当前角色：" + cur.id + (cur.description ? "　—　" + cur.description : "")
      : "没选角色时是纯音色设计，声音完全由提示词决定。";

    refreshChipSelects();
  }

  $("voiceSelect").addEventListener("change", (e) => {
    S.voiceId = e.target.value;
    renderVoices();
    renderPresets();
  });

  /* ================= 提示词方案（只存提示词，不存正文） ================= */

  function presetsForVoice() {
    // 共用方案对所有角色可见；其余只看是不是当前角色的
    return S.presets.filter((p) => p.shared || (p.voice_id || "") === S.voiceId);
  }

  function renderPresets() {
    const list = $("presetList");
    list.innerHTML = "";
    const items = presetsForVoice();
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "这个角色还没有方案，点上面的「＋ 新建」把右侧提示词存成一条";
      list.appendChild(li);
      return;
    }
    items.forEach((p) => {
      const li = document.createElement("li");
      li.className = p.id === S.presetId ? "on" : "";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = p.title || "(未命名)";
      li.appendChild(t);

      if (p.shared) {
        const tag = document.createElement("span");
        tag.className = "share-tag";
        tag.textContent = "共用";
        li.appendChild(tag);
      }

      const v = document.createElement("span");
      v.className = "v";
      v.textContent = "cfg " + (p.cfg != null ? p.cfg : "—");
      li.appendChild(v);
      li.addEventListener("click", () => applyPreset(p, true));
      list.appendChild(li);
    });
  }

  function applyPreset(p, notify) {
    S.presetId = p.id;
    $("instructionInput").value = p.instruction || "";
    if (typeof syncMoodChips === "function") syncMoodChips();
    const cfg = p.cfg != null ? Number(p.cfg) : 2.0;
    $("cfgRange").value = cfg;
    $("cfgVal").textContent = cfg.toFixed(1);
    $("seedInput").value = p.seed != null ? p.seed : 42;
    renderPresets();
    if (notify) toast("已套用方案：" + (p.title || "(未命名)"));
  }

  async function savePreset() {
    const instruction = $("instructionInput").value.trim();
    if (!instruction) { toast("提示词是空的，先写点语气描述", true); return; }
    const def = instruction.replace(/\s+/g, " ").slice(0, 14);
    const r = await askTitle("保存提示词方案", "标题会显示在「开始配音」左侧的列表里。正文不会被保存。", def);
    if (!r.ok) return;
    const title = (r.value || def).trim();
    try {
      const saved = await api("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          voice_id: S.voiceId,
          instruction,
          cfg: Number($("cfgRange").value) || 2.0,
          seed: Number($("seedInput").value) || 42,
        }),
      });
      S.presetId = saved.id;
      await refreshAll();
      toast("已保存方案：" + saved.title);
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  $("presetNewBtn").addEventListener("click", savePreset);

  /* ================= 提示词气泡（存在 data/chips.json，可编辑） ================= */

  let CHIP_DRAFT = null;

  function chipGroups() {
    return (S.chips && Array.isArray(S.chips.groups)) ? S.chips.groups : [];
  }

  function cloneObj(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function buildChipGroup(labelText, entries, onPick) {
    const group = document.createElement("div");
    group.className = "chip-group";

    const label = document.createElement("span");
    label.className = "chip-group-label";
    label.textContent = labelText;

    const chips = document.createElement("div");
    chips.className = "chips";

    entries.forEach((pair) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.text = pair[1];
      chip.textContent = pair[0];
      chip.addEventListener("click", () => onPick(pair[1]));
      chips.appendChild(chip);
    });

    group.appendChild(label);
    group.appendChild(chips);
    return group;
  }

  function renderMoodChips() {
    const box = $("moodPanel");
    box.innerHTML = "";
    chipGroups().forEach((grp) => {
      const entries = (grp.items || []).map((it) => [it.label, it.text]);
      if (!entries.length) return;
      const handler = grp.exclusive
        ? (text) => toggleExclusive(grp, text)
        : (text) => toggleMood(text);
      box.appendChild(buildChipGroup(grp.name || "未分组", entries, handler));
    });
    syncMoodChips();
  }

  function tidyInstruction(text) {
    return text
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s，,。]+/, "")
      .replace(/[\s，,]+$/, "");
  }

  /* 互斥组：同组只能留一条 */
  function toggleExclusive(grp, text) {
    const ta = $("instructionInput");
    let cur = ta.value;
    const wasOn = cur.indexOf(text) >= 0;

    (grp.items || []).forEach((it) => {
      if (it.text && it.text !== text && cur.indexOf(it.text) >= 0) {
        cur = cur.replace(it.text, "");
      }
    });

    if (wasOn) {
      cur = cur.replace(text, "");
    } else {
      const base = cur.trim();
      cur = base ? base + " " + text : text;
    }

    ta.value = tidyInstruction(cur);
    syncMoodChips();
    ta.focus();
  }

  function toggleMood(text) {
    const ta = $("instructionInput");
    const cur = ta.value;
    if (cur.indexOf(text) >= 0) {
      let next = cur.replace(text, "");
      next = next.replace(/\s{2,}/g, " ").replace(/^[\s，,。]+/, "").replace(/[\s，,]+$/, "");
      ta.value = next;
    } else {
      const base = cur.trim();
      ta.value = base ? base + " " + text : text;
    }
    syncMoodChips();
    ta.focus();
  }

  function syncMoodChips() {
    const cur = $("instructionInput").value;
    $("moodPanel").querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("on", cur.indexOf(chip.dataset.text) >= 0);
    });
  }

  ["click", "keyup", "input", "select", "focus", "blur", "mouseup"].forEach((ev) => {
    $("textInput").addEventListener(ev, rememberCaret);
  });

  $("instructionInput").addEventListener("input", syncMoodChips);

  $("moodClearBtn").addEventListener("click", () => {
    $("instructionInput").value = "";
    syncMoodChips();
    $("instructionInput").focus();
    toast("提示词已清空");
  });

  /* ---------------- 气泡的管理界面 ---------------- */

  /* ---- 预设管理：每栏默认收起，收起时只留第一条 ---- */

  const SECTION_COLLAPSED = { chips: true, presets: true, texts: true };

  function applySection(key, boxId, btnId) {
    const box = $(boxId);
    const btn = $(btnId);
    if (!box || !btn) return;
    const collapsed = !!SECTION_COLLAPSED[key];
    const kids = Array.prototype.filter.call(box.children, (el) => el.nodeType === 1);
    kids.forEach((el, i) => {
      el.style.display = collapsed && i > 0 ? "none" : "";
    });
    // 气泡那一栏的「第一个」是第一个分组，收起时组内也只留第一行，别占太高
    if (boxId === "chipAdmin") {
      kids.forEach((el, gi) => {
        Array.prototype.forEach.call(el.querySelectorAll(".chip-admin-row"), (row, ri) => {
          row.style.display = collapsed && ri > 0 ? "none" : "";
        });
      });
    }
    btn.textContent = collapsed ? "展开" : "收起";
  }

  function toggleSection(key, boxId, btnId) {
    SECTION_COLLAPSED[key] = !SECTION_COLLAPSED[key];
    applySection(key, boxId, btnId);
  }

  function renderChipAdmin() {
    const box = $("chipAdmin");
    if (!box) return;
    if (!CHIP_DRAFT) CHIP_DRAFT = cloneObj(S.chips || { groups: [] });
    if (!Array.isArray(CHIP_DRAFT.groups)) CHIP_DRAFT.groups = [];

    box.innerHTML = "";

    let total = 0;
    CHIP_DRAFT.groups.forEach((grp) => { total += (grp.items || []).length; });
    $("chipCount").textContent = "（" + CHIP_DRAFT.groups.length + " 组 / " + total + " 条）";

    if (!CHIP_DRAFT.groups.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "还没有气泡，点下面「＋ 加一组」开始。";
      box.appendChild(empty);
      return;
    }

    CHIP_DRAFT.groups.forEach((grp, gi) => {
      const card = document.createElement("div");
      card.className = "chip-admin-group";

      const head = document.createElement("div");
      head.className = "chip-admin-head";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "chip-admin-name";
      nameInput.placeholder = "组名";
      nameInput.value = grp.name || "";
      nameInput.addEventListener("input", () => { grp.name = nameInput.value; });

      const mode = document.createElement("label");
      mode.className = "share-toggle";
      mode.title = "勾上表示这组同类只能选一条（比如语速）";
      const modeBox = document.createElement("input");
      modeBox.type = "checkbox";
      modeBox.checked = !!grp.exclusive;
      modeBox.addEventListener("change", () => { grp.exclusive = modeBox.checked; });
      mode.appendChild(modeBox);
      mode.appendChild(document.createTextNode("互斥"));

      const addBtn = document.createElement("button");
      addBtn.className = "mini";
      addBtn.textContent = "＋ 加一条";
      addBtn.addEventListener("click", () => {
        if (!Array.isArray(grp.items)) grp.items = [];
        grp.items.push({ label: "新气泡", text: "" });
        renderChipAdmin();
      });

      const delGroup = document.createElement("button");
      delGroup.className = "mini danger";
      delGroup.textContent = "删整组";
      delGroup.addEventListener("click", async () => {
        const ok = await askConfirm("删除整组", "「" + (grp.name || "未分组") + "」整组会从气泡区消失，保存后生效。");
        if (!ok) return;
        CHIP_DRAFT.groups.splice(gi, 1);
        renderChipAdmin();
      });

      head.appendChild(nameInput);
      head.appendChild(mode);
      head.appendChild(addBtn);
      head.appendChild(delGroup);
      card.appendChild(head);

      (grp.items || []).forEach((item, ii) => {
        const row = document.createElement("div");
        row.className = "chip-admin-row";

        const lb = document.createElement("input");
        lb.type = "text";
        lb.className = "chip-admin-name lb";
        lb.placeholder = "气泡文字";
        lb.value = item.label || "";
        lb.addEventListener("input", () => { item.label = lb.value; });

        const tx = document.createElement("textarea");
        tx.className = "tx";
        tx.rows = 2;
        tx.placeholder = "点这个气泡时，追加到提示词里的整句描述";
        tx.value = item.text || "";
        tx.addEventListener("input", () => { item.text = tx.value; });

        const del = document.createElement("button");
        del.className = "mini danger";
        del.textContent = "删除";
        del.addEventListener("click", () => {
          grp.items.splice(ii, 1);
          renderChipAdmin();
        });

        row.appendChild(lb);
        row.appendChild(tx);
        row.appendChild(del);
        card.appendChild(row);
      });

      box.appendChild(card);
    });
    applySection("chips", "chipAdmin", "chipToggle");
  }

  $("chipToggle").addEventListener("click", () => toggleSection("chips", "chipAdmin", "chipToggle"));
  $("presetSecToggle").addEventListener("click", () => toggleSection("presets", "presetManage", "presetSecToggle"));
  $("textSecToggle").addEventListener("click", () => toggleSection("texts", "textManage", "textSecToggle"));

  $("chipAddGroupBtn").addEventListener("click", () => {
    if (!CHIP_DRAFT) CHIP_DRAFT = cloneObj(S.chips || { groups: [] });
    if (!Array.isArray(CHIP_DRAFT.groups)) CHIP_DRAFT.groups = [];
    CHIP_DRAFT.groups.push({
      name: "新分组",
      exclusive: false,
      items: [{ label: "新气泡", text: "" }],
    });
    renderChipAdmin();
    toast("已加一组，记得点「保存气泡」");
  });

  $("chipResetBtn").addEventListener("click", () => {
    CHIP_DRAFT = null;
    renderChipAdmin();
    toast("已还原为已保存内容");
  });

  $("chipSaveBtn").addEventListener("click", async () => {
    if (!CHIP_DRAFT) { toast("没有改动"); return; }
    try {
      const saved = await api("/api/chips", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(CHIP_DRAFT),
      });
      S.chips = saved;
      CHIP_DRAFT = null;
      renderMoodChips();
      renderChipAdmin();
      toast("气泡已保存");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  });

  /* ================= 预设文本（全局，所有角色共用） ================= */

  /* 正文里的内联情绪标记（写进被朗读的文本，不是提示词） */
  const TEXT_TAGS = [
    "笑", "大笑", "大哭", "抽泣", "哽咽", "叹气",
    "咳嗽", "清嗓子", "惊讶", "尖叫", "喘息", "低语",
    "停顿", "颤抖", "咬牙",
  ];

  let lastCaret = { s: 0, e: 0 };
  let caretKnown = false;

  function rememberCaret() {
    const ta = $("textInput");
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    if (s == null || e == null) return;
    lastCaret = { s: s, e: e };
    caretKnown = true;
  }

  function insertTag(label) {
    const ta = $("textInput");
    const text = "[" + label + "]";
    const active = document.activeElement === ta;
    const len = ta.value.length;

    let start;
    let end;
    if (active) {
      start = ta.selectionStart == null ? len : ta.selectionStart;
      end = ta.selectionEnd == null ? start : ta.selectionEnd;
    } else if (caretKnown) {
      start = lastCaret.s;
      end = lastCaret.e;
    } else {
      start = len;
      end = len;
    }

    start = Math.max(0, Math.min(start, len));
    end = Math.max(start, Math.min(end, len));

    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const pos = start + text.length;

    lastCaret = { s: pos, e: pos };
    caretKnown = true;

    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }

    syncTextChips();
  }

  function renderTextTags() {
    const group = document.createElement("div");
    group.className = "chip-group";

    const label = document.createElement("span");
    label.className = "chip-group-label";
    label.textContent = "情绪标记";

    const chips = document.createElement("div");
    chips.className = "chips";

    TEXT_TAGS.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip tag";
      chip.textContent = "[" + tag + "]";
      chip.title = "在正文光标处插入 [" + tag + "]";
      chip.addEventListener("mousedown", (e) => e.preventDefault());
      chip.addEventListener("click", () => insertTag(tag));
      chips.appendChild(chip);
    });

    group.appendChild(label);
    group.appendChild(chips);
    return group;
  }

  function renderTextChips() {
    const box = $("textChips");
    box.innerHTML = "";

    const group = document.createElement("div");
    group.className = "chip-group";

    const label = document.createElement("span");
    label.className = "chip-group-label";
    label.textContent = "预设文本";

    const chips = document.createElement("div");
    chips.className = "chips";

    if (!S.texts.length) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "还没有预设文本，写好正文后点「存为预设文本」";
      chips.appendChild(hint);
    } else {
      S.texts.forEach((t) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.dataset.id = t.id;
        chip.dataset.content = t.content || "";
        chip.textContent = t.title || "(未命名)";
        chip.title = t.content || "";
        chip.addEventListener("click", () => {
          $("textInput").value = t.content || "";
          syncTextChips();
          toast("已套用文本：" + (t.title || ""));
        });
        chips.appendChild(chip);
      });
    }

    group.appendChild(label);
    group.appendChild(chips);
    box.appendChild(group);
    box.appendChild(renderTextTags());
    syncTextChips();
  }

  function syncTextChips() {
    const cur = $("textInput").value;
    $("textChips").querySelectorAll(".chip").forEach((chip) => {
      const same = cur !== "" && cur === chip.dataset.content;
      chip.classList.toggle("on", same);
    });
  }

  $("textInput").addEventListener("input", syncTextChips);

  $("textSaveBtn").addEventListener("click", async () => {
    const content = $("textInput").value.trim();
    if (!content) { toast("正文是空的，没东西可存", true); return; }
    const def = content.replace(/\s+/g, " ").slice(0, 14);
    const r = await askTextItem("保存为预设文本", "所有角色都可以使用这段文本。", { title: def, content });
    if (!r.ok) return;
    try {
      await api("/api/texts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: r.value || def, content: r.text || content }),
      });
      await refreshAll();
      toast("已保存到预设文本");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  });

  $("textNewBtn").addEventListener("click", async () => {
    const r = await askTextItem("新建预设文本", "所有角色都可以使用这段文本。", { title: "", content: "" });
    if (!r.ok) return;
    if (!r.text || !r.text.trim()) { toast("内容不能为空", true); return; }
    try {
      await api("/api/texts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: r.value || "未命名文本", content: r.text }),
      });
      await refreshAll();
      toast("已新建文本");
    } catch (e) {
      toast("新建失败：" + e.message, true);
    }
  });

  function renderTextManage() {
    const box = $("textManage");
    box.innerHTML = "";
    $("textCount").textContent = "（" + S.texts.length + " 条）";
    if (!S.texts.length) {
      box.innerHTML = '<p class="hint">还没有预设文本。</p>';
      return;
    }
    S.texts.forEach((t) => {
      const item = document.createElement("div");
      item.className = "item";

      const head = document.createElement("div");
      head.className = "item-head";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = t.title || "(未命名)";

      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = (t.content || "").length + " 字";

      const actions = document.createElement("div");
      actions.className = "item-actions";

      const useBtn = document.createElement("button");
      useBtn.className = "mini";
      useBtn.textContent = "使用";
      useBtn.addEventListener("click", () => {
        $("textInput").value = t.content || "";
        syncTextChips();
        switchView("voice");
        toast("已套用文本：" + (t.title || ""));
      });

      const editBtn = document.createElement("button");
      editBtn.className = "mini";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", async () => {
        const r = await askTextItem("编辑预设文本", "", t);
        if (!r.ok) return;
        try {
          await api("/api/texts/" + encodeURIComponent(t.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: r.value || "未命名文本", content: r.text || "" }),
          });
          await refreshAll();
          toast("已更新文本");
        } catch (e) {
          toast("更新失败：" + e.message, true);
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "mini danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!(await askConfirm("删除预设文本", "「" + (t.title || "未命名") + "」删除后不能恢复。"))) return;
        try {
          await api("/api/texts/" + encodeURIComponent(t.id), { method: "DELETE" });
          await refreshAll();
          toast("已删除文本");
        } catch (e) {
          toast("删除失败：" + e.message, true);
        }
      });

      actions.appendChild(useBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      head.appendChild(name);
      head.appendChild(meta);
      head.appendChild(actions);

      const body = document.createElement("div");
      body.className = "body-text";
      body.textContent = t.content || "";

      item.appendChild(head);
      item.appendChild(body);
      box.appendChild(item);
    });
    applySection("texts", "textManage", "textSecToggle");
  }

  /* ================= 流式生成 + 边生成边播放 ================= */

  function ensureCtx(sinkId) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!S.ctx) {
      S.ctx = new AC({ sampleRate: SAMPLE_RATE });
      S.gain = S.ctx.createGain();
      S.gain.connect(S.ctx.destination);
    }
    if (S.ctx.state === "suspended") {
      const p = S.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    if (S.ctx.setSinkId) {
      const want = sinkId || "";
      if (S.ctx.sinkId !== want) {
        try {
          const p = S.ctx.setSinkId(want);
          if (p && p.catch) p.catch(() => {});
        } catch (e) { /* 忽略，走默认设备 */ }
      }
    }
    S.nextTime = S.ctx.currentTime + 0.12;
    return S.ctx;
  }

  function scheduleChunk(ctx, int16) {
    const n = int16.length;
    if (!n) return;
    const buffer = ctx.createBuffer(1, n, SAMPLE_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i += 1) data[i] = int16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(S.gain);
    const at = Math.max(ctx.currentTime + 0.05, S.nextTime);
    src.start(at);
    S.nextTime = at + buffer.duration;
    S.sources.push(src);
    src.onended = () => {
      const i = S.sources.indexOf(src);
      if (i >= 0) S.sources.splice(i, 1);
    };
  }

  /* 只停声音：已排进队列的音频掐掉，但网络请求照旧往下读 */
  function stopSoundOnly() {
    S.sources.forEach((src) => { try { src.stop(); } catch (e) { /* ignore */ } });
    S.sources = [];
    S.nextTime = 0;
  }

  /* 连生成一起停：取消读取 + 停声音 */
  function stopPlayback() {
    if (S.reader) {
      try { S.reader.cancel(); } catch (e) { /* ignore */ }
      S.reader = null;
    }
    stopSoundOnly();
  }

  function buildWav(chunks) {
    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const buffer = new ArrayBuffer(44 + total * 2);
    const view = new DataView(buffer);
    const str = (off, s) => {
      for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    view.setUint32(4, 36 + total * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, total * 2, true);
    let off = 44;
    chunks.forEach((c) => {
      new Int16Array(buffer, off, c.length).set(c);
      off += c.length * 2;
    });
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function generate(opts) {
    const o = opts || {};
    const btn = o.btn || $("genBtn");
    const stopBtn = o.stopBtn || $("stopBtn");
    const hint = o.hint || $("genHint");

    if (S.busy) return;
    const text = (o.text !== undefined ? o.text : $("textInput").value).trim();
    if (!text) { toast("还没有要念的文字", true); return; }

    S.genSeq = (S.genSeq || 0) + 1;
    const myGen = S.genSeq;

    const payload = {
      input: text,
      instructions: $("instructionInput").value.trim() || "Speak clearly and naturally.",
      response_format: "pcm",
      cfg_scale: Number($("cfgRange").value) || 2.0,
      seed: Number($("seedInput").value) || 42,
    };
    if (S.voiceId) payload.voice = S.voiceId;

    stopPlayback();
    S.previewOn = true;
    S.abort = new AbortController();
    const ctx = ensureCtx("");
    if (!ctx) { toast("浏览器不支持 Web Audio，无法边生成边播放", true); return; }

    S.busy = true;
    S.lastText = text;
    btn.disabled = true;
    stopBtn.disabled = false;
    $("previewStopBtn").disabled = false;
    hint.textContent = "正在生成，边合成边播放…";

    const t0 = performance.now();
    const chunks = [];
    let leftover = null;
    let got = 0;

    try {
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: S.abort ? S.abort.signal : undefined,
      });
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
          const j = await res.json();
          if (j && j.error) msg = typeof j.error === "string" ? j.error : (j.error.message || msg);
        } catch (e) { /* ignore */ }
        if (res.status === 409) {
          hint.textContent = "上一段还在收尾，稍等一下再生成。";
          return;
        }
        throw new Error(msg);
      }
      if (!res.body) throw new Error("当前浏览器不支持流式读取");

      const reader = res.body.getReader();
      S.reader = reader;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        let bytes = step.value;
        if (leftover) {
          const joined = new Uint8Array(leftover.length + bytes.length);
          joined.set(leftover, 0);
          joined.set(bytes, leftover.length);
          bytes = joined;
          leftover = null;
        }
        if (bytes.length % 2 === 1) {
          leftover = bytes.slice(bytes.length - 1);
          bytes = bytes.slice(0, bytes.length - 1);
        }
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
        const copy = new Int16Array(int16.length);
        copy.set(int16);
        chunks.push(copy);
        got += copy.length;
        if (S.previewOn) scheduleChunk(ctx, copy);
        hint.textContent = "正在生成，已合成 " + (got / SAMPLE_RATE).toFixed(1) + " 秒…";
      }
      S.reader = null;

      if (got === 0) throw new Error("没有收到音频数据");

      const blob = buildWav(chunks);
      S.blob = blob;

      const cost = ((performance.now() - t0) / 1000).toFixed(1);
      const audioLen = (got / SAMPLE_RATE).toFixed(1);
      hint.textContent = "完成：" + audioLen + " 秒语音，用时 " + cost + " 秒。";
      refreshSaveHint();
    } catch (e) {
      if (S.genSeq !== myGen) return;          // 已经被新一轮接管，别覆盖它的状态
      if (String(e && e.name) === "AbortError") {
        hint.textContent = "已停止生成。";
      } else {
        hint.textContent = "生成失败：" + e.message;
        toast("生成失败：" + e.message, true);
      }
    } finally {
      if (S.genSeq === myGen) {
        S.busy = false;
        S.abort = null;
        btn.disabled = false;
        stopBtn.disabled = true;
        $("previewStopBtn").disabled = true;
      }
    }
  }

  /* ---- 保存语音文件 ---- */

  function safeName(s) {
    return String(s || "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "")
      .slice(0, 60);
  }

  function audioFileName() {
    const voice = safeName(S.voiceId) || "无角色";
    const body = safeName(S.lastText || "");
    const head = body.slice(0, 8);
    const tail = body.length > 8 ? "..." : "";
    return voice + "_" + head + tail + ".wav";
  }

  function refreshSaveHint() {
    const el = $("saveNameHint");
    if (!el) return;
    el.textContent = S.blob ? ("文件名：" + audioFileName()) : "";
  }

  function saveAudio() {
    if (!S.blob) { toast("还没有生成语音，先生成一段", true); return; }
    const url = URL.createObjectURL(S.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = audioFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("已保存：" + audioFileName());
  }

  $("genBtn").addEventListener("click", () => generate());
  $("stopBtn").addEventListener("click", () => {
    if (S.abort) {
      try { S.abort.abort(); } catch (e) { /* ignore */ }
      S.abort = null;
    }
    if (S.reader) {
      try { S.reader.cancel(); } catch (e) { /* ignore */ }
      S.reader = null;
    }
    stopPlayback();
    S.previewOn = false;
    S.busy = false;
    $("genBtn").disabled = false;
    $("stopBtn").disabled = true;
    $("previewStopBtn").disabled = true;
    $("genHint").textContent = "已停止生成，可以马上重新点生成。";
  });

  $("previewStopBtn").addEventListener("click", () => {
    S.previewOn = false;
    stopSoundOnly();                       // 只掐声音，不动 reader，生成继续
    $("previewStopBtn").disabled = true;
    $("genHint").textContent = "已停止预览，生成继续在后台跑，跑完照样能保存。";
  });

  $("cfgRange").addEventListener("input", (e) => {
    $("cfgVal").textContent = Number(e.target.value).toFixed(1);
  });
  $("reloadBtn").addEventListener("click", () => { refreshAll(); toast("已刷新"); });

  /* ================= 台词文本（长文按行断句） ================= */

  const SCRIPT_KEY = "breeze.script.text";

  function splitScript(raw) {
    return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  }

  function updateScriptCount() {
    const total = S.scriptLines.length;
    const picked = S.scriptLines.filter((l) => l.on).length;
    $("scriptCount").textContent = total
      ? "共 " + total + " 句，已选 " + picked + " 句"
      : "共 0 句";
  }

  function syncSelectedScript() {
    $("textInput").value = S.scriptLines
      .filter((l) => l.on)
      .map((l) => l.text)
      .join("\n");
    syncTextChips();
  }

  function parseScript() {
    const lines = splitScript($("scriptInput").value);
    const prev = new Map(S.scriptLines.map((l) => [l.text, l.on]));
    S.scriptLines = lines.map((t) => ({ text: t, on: prev.has(t) ? prev.get(t) : true }));
    S.scriptAnchor = -1;
    renderScriptLines();
    syncSelectedScript();
  }

  function renderScriptLines() {
    const box = $("scriptLines");
    box.innerHTML = "";
    updateScriptCount();

    if (!S.scriptLines.length) {
      const empty = document.createElement("div");
      empty.className = "line-empty";
      empty.textContent = "上面贴入文本后，这里会按行拆成一句一句";
      box.appendChild(empty);
      return;
    }

    S.scriptLines.forEach((line, i) => {
      const item = document.createElement("div");
      item.className = "line-item" + (line.on ? " on" : "") + (S.scriptAnchor === i ? " anchor" : "");

      const range = document.createElement("button");
      range.type = "button";
      range.className = "line-range";
      range.title = "范围选择：先点这里标记起点，再点另一句的同一个图标";
      range.textContent = "⇅";
      range.addEventListener("click", (e) => {
        e.stopPropagation();
        onRangeClick(i);
      });

      const checkWrap = document.createElement("label");
      checkWrap.className = "line-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = line.on;
      cb.addEventListener("change", () => {
        S.scriptLines[i].on = cb.checked;
        item.classList.toggle("on", cb.checked);
        updateScriptCount();
        syncSelectedScript();
      });
      checkWrap.appendChild(cb);

      const no = document.createElement("span");
      no.className = "line-no";
      no.textContent = String(i + 1);

      const text = document.createElement("span");
      text.className = "line-text";
      text.textContent = line.text;

      item.appendChild(range);
      item.appendChild(checkWrap);
      item.appendChild(no);
      item.appendChild(text);

      item.addEventListener("click", (e) => {
        if (e.target.closest(".line-check") || e.target.closest(".line-range")) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });

      box.appendChild(item);
    });
  }

  function onRangeClick(i) {
    if (S.scriptAnchor < 0) {
      S.scriptAnchor = i;
      renderScriptLines();
      toast("已标记第 " + (i + 1) + " 句，再点另一句前面的 ⇅ 完成范围选择");
      return;
    }
    const a = Math.min(S.scriptAnchor, i);
    const b = Math.max(S.scriptAnchor, i);
    for (let k = a; k <= b; k += 1) S.scriptLines[k].on = true;
    S.scriptAnchor = -1;
    renderScriptLines();
    syncSelectedScript();
    toast("已选中第 " + (a + 1) + " 到 " + (b + 1) + " 句");
  }

  let scriptTimer = 0;
  $("scriptInput").addEventListener("input", () => {
    try { localStorage.setItem(SCRIPT_KEY, $("scriptInput").value); } catch (e) { /* ignore */ }
    if (scriptTimer) clearTimeout(scriptTimer);
    scriptTimer = setTimeout(() => {
      scriptTimer = 0;
      parseScript();
    }, 280);
  });

  $("presetToggle").addEventListener("click", () => {
    const list = $("presetList");
    const open = list.style.display !== "none";
    list.style.display = open ? "none" : "";
    $("presetToggle").textContent = open ? "展开" : "收起";
  });

  $("scriptToggle").addEventListener("click", () => {
    const panel = $("scriptPanel");
    const open = panel.style.display !== "none";
    panel.style.display = open ? "none" : "block";
    $("scriptToggle").textContent = open ? "展开" : "收起";
    if (!open) $("scriptInput").focus();
  });

  $("scriptAllBtn").addEventListener("click", () => {
    S.scriptLines.forEach((l) => { l.on = true; });
    S.scriptAnchor = -1;
    renderScriptLines();
    syncSelectedScript();
  });

  $("scriptNoneBtn").addEventListener("click", () => {
    S.scriptLines.forEach((l) => { l.on = false; });
    S.scriptAnchor = -1;
    renderScriptLines();
    syncSelectedScript();
  });

  $("saveAudioBtn").addEventListener("click", saveAudio);

  /* ================= 音色库 ================= */

  function renderLibrary() {
    const box = $("libList");
    box.innerHTML = "";
    $("libCount").textContent = "（" + S.voices.length + " 个）";
    if (!S.voices.length) {
      box.innerHTML = '<p class="hint">还没有角色。去「创建角色」上传一段参考音频。</p>';
      return;
    }

    S.voices.forEach((v) => {
      const item = document.createElement("div");
      item.className = "item";

      const head = document.createElement("div");
      head.className = "item-head";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = v.id;

      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = fmtTime(v.seconds || 0) + "　参考文本 " + (v.ref_text || "").length + " 字";

      const actions = document.createElement("div");
      actions.className = "item-actions";

      const useBtn = document.createElement("button");
      useBtn.className = "mini";
      useBtn.textContent = "使用";
      useBtn.addEventListener("click", () => {
        S.voiceId = v.id;
        renderVoices();
        renderPresets();
        switchView("voice");
        toast("已选中角色：" + v.id);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "mini danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!(await askConfirm("删除角色", "「" + v.id + "」会连 .breeze 文件一起删掉，不可恢复。"))) return;
        try {
          await api("/api/voices/" + encodeURIComponent(v.id), { method: "DELETE" });
          if (S.voiceId === v.id) S.voiceId = "";
          S.presets = S.presets.filter((p) => p.voice_id !== v.id);
          await refreshAll();
          toast("已删除：" + v.id);
        } catch (e) {
          toast("删除失败：" + e.message, true);
        }
      });

      actions.appendChild(useBtn);
      actions.appendChild(delBtn);

      head.appendChild(name);
      head.appendChild(meta);
      head.appendChild(actions);

      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "编辑描述 / 查看参考文本";
      details.appendChild(summary);

      const descField = document.createElement("label");
      descField.className = "field";
      descField.style.marginTop = "10px";
      const descLabel = document.createElement("span");
      descLabel.textContent = "描述（会显示在角色列表里）";
      const descInput = document.createElement("input");
      descInput.type = "text";
      descInput.value = v.description || "";
      descInput.placeholder = "例如：李华，十几岁少女，声线清亮";
      descField.appendChild(descLabel);
      descField.appendChild(descInput);

      const saveBtn = document.createElement("button");
      saveBtn.className = "mini";
      saveBtn.textContent = "保存描述";
      saveBtn.addEventListener("click", async () => {
        try {
          await api("/api/voices/" + encodeURIComponent(v.id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: descInput.value }),
          });
          const target = S.voices.find((x) => x.id === v.id);
          if (target) target.description = descInput.value;
          renderVoices();
          toast("描述已保存");
        } catch (e) {
          toast("保存失败：" + e.message, true);
        }
      });

      const refBox = document.createElement("div");
      refBox.className = "body-text";
      refBox.textContent = v.ref_text || "(没有参考文本)";

      details.appendChild(descField);
      details.appendChild(saveBtn);
      details.appendChild(refBox);

      item.appendChild(head);
      item.appendChild(details);
      box.appendChild(item);
    });
  }

  /* ================= 方案管理 ================= */

  function renderPresetManage() {
    const box = $("presetManage");
    box.innerHTML = "";
    $("presetCount").textContent = "（" + S.presets.length + " 条）";
    if (!S.presets.length) {
      box.innerHTML = '<p class="hint">还没有方案。在「开始配音」里写好提示词后点左侧的「＋ 新建」。</p>';
      return;
    }

    S.presets.forEach((p) => {
      const item = document.createElement("div");
      item.className = "item";

      const head = document.createElement("div");
      head.className = "item-head";

      const name = document.createElement("span");
      name.className = "item-name";
      name.textContent = p.title || "(未命名)";

      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = (p.voice_id ? "角色 " + p.voice_id : "纯音色设计") + " · cfg " + (p.cfg != null ? p.cfg : "—");

      const shareWrap = document.createElement("label");
      shareWrap.className = "share-toggle";
      shareWrap.title = "勾上后，所有角色都能看到并使用这条方案";
      const shareBox = document.createElement("input");
      shareBox.type = "checkbox";
      shareBox.checked = !!p.shared;
      shareBox.addEventListener("change", async (ev) => {
        ev.stopPropagation();
        try {
          await api("/api/presets/" + encodeURIComponent(p.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({}, p, { shared: shareBox.checked })),
          });
          await refreshAll();
          toast(shareBox.checked ? "已设为共用，所有角色都能用了" : "已取消共用");
        } catch (e) {
          shareBox.checked = !shareBox.checked;
          toast("设置失败：" + e.message, true);
        }
      });
      shareWrap.appendChild(shareBox);
      shareWrap.appendChild(document.createTextNode("共用"));

      const actions = document.createElement("div");
      actions.className = "item-actions";

      const useBtn = document.createElement("button");
      useBtn.className = "mini";
      useBtn.textContent = "使用";
      useBtn.addEventListener("click", () => {
        S.voiceId = p.voice_id || "";
        applyPreset(p, true);
        renderVoices();
        switchView("voice");
      });

      const editBtn = document.createElement("button");
      editBtn.className = "mini";
      editBtn.textContent = "编辑";

      const delBtn = document.createElement("button");
      delBtn.className = "mini danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!(await askConfirm("删除方案", "「" + (p.title || "未命名") + "」删除后不能恢复。"))) return;
        try {
          await api("/api/presets/" + encodeURIComponent(p.id), { method: "DELETE" });
          if (S.presetId === p.id) S.presetId = "";
          await refreshAll();
          toast("方案已删除");
        } catch (e) {
          toast("删除失败：" + e.message, true);
        }
      });

      actions.appendChild(useBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      head.appendChild(name);
      head.appendChild(meta);
      head.appendChild(shareWrap);
      head.appendChild(actions);

      /* ---- 直接展开在下面的编辑面板 ---- */

      const editBox = document.createElement("div");
      editBox.className = "edit-box";
      editBox.style.display = "none";

      const titleField = document.createElement("label");
      titleField.className = "field";
      const titleSpan = document.createElement("span");
      titleSpan.textContent = "标题";
      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.value = p.title || "";
      titleField.appendChild(titleSpan);
      titleField.appendChild(titleInput);

      const taField = document.createElement("label");
      taField.className = "field";
      const taSpan = document.createElement("span");
      taSpan.textContent = "提示词 / 语气指令";
      const taInput = document.createElement("textarea");
      taInput.rows = 3;
      taInput.value = p.instruction || "";
      taField.appendChild(taSpan);
      taField.appendChild(taInput);

      const paramRow = document.createElement("div");
      paramRow.className = "row";

      const cfgField = document.createElement("label");
      cfgField.className = "field sm";
      const cfgSpan = document.createElement("span");
      cfgSpan.textContent = "引导强度";
      const cfgInput = document.createElement("input");
      cfgInput.type = "number";
      cfgInput.min = "1";
      cfgInput.max = "4";
      cfgInput.step = "0.1";
      cfgInput.value = p.cfg != null ? p.cfg : 2.0;
      cfgField.appendChild(cfgSpan);
      cfgField.appendChild(cfgInput);

      const seedField = document.createElement("label");
      seedField.className = "field sm";
      const seedSpan = document.createElement("span");
      seedSpan.textContent = "随机种子";
      const seedInput = document.createElement("input");
      seedInput.type = "number";
      seedInput.min = "1";
      seedInput.step = "1";
      seedInput.value = p.seed != null ? p.seed : 42;
      seedField.appendChild(seedSpan);
      seedField.appendChild(seedInput);

      paramRow.appendChild(cfgField);
      paramRow.appendChild(seedField);

      const btnRow = document.createElement("div");
      btnRow.className = "row actions";

      const saveBtn = document.createElement("button");
      saveBtn.className = "primary";
      saveBtn.style.padding = "6px 16px";
      saveBtn.textContent = "保存修改";
      saveBtn.addEventListener("click", async () => {
        try {
          await api("/api/presets/" + encodeURIComponent(p.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({}, p, {
              title: titleInput.value.trim() || "(未命名)",
              instruction: taInput.value.trim(),
              cfg: Number(cfgInput.value) || 2.0,
              seed: Number(seedInput.value) || 42,
            })),
          });
          await refreshAll();
          toast("已保存：" + (titleInput.value.trim() || "方案"));
        } catch (e) {
          toast("保存失败：" + e.message, true);
        }
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "ghost";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", () => {
        titleInput.value = p.title || "";
        taInput.value = p.instruction || "";
        cfgInput.value = p.cfg != null ? p.cfg : 2.0;
        seedInput.value = p.seed != null ? p.seed : 42;
        editBox.style.display = "none";
        editBtn.textContent = "编辑";
      });

      btnRow.appendChild(saveBtn);
      btnRow.appendChild(cancelBtn);

      editBox.appendChild(titleField);
      editBox.appendChild(taField);
      editBox.appendChild(paramRow);
      editBox.appendChild(btnRow);

      editBtn.addEventListener("click", () => {
        const open = editBox.style.display !== "none";
        editBox.style.display = open ? "none" : "block";
        editBtn.textContent = open ? "编辑" : "收起";
      });

      item.appendChild(head);
      item.appendChild(editBox);
      box.appendChild(item);
    });
    applySection("presets", "presetManage", "presetSecToggle");
  }

  /* ================= 创建角色 ================= */

  $("createVoiceBtn").addEventListener("click", async () => {
    const name = $("newVoiceName").value.trim();
    const file = $("newVoiceFile").files && $("newVoiceFile").files[0];
    const refText = $("newVoiceRef").value.trim();
    const desc = $("newVoiceDesc").value.trim();

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      toast("角色名只能用字母、数字、- 和 _", true); return;
    }
    if (!file) { toast("请选择参考音频", true); return; }
    if (!refText) { toast("参考文本必须填，要和音频一字不差", true); return; }

    const fd = new FormData();
    fd.append("ref_audio", file);
    fd.append("ref_text", refText);
    fd.append("name", name);
    if (desc) fd.append("description", desc);

    $("createHint").textContent = "正在编码参考音频…";
    try {
      await api("/api/voices", { method: "POST", body: fd });
      $("createHint").textContent = "已保存角色：" + name;
      S.voiceId = name;
      await refreshAll();
      switchView("voice");
      toast("角色已保存：" + name);
    } catch (e) {
      $("createHint").textContent = "保存失败：" + e.message;
      toast("保存失败：" + e.message, true);
    }
  });

  /* ================= 随机音色 ================= */

  const VOICE_POOL = [
    "一位十几岁的少女，嗓音清亮稚嫩，音调偏高，语速偏快，尾音轻轻收住。",
    "一位温柔的年轻女性，声音清晰，语速偏慢，语气平稳，像在讲一个安静的故事。",
    "一个低沉的成年男声，语速缓慢，咬字清楚，带一点克制的疲惫感。",
    "一位活泼的少女，声音明亮，语速快，句尾上扬，带着笑意。",
    "一位知性女性，音色偏冷，语速适中，吐字干净，情绪内敛。",
    "一个沙哑的男声，气息重，语速偏慢，像刚睡醒或者抽了很多烟。",
    "一位甜美的女声，音调偏高，语速轻快，带一点撒娇的尾音。",
    "一位成熟的女性旁白，声音厚实，节奏稳，句与句之间留白明显。",
    "一个少年音，声音清亮但有点单薄，语速偏快，语气随意。",
    "一位老者的声音，语速慢，气息短，句中停顿多，尾音往下掉。",
    "一位电台主播风格的女声，中音区，语速均匀，咬字标准，情绪克制。",
    "一个俏皮的少女音，鼻音略重，语速快，笑起来声音会往上跳。",
  ];

  $("randomBtn").addEventListener("click", () => {
    $("randomDesc").value = VOICE_POOL[Math.floor(Math.random() * VOICE_POOL.length)];
    $("randomHint").textContent = "";
  });

  $("randomCopyBtn").addEventListener("click", () => {
    const desc = $("randomDesc").value.trim();
    if (!desc) { toast("先抽一个音色", true); return; }
    $("instructionInput").value = desc;
    $("textInput").value = $("randomText").value;
    syncMoodChips();
    syncTextChips();
    S.voiceId = "";
    renderVoices();
    renderPresets();
    switchView("voice");
    toast("已带到「开始配音」");
  });

  $("randomGenBtn").addEventListener("click", async () => {
    const desc = $("randomDesc").value.trim();
    const text = $("randomText").value.trim();
    if (!desc) { toast("先抽一个音色", true); return; }
    if (!text) { toast("试听正文不能为空", true); return; }
    $("randomHint").textContent = "生成中…";
    try {
      const blob = await api("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          instructions: desc,
          response_format: "wav",
          cfg_scale: 2.0,
          seed: 42,
        }),
      });
      $("randomPlayer").src = URL.createObjectURL(blob);
      $("randomHint").textContent = "生成完成，点播放试听。";
    } catch (e) {
      $("randomHint").textContent = "生成失败：" + e.message;
    }
  });


  /* ================= 初始化 ================= */

  (async function init() {
    $("cfgVal").textContent = Number($("cfgRange").value).toFixed(1);
    $("randomDesc").value = VOICE_POOL[0];
    renderMoodChips();

    enhanceSelect($("voiceSelect"));

    const hash = (location.hash || "").replace("#", "");
    if (["voice", "create", "random", "library", "presets"].includes(hash)) {
      switchView(hash);
    }

    // 恢复上次贴的长文本，但不自动选中，保证正文仍然是空的
    try {
      const saved = localStorage.getItem(SCRIPT_KEY);
      if (saved) $("scriptInput").value = saved;
    } catch (e) { /* ignore */ }
    parseScript();
    S.scriptLines.forEach((l) => { l.on = false; });
    renderScriptLines();
    $("textInput").value = "";

    await refreshAll();

    // 正文留空，等用户自己写或套用预设文本
    $("textInput").value = "";
  })();
})();
