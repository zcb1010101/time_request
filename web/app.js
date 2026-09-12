/* TimeRequest 前端逻辑 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  st: null,            // /api/state
  records: [],         // /api/records
  stats: null,         // /api/stats
  editingId: null,     // 正在编辑的目标 id
  toastTimer: null,
  chartData: null,
};

const COLORS = ["#2563eb", "#0d9488", "#f59e0b", "#dc2626", "#06b6d4",
                "#84cc16", "#f97316", "#8b5cf6", "#64748b", "#e11d48"];
const DIST_COLORS = { "2xx": "#16a34a", "3xx": "#d97706",
                      "4xx": "#ea580c", "5xx": "#dc2626", "error": "#64748b" };
const DIST_LABEL = { "2xx": "2xx 成功", "3xx": "3xx 重定向", "4xx": "4xx 客户端错误",
                     "5xx": "5xx 服务端错误", "error": "请求失败" };

/* ------------------------------------------------------------ 基础工具 */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso, withDate = false) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const t = `${hh}:${mm}:${ss}`;
  if (!withDate) return t;
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return t;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return `${md} ${t}`;
}

function shortUrl(u) {
  if (!u) return "";
  return u.length > 52 ? u.slice(0, 52) + "…" : u;
}

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("请求失败 HTTP " + res.status));
  return data;
}

/* ------------------------------------------------------------ 数据刷新 */
async function refreshState() {
  try {
    const st = await api("/api/state");
    state.st = st;
    renderTargets(st.targets);
    renderTotals(st.totals);
    syncControls(st);
  } catch (e) {
    console.warn("state:", e);
  }
}

function syncControls(st) {
  const iv = $("interval");
  if (document.activeElement !== iv) iv.value = st.interval_s;
  const btn = $("btnRunning");
  btn.textContent = st.running ? "暂停" : "启动";
  btn.classList.toggle("primary", st.running);
}

function tick() {
  const el = $("nextRun");
  if (!state.st) { el.textContent = "—"; return; }
  if (!state.st.running) {
    el.innerHTML = "已暂停";
    return;
  }
  const remain = Math.max(0, Math.ceil((state.st.next_run_ms - Date.now()) / 1000));
  const mm = String(Math.floor(remain / 60)).padStart(2, "0");
  const ss = String(remain % 60).padStart(2, "0");
  const at = new Date(state.st.next_run_ms);
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  el.innerHTML = `下次检查 <b>${hm}:${String(at.getSeconds()).padStart(2, "0")}</b>（${mm}:${ss}）`;
}

async function refreshRecords() {
  try {
    const fid = $("filterTarget").value;
    const q = fid ? `?target_id=${fid}` : "";
    const data = await api(`/api/records?limit=200${q}`);
    state.records = data.records || [];
    renderTable();
  } catch (e) {
    console.warn("records:", e);
  }
}

async function refreshStats() {
  try {
    const ct = $("chartTarget").value;
    const q = ct ? `?target_id=${ct}` : "";
    const data = await api(`/api/stats?minutes=60${q}`);
    state.stats = data;
    renderChart(data);
    renderDonut(data.distribution);
    renderIssues();
  } catch (e) {
    console.warn("stats:", e);
  }
}

/* ------------------------------------------------------------ 目标列表 */
function renderTargets(targets) {
  $("targetCount").textContent = targets.length;
  const list = $("targetList");
  list.innerHTML = "";
  $("targetEmpty").hidden = targets.length > 0;

  // 填充下拉选项（保留当前选中）
  const sel1 = $("chartTarget"), sel2 = $("filterTarget");
  const v1 = sel1.value, v2 = sel2.value;
  for (const sel of [sel1, sel2]) {
    const cur = sel === sel1 ? v1 : v2;
    sel.innerHTML = `<option value="">${sel === sel1 ? "全部目标" : "全部目标"}</option>`;
    targets.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    });
    sel.value = cur;
  }

  targets.forEach((t) => {
    const li = document.createElement("li");
    li.className = "target-item" + (t.enabled ? "" : " off");
    li.innerHTML = `
      <div class="target-top">
        <span class="target-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <label class="switch" title="${t.enabled ? "点击暂停该目标" : "点击启用该目标"}">
          <input type="checkbox" data-act="toggle" ${t.enabled ? "checked" : ""}>
          <span class="slider"></span>
        </label>
      </div>
      <div class="target-url" title="${esc(t.url)}">${esc(t.url)}</div>
      <div class="target-actions">
        <button class="mini" data-act="edit">编辑</button>
        <button class="mini danger" data-act="del">删除</button>
      </div>`;
    li.querySelector('[data-act="toggle"]').addEventListener("change", async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/targets/${t.id}`, { method: "PUT", body: JSON.stringify({ enabled: e.target.checked }) });
        toast(e.target.checked ? `已启用「${t.name}」` : `已暂停「${t.name}」`);
        refreshState();
      } catch (err) { toast(err.message, true); }
    });
    li.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(t);
    });
    li.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除目标「${t.name}」吗？历史记录会保留。`)) return;
      try {
        await api(`/api/targets/${t.id}`, { method: "DELETE" });
        toast("已删除");
        refreshState(); refreshRecords();
      } catch (err) { toast(err.message, true); }
    });
    list.appendChild(li);
  });
}

/* ------------------------------------------------------------ 统计卡 */
function renderTotals(t) {
  $("stRecords").textContent = t.records;
  $("stOkRate").textContent = t.records ? Math.round((t.ok / t.records) * 100) + "%" : "—";
  $("stOkRate").classList.toggle("ok", t.records > 0 && t.ok / t.records > 0.95);
  $("stAvg").textContent = t.records ? t.avg_ms + " ms" : "—";
  $("stMax").textContent = t.records ? t.max_ms + " ms" : "—";
}

/* ------------------------------------------------------------ 记录表 */
function statusBadge(ok, sc) {
  if (sc == null) return `<span class="badge muted">ERR</span>`;
  let cls = "ok";
  if (sc >= 300 && sc < 400) cls = "warn";
  else if (sc >= 400) cls = "err";
  return `<span class="badge ${cls}">${sc}</span>`;
}

function methodTag(m) {
  let cls = "";
  if (m === "POST") cls = " post";
  else if (m === "PUT" || m === "PATCH") cls = " put";
  else if (m === "DELETE") cls = " del";
  return `<span class="method-tag${cls}">${esc(m)}</span>`;
}

function renderTable() {
  const tb = $("recordsTable").querySelector("tbody");
  tb.innerHTML = "";
  const rows = state.records;
  $("recCount").textContent = rows.length;
  $("recEmpty").hidden = rows.length > 0;
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.title = "点击查看请求包 / 响应包";
    let result = r.ok ? "成功" : (r.error || "失败");
    if (r.ok && r.redirects_n > 0) result = `成功（${r.redirects_n} 次重定向）`;
    tr.innerHTML = `
      <td class="time">${esc(fmtTime(r.ts))}</td>
      <td>${esc(r.target_name)}</td>
      <td>${methodTag(r.method)}</td>
      <td class="url" title="${esc(r.url)}">${esc(shortUrl(r.url))}</td>
      <td>${statusBadge(r.ok, r.status_code)}</td>
      <td class="dur ttfb">${r.ttfb_ms != null ? r.ttfb_ms + " ms" : "—"}</td>
      <td class="dur">${r.total_ms != null ? r.total_ms + " ms" : "—"}</td>
      <td class="result-cell${r.ok ? "" : " bad"}" title="${esc(result)}">${esc(result)}</td>`;
    tr.addEventListener("click", () => openDrawer(r.id));
    tb.appendChild(tr);
  });
}

/* ------------------------------------------------------------ 折线图 */
function renderChart(data) {
  const svg = $("lineChart");
  svg.innerHTML = "";
  const empty = $("chartEmpty");
  const legend = svg.querySelector(".chart-legend");
  const series = data.series || [];
  const minutes = data.minutes || 60;

  // 图例
  svg.parentElement.querySelectorAll(".chart-legend").forEach((n) => n.remove());
  if (series.length) {
    const lg = document.createElement("div");
    lg.className = "chart-legend";
    lg.style.cssText = "position:absolute;top:2px;left:6px;display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#7a8699;z-index:5;";
    series.forEach((s, i) => {
      const dot = document.createElement("span");
      dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${COLORS[i % COLORS.length]};margin-right:5px;`;
      const item = document.createElement("span");
      item.style.cssText = "display:flex;align-items:center;";
      item.appendChild(dot);
      item.appendChild(document.createTextNode(s.name));
      lg.appendChild(item);
    });
    svg.parentElement.appendChild(lg);
  }

  empty.hidden = series.length > 0;
  if (!series.length) return;

  const W = 900, H = 260, padL = 54, padR = 16, padT = 14, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const NS = "http://www.w3.org/2000/svg";

  // 计算 y 范围
  let vmax = 100;
  series.forEach((s) => (s.points || []).forEach((p) => {
    if (p && p.avg > vmax) vmax = p.avg;
  }));
  vmax = Math.ceil((vmax * 1.15) / 50) * 50;

  const x = (i) => (minutes === 1 ? padL : padL + (i / (minutes - 1)) * iw);
  const y = (v) => padT + (1 - v / vmax) * ih;

  // 网格与 y 轴
  for (let g = 0; g <= 4; g++) {
    const val = (vmax / 4) * g;
    const gy = y(val);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
    line.setAttribute("y1", gy); line.setAttribute("y2", gy);
    line.setAttribute("stroke", "#eef1f5"); line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", padL - 8); txt.setAttribute("y", gy + 4);
    txt.setAttribute("text-anchor", "end");
    txt.setAttribute("font-size", "11"); txt.setAttribute("fill", "#9aa6b6");
    txt.textContent = Math.round(val) + "ms";
    svg.appendChild(txt);
  }

  // x 轴刻度（每 10 分钟）
  const now = Date.now();
  for (let i = 0; i < minutes; i++) {
    if ((minutes - 1 - i) % 10 !== 0 && i !== minutes - 1) continue;
    const d = new Date(now - (minutes - 1 - i) * 60000);
    const txt = document.createElementNS(NS, "text");
    txt.setAttribute("x", x(i)); txt.setAttribute("y", H - 8);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("font-size", "11"); txt.setAttribute("fill", "#9aa6b6");
    txt.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    svg.appendChild(txt);
  }

  // 数据线
  const linePoints = [];
  series.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    const pts = s.points || [];
    let path = "";
    let started = false;
    pts.forEach((p, i) => {
      if (!p) { started = false; return; }
      const px = x(i), py = y(p.avg);
      path += (started ? " L" : "M") + px.toFixed(1) + " " + py.toFixed(1);
      started = true;
      linePoints.push({ x: px, y: py, idx: i, si });
    });
    if (path) {
      const pl = document.createElementNS(NS, "path");
      pl.setAttribute("d", path);
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke", color);
      pl.setAttribute("stroke-width", "2");
      pl.setAttribute("stroke-linejoin", "round");
      pl.setAttribute("stroke-linecap", "round");
      pl.setAttribute("opacity", "0.9");
      svg.appendChild(pl);
    }
    // 端点圆点
    pts.forEach((p, i) => {
      if (!p) return;
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", x(i)); c.setAttribute("cy", y(p.avg));
      c.setAttribute("r", "2.6");
      c.setAttribute("fill", color);
      svg.appendChild(c);
    });
  });

  state.chartData = { series, minutes, x, y, now };

  // tooltip
  const tip = $("chartTip");
  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((relX - padL) / iw) * (minutes - 1));
    if (idx < 0 || idx >= minutes) { tip.hidden = true; return; }
    const d = new Date(now - (minutes - 1 - idx) * 60000);
    let html = `<div class="tt-time">${fmtTime(d.toISOString(), true)}</div>`;
    series.forEach((s, si) => {
      const p = (s.points || [])[idx];
      if (!p) return;
      html += `<div class="tt-row"><span class="dot" style="background:${COLORS[si % COLORS.length]}"></span>
               <span>${esc(s.name)}</span><b>${p.avg} ms</b></div>`;
    });
    if (html.includes("tt-row")) {
      tip.innerHTML = html;
      tip.hidden = false;
      const cw = svg.parentElement.getBoundingClientRect();
      const leftPct = (relX / W) * 100;
      tip.style.left = Math.min(Math.max(leftPct, 12), 88) + "%";
    } else {
      tip.hidden = true;
    }
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
}

/* ------------------------------------------------------------ 环形图 */
function renderDonut(dist) {
  const svg = $("donut");
  svg.innerHTML = "";
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  $("donutTotal").textContent = total;
  const legend = $("donutLegend");
  legend.innerHTML = "";
  if (!total) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", "75"); t.setAttribute("y", "76");
    t.setAttribute("text-anchor", "middle"); t.setAttribute("fill", "#9aa6b6");
    t.setAttribute("font-size", "11");
    t.textContent = "暂无数据";
    svg.appendChild(t);
    return;
  }
  const NS = "http://www.w3.org/2000/svg";
  const r = 58, C = 2 * Math.PI * r;
  let offset = 0;
  Object.entries(dist).forEach(([key, n]) => {
    if (!n) return;
    const frac = n / total;
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", "75"); circle.setAttribute("cy", "75");
    circle.setAttribute("r", r);
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", DIST_COLORS[key]);
    circle.setAttribute("stroke-width", "24");
    circle.setAttribute("stroke-dasharray", `${frac * C} ${C}`);
    circle.setAttribute("stroke-dashoffset", -offset * C);
    circle.setAttribute("transform", "rotate(-90 75 75)");
    svg.appendChild(circle);
    offset += frac;

    const li = document.createElement("li");
    li.innerHTML = `<span class="dot" style="background:${DIST_COLORS[key]}"></span>
                    ${DIST_LABEL[key]} <b>${n}</b>`;
    legend.appendChild(li);
  });
}

/* ------------------------------------------------------------ 异常提醒 */
function renderIssues() {
  const box = $("issueBox");
  const issues = (state.records || [])
    .filter((r) => r.redirects_n > 0 || !r.ok)
    .slice(0, 5);
  if (!issues.length) {
    box.innerHTML = `<span class="empty-tip">暂无重定向或异常记录</span>`;
    return;
  }
  box.innerHTML = "";
  issues.forEach((r) => {
    const row = document.createElement("div");
    row.className = "issue-row";
    const tag = r.redirects_n > 0
      ? `<span class="tag redir">重定向 ×${r.redirects_n}</span>`
      : `<span class="tag error">异常</span>`;
    row.innerHTML = `
      ${tag}
      <span class="txt">${esc(r.target_name)} · ${esc(shortUrl(r.url))}</span>
      <span class="txt" style="flex:none;color:${r.ok ? "#16a34a" : "#dc2626"}">
        ${r.ok ? "" : esc(r.error || "失败")}${r.ok ? "→ " + (r.status_code || "?") : ""}</span>`;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => openDrawer(r.id));
    box.appendChild(row);
  });
}

/* ------------------------------------------------------------ 详情抽屉 */
function kvTable(headers) {
  let arr = [];
  if (typeof headers === "string") {
    try { arr = Object.entries(JSON.parse(headers)); } catch (e) { arr = [["(解析失败)", headers]]; }
  } else if (Array.isArray(headers)) {
    arr = headers;
  } else if (headers && typeof headers === "object") {
    arr = Object.entries(headers);
  }
  if (!arr.length) return `<p class="note">无</p>`;
  let html = `<table class="kv-table"><tbody>`;
  arr.forEach(([k, v]) => {
    html += `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  });
  return html + "</tbody></table>";
}

async function openDrawer(id) {
  try {
    const r = await api(`/api/records/${id}`);
    $("drawerMeta").textContent =
      `${fmtTime(r.ts, true)} · ${r.target_name || ("#" + r.target_id)}`;
    const body = $("drawerBody");

    const redirectHtml = (r.redirects || []).length
      ? `<div class="redirect-chain">${(r.redirects || []).map((h, i) => `
          <div class="redirect-row">
            <span>${esc(h.url)}</span>
            <span class="arrow">→ ${h.status}</span>
            <span>${esc(h.location || "")}</span>
          </div>`).join("")}
          <p class="note">共 ${(r.redirects || []).length} 次重定向，最终状态码 ${r.status_code ?? "—"}</p>
        </div>`
      : `<p class="note">无重定向</p>`;

    body.innerHTML = `
      <div class="pkg-section">
        <h3><span class="bar"></span>请求包</h3>
        <div class="req-line">
          <span class="method-tag">${esc(r.req_method || "GET")}</span>
          <span>${esc(r.req_url || "")}</span>
        </div>
        ${kvTable(r.req_headers)}
        ${r.req_body ? `<p class="note">请求体：</p><div class="pre-box">${esc(r.req_body)}</div>` : ""}
      </div>
      <div class="pkg-section">
        <h3><span class="bar"></span>重定向链</h3>
        ${redirectHtml}
      </div>
      <div class="pkg-section">
        <h3><span class="bar resp"></span>响应包</h3>
        ${r.error ? `<div class="err-box">${esc(r.error)}</div><p class="note" style="margin-top:8px"></p>` : ""}
        <div class="req-line" style="background:${r.ok ? "var(--ok-soft)" : "var(--err-soft)"};border-color:transparent">
          <span class="badge ${r.status_code == null ? "muted" : (r.status_code >= 400 ? "err" : (r.status_code >= 300 ? "warn" : "ok"))}">
            ${r.status_code ?? "ERR"}</span>
          <span>总耗时 <b>${r.total_ms ?? "—"} ms</b> · 首字节 ${r.ttfb_ms ?? "—"} ms · 响应体 ${r.resp_body_len ?? 0} B</span>
        </div>
        ${kvTable(r.resp_headers)}
        ${r.resp_body ? `
          <p class="note">响应体${r.resp_truncated ? `（已截断，仅前 512KB）` : ""}：</p>
          <div class="pre-box">${esc(r.resp_body)}</div>` : ""}
      </div>`;
    $("drawerMask").hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------ 弹窗 */
function openModal(target) {
  state.editingId = target ? target.id : null;
  $("modalTitle").textContent = target ? "编辑目标" : "添加目标";
  $("fName").value = target ? target.name : "";
  $("fUrl").value = target ? target.url : "";
  $("fMethod").value = target ? target.method : "GET";
  $("fHeaders").value = target ? (target.headers || "{}") : "{}";
  $("fBody").value = target ? (target.body || "") : "";
  $("modalMask").hidden = false;
  setTimeout(() => $("fUrl").focus(), 50);
}

async function saveModal() {
  const payload = {
    name: $("fName").value.trim(),
    url: $("fUrl").value.trim(),
    method: $("fMethod").value,
    headers: $("fHeaders").value.trim() || "{}",
    body: $("fBody").value,
  };
  if (!payload.url) { toast("URL 不能为空", true); return; }
  try {
    JSON.parse(payload.headers); // 校验 JSON
  } catch (e) {
    toast("请求头不是合法 JSON", true);
    return;
  }
  try {
    if (state.editingId) {
      await api(`/api/targets/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("已保存");
    } else {
      await api("/api/targets", { method: "POST", body: JSON.stringify(payload) });
      toast("已添加");
    }
    $("modalMask").hidden = true;
    refreshState(); refreshRecords(); refreshStats();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------ 事件绑定 */
function bind() {
  $("btnAdd").addEventListener("click", () => openModal(null));
  $("modalClose").addEventListener("click", () => { $("modalMask").hidden = true; });
  $("modalCancel").addEventListener("click", () => { $("modalMask").hidden = true; });
  $("modalSave").addEventListener("click", saveModal);
  $("modalMask").addEventListener("click", (e) => { if (e.target === $("modalMask")) $("modalMask").hidden = true; });
  $("fHeaders").addEventListener("keydown", (e) => { if (e.key === "Tab") { /* 允许 Tab 正常跳转 */ } });

  $("drawerClose").addEventListener("click", () => { $("drawerMask").hidden = true; });
  $("drawerMask").addEventListener("click", (e) => { if (e.target === $("drawerMask")) $("drawerMask").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("modalMask").hidden = true; $("drawerMask").hidden = true; }
  });

  $("interval").addEventListener("change", async () => {
    const v = parseInt($("interval").value, 10);
    if (!v || v < 1) { toast("间隔至少 1 秒", true); refreshState(); return; }
    try {
      await api("/api/config", { method: "PUT", body: JSON.stringify({ interval_s: v }) });
      toast(`检查间隔已设为 ${v} 秒`);
      refreshState();
    } catch (e) { toast(e.message, true); }
  });

  $("btnRunning").addEventListener("click", async () => {
    const next = !(state.st && state.st.running);
    try {
      await api("/api/config", { method: "PUT", body: JSON.stringify({ running: next }) });
      toast(next ? "已启动定时检查" : "已暂停");
      refreshState();
    } catch (e) { toast(e.message, true); }
  });

  $("btnRunNow").addEventListener("click", async () => {
    try {
      const r = await api("/api/run", { method: "POST", body: "{}" });
      toast(`已触发检查：${r.count} 个目标`);
      refreshState(); refreshRecords(); refreshStats();
    } catch (e) { toast(e.message, true); }
  });

  $("filterTarget").addEventListener("change", () => { refreshRecords(); });
  $("chartTarget").addEventListener("change", () => { refreshStats(); });
}

/* ------------------------------------------------------------ 启动 */
bind();
refreshState();
refreshRecords();
refreshStats();
setInterval(refreshState, 3000);
setInterval(refreshRecords, 3000);
setInterval(refreshStats, 30000);
setInterval(tick, 1000);
tick();
