import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-drying-slots.json");
const port = Number(process.env.PORT || 3039);

// 竹帘位：东1~东10、西1~西10，共 20 个位置
const SLOTS = [
  ...Array.from({ length: 10 }, (_, i) => "东" + (i + 1)),
  ...Array.from({ length: 10 }, (_, i) => "西" + (i + 1)),
];
const MOISTURE_LIMIT = 12; // 一成二 = 12%
const REWEIGH_GAP_MS = 6 * 60 * 60 * 1000; // 两次称重相隔满六小时
const STATUSES = ["晾晒中", "待复称", "可打包", "已收帘"];

const seed = {
  items: [
    {
      id: "seed-1",
      code: "DR-001",
      weight: 46.8,
      slot: "东2",
      turner: "周慧",
      startAt: "2026-09-23T01:00:00.000Z",
      weighings: [],
      release: null,
      needsReweigh: false,
      history: [
        { at: "2026-09-23T01:00:00.000Z", type: "入晒", note: "登记入晒 46.8kg，竹帘位东2，翻帘人周慧" },
      ],
    },
    {
      id: "seed-2",
      code: "DR-002",
      weight: 51.4,
      slot: "东5",
      turner: "李茂才",
      startAt: "2026-09-22T20:00:00.000Z",
      weighings: [
        { at: "2026-09-23T02:10:00.000Z", weight: 39.6, moisture: 14.1 },
      ],
      release: null,
      needsReweigh: false,
      history: [
        { at: "2026-09-22T20:00:00.000Z", type: "入晒", note: "登记入晒 51.4kg，竹帘位东5，翻帘人李茂才" },
        { at: "2026-09-23T02:10:00.000Z", type: "称重", note: "第1次称重 39.6kg，含水率14.1%（不低于一成二，需复称）" },
      ],
    },
    {
      id: "seed-3",
      code: "DR-003",
      weight: 48,
      slot: "东7",
      turner: "林素",
      startAt: "2026-09-22T05:30:00.000Z",
      weighings: [
        { at: "2026-09-22T22:00:00.000Z", weight: 36.2, moisture: 11.8 },
        { at: "2026-09-23T05:00:00.000Z", weight: 35.9, moisture: 11.2 },
      ],
      release: {
        at: "2026-09-23T05:00:00.000Z",
        first: { at: "2026-09-22T22:00:00.000Z", weight: 36.2, moisture: 11.8 },
        second: { at: "2026-09-23T05:00:00.000Z", weight: 35.9, moisture: 11.2 },
      },
      needsReweigh: false,
      history: [
        { at: "2026-09-22T05:30:00.000Z", type: "入晒", note: "登记入晒 48kg，竹帘位东7，翻帘人林素" },
        { at: "2026-09-22T22:00:00.000Z", type: "称重", note: "第1次称重 36.2kg，含水率11.8%" },
        { at: "2026-09-23T05:00:00.000Z", type: "称重", note: "第2次称重 35.9kg，含水率11.2%" },
        { at: "2026-09-23T05:00:00.000Z", type: "打包放行", note: "连续两次含水率11.8%、11.2%，相隔7小时，均低于一成二，准予打包" },
      ],
    },
    {
      id: "seed-4",
      code: "DR-010",
      weight: 47.2,
      slot: "东4",
      turner: "阿珍",
      startAt: "2026-09-19T03:00:00.000Z",
      weighings: [
        { at: "2026-09-20T22:00:00.000Z", weight: 35.4, moisture: 11.6 },
        { at: "2026-09-21T04:30:00.000Z", weight: 35.1, moisture: 10.9 },
      ],
      release: {
        at: "2026-09-21T04:30:00.000Z",
        first: { at: "2026-09-20T22:00:00.000Z", weight: 35.4, moisture: 11.6 },
        second: { at: "2026-09-21T04:30:00.000Z", weight: 35.1, moisture: 10.9 },
      },
      needsReweigh: false,
      collectedAt: "2026-09-21T06:20:00.000Z",
      history: [
        { at: "2026-09-19T03:00:00.000Z", type: "入晒", note: "登记入晒 47.2kg，竹帘位东4，翻帘人阿珍" },
        { at: "2026-09-20T22:00:00.000Z", type: "称重", note: "第1次称重 35.4kg，含水率11.6%" },
        { at: "2026-09-21T04:30:00.000Z", type: "称重", note: "第2次称重 35.1kg，含水率10.9%" },
        { at: "2026-09-21T04:30:00.000Z", type: "打包放行", note: "连续两次含水率11.6%、10.9%，相隔6.5小时，均低于一成二，准予打包" },
        { at: "2026-09-21T06:20:00.000Z", type: "打包收帘", note: "打包完成并收帘，原竹帘位东4已腾空" },
      ],
    },
  ],
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "DR-" + Date.now(); }

function nowIso() { return new Date().toISOString(); }
function pushHistory(item, type, note, at) {
  item.history ||= [];
  item.history.push({ at: at || nowIso(), type, note });
}
function occupiedSlots(items, exceptId) {
  const set = new Set();
  for (const item of items) {
    if (!item.collectedAt && item.slot && item.id !== exceptId) set.add(item.slot);
  }
  return set;
}
function deriveStatus(item) {
  if (item.collectedAt) return "已收帘";
  if (item.release) return "可打包";
  if ((item.weighings || []).length > 0) return "待复称";
  return "晾晒中";
}
// 连续两次称重：含水率都低于 12%，且相隔满六小时；更正/挪位后需重新复称
function qualifies(item) {
  if (item.collectedAt || item.needsReweigh) return false;
  const w = item.weighings || [];
  if (w.length < 2) return false;
  const a = w[w.length - 2];
  const b = w[w.length - 1];
  return Number(a.moisture) < MOISTURE_LIMIT
    && Number(b.moisture) < MOISTURE_LIMIT
    && new Date(b.at) - new Date(a.at) >= REWEIGH_GAP_MS;
}
function grantRelease(item) {
  const [a, b] = item.weighings.slice(-2);
  const hours = Math.round((new Date(b.at) - new Date(a.at)) / 360000) / 10;
  item.release = { at: nowIso(), first: { ...a }, second: { ...b } };
  pushHistory(item, "打包放行", `连续两次含水率${a.moisture}%、${b.moisture}%，相隔${hours}小时，均低于一成二，准予打包`);
}
function voidRelease(item, reason) {
  if (item.release) {
    pushHistory(item, "放行失效", reason + "，原打包放行作废，旧结果留存履历，需重新复称");
    item.release = null;
  }
  item.needsReweigh = true;
}
function refreshRelease(item) {
  if (item.collectedAt) return;
  if (qualifies(item)) {
    if (!item.release) grantRelease(item);
  } else if (item.release) {
    voidRelease(item, "最近连续两次称重不再满足双低于一成二且相隔六小时");
  }
}
function summarize(item) {
  return { ...item, status: deriveStatus(item) };
}
function computeStats(items) {
  const stats = Object.fromEntries(STATUSES.map(s => [s, 0]));
  const occupied = new Set();
  for (const item of items) {
    stats[deriveStatus(item)] += 1;
    if (!item.collectedAt && item.slot) occupied.add(item.slot);
  }
  stats.totalSlots = SLOTS.length;
  stats.occupiedSlots = occupied.size;
  stats.emptySlots = SLOTS.length - occupied.size;
  return stats;
}
function nextCode(items) {
  let max = 0;
  for (const item of items) {
    const m = /^DR-(\d+)$/.exec(item.code || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "DR-" + String(max + 1).padStart(3, "0");
}
function toNumber(value, label) {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace("%", "").trim());
  if (!Number.isFinite(n)) throw new Error(label + "必须是数字");
  return n;
}
function parseAt(value) {
  if (!value) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("时刻格式不正确");
  return d;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>晾晒排位与打包放行台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; }
    button.mini { padding:3px 8px; font-size:12px; font-weight:400; margin-top:0; background:#69736a; }
    button:disabled { background:#b6bdb4; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; } .stat small { font-size:13px; color:var(--muted); }
    .stat.slot strong { color:var(--accent); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .card-head { display:flex; justify-content:space-between; align-items:center; gap:8px; } .card h3 { margin:0; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; white-space:nowrap; }
    .pill.run { background:#eef3e4; color:#4a633c; } .pill.wait { background:#f7edd9; color:#8a6214; }
    .pill.ok { background:#e2f0e0; color:#2f6b33; } .pill.done { background:#eceeed; color:#687066; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:150px; overflow:auto; display:grid; gap:3px; font-size:12.5px; }
    .warn { color:var(--warn); font-weight:700; } .good { color:var(--accent); font-weight:700; }
    .box { border-radius:6px; padding:8px 10px; font-size:13px; } .box.ok { background:#e9f3e6; border:1px solid #aec9a6; color:#2f6b33; }
    .box.bad { background:#f8ece8; border:1px solid #d8a798; color:#8a3b27; }
    .wrow { display:flex; justify-content:space-between; gap:6px; align-items:center; font-size:13px; padding:4px 0; border-bottom:1px dotted var(--line); }
    .actions { display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; border-top:1px dashed var(--line); padding-top:10px; }
    .actions label { margin:0 0 5px; } .actions select { width:auto; min-width:86px; } .actions button { margin-top:0; }
    .board { display:flex; flex-wrap:wrap; gap:6px; } .chip { font-size:12px; border:1px solid var(--line); border-radius:6px; padding:4px 8px; background:#f6f8f4; color:var(--muted); cursor:default; }
    .chip.free { cursor:pointer; } .chip.free:hover { border-color:var(--accent); }
    .chip.busy { background:#f3e9e6; border-color:#d8b7ad; color:#7d3b2a; }
    .inline-b { display:inline; background:none; border:0; padding:0; color:inherit; font:inherit; cursor:pointer; margin:0; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>晾晒排位与打包放行台</h1><div class="meta">入晒排位 · 竹帘位防重排 · 双称达标放行 · 更正挪位留痕</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>入晒登记</h2>
        <label>批次编号（留空自动生成）</label><input name="code" placeholder="例如 DR-011">
        <label>入晒重量（kg）</label><input name="weight" type="number" step="0.1" min="0.1" required>
        <label>竹帘位（仅显示空位）</label><select name="slot" id="slotSelect" required></select>
        <label>翻帘人</label><input name="turner" required>
        <label>开始时刻</label><input name="startAt" type="datetime-local" id="startAtInput">
        <button>登记排位</button>
      </form>
      <form id="weighForm" class="panel" style="margin-top:14px;padding:16px"><h2>称重 / 复称</h2>
        <label>选择批次</label><select name="id" id="itemSelect"></select>
        <label>本次重量（kg）</label><input name="weight" type="number" step="0.1" min="0.1" required>
        <label>含水率（%，低于 12 为合格）</label><input name="moisture" type="number" step="0.1" min="0" max="100" required>
        <label>称重时刻</label><input name="at" type="datetime-local" id="weighAtInput">
        <p class="meta" style="margin:8px 0 0">连续两次称重含水率均低于一成二（12%）、且相隔满六小时，才放行打包。</p>
        <button>提交称重</button>
      </form>
      <div class="panel" style="margin-top:14px"><h2>竹帘位一览</h2><div class="board" id="slotBoard"></div></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部批次</option>${STATUSES.map(s => "<option>" + s + "</option>").join("")}</select>
        <input id="search" placeholder="搜索编号、翻帘人、竹帘位">
      </div>
      <div class="panel"><h2>批次列表</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const SLOTS = ${JSON.stringify(SLOTS)};
    const STATUSES = ${JSON.stringify(STATUSES)};
    const createForm = document.querySelector('#createForm');
    const weighForm = document.querySelector('#weighForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const slotSelect = document.querySelector('#slotSelect');
    const slotBoard = document.querySelector('#slotBoard');
    let items = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function fmt(iso) {
      const d = new Date(iso);
      if (isNaN(d)) return esc(iso);
      const p = n => String(n).padStart(2, '0');
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function localInputValue(d) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function activeItems() { return items.filter(i => !i.collectedAt); }
    function busyMap() {
      const m = new Map();
      for (const i of activeItems()) m.set(i.slot, i);
      return m;
    }
    function emptySlots(exceptId) {
      const busy = busyMap();
      return SLOTS.filter(s => !busy.has(s) || busy.get(s).id === exceptId);
    }
    function statusClass(s) { return s === '可打包' ? 'ok' : s === '待复称' ? 'wait' : s === '已收帘' ? 'done' : 'run'; }

    function renderSelects() {
      const busy = busyMap();
      slotSelect.innerHTML = SLOTS.filter(s => !busy.has(s)).map(s => '<option>' + s + '</option>').join('')
        || '<option value="">暂无空位</option>';
      itemSelect.innerHTML = activeItems().map(i => '<option value="' + esc(i.id) + '">' + esc(i.code) + ' · ' + esc(i.slot) + ' · ' + i.status + '</option>').join('');
      slotBoard.innerHTML = SLOTS.map(s => {
        const it = busy.get(s);
        return it
          ? '<span class="chip busy" title="翻帘人' + esc(it.turner) + '｜' + it.status + '">' + s + ' ' + esc(it.code) + '</span>'
          : '<span class="chip free" data-slot="' + s + '" title="空位，点击填入登记表">' + s + ' 空</span>';
      }).join('');
    }

    function render() {
      renderSelects();
      const counts = Object.fromEntries(STATUSES.map(s => [s, items.filter(i => i.status === s).length]));
      const busy = busyMap();
      const empty = SLOTS.length - busy.size;
      statsEl.innerHTML =
        STATUSES.map(s => '<div class="stat"><span>' + s + '</span><strong>' + counts[s] + '</strong></div>').join('')
        + '<div class="stat slot"><span>空竹帘位</span><strong>' + empty + '<small> / ' + SLOTS.length + '</small></strong></div>';

      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(i => (!status || i.status === status)
        && (!q || [i.code, i.turner, i.slot].some(v => String(v || '').includes(q))));
      cards.innerHTML = visible.map(cardHtml).join('') || '<p class="meta">没有符合条件的批次。</p>';
    }

    function cardHtml(item) {
      const collected = !!item.collectedAt;
      const head = '<div class="card-head"><h3>' + esc(item.code) + '</h3><span class="pill ' + statusClass(item.status) + '">' + item.status + '</span></div>';
      const slotLine = collected
        ? '<div><b>竹帘位</b> 已收帘腾空 <span class="meta">（原位 ' + esc(item.slot) + '）</span></div>'
        : '<div><b>竹帘位</b> ' + esc(item.slot) + '</div>';
      const basic = slotLine
        + '<div><b>翻帘人</b> ' + esc(item.turner) + '</div>'
        + '<div><b>入晒重量</b> ' + esc(item.weight) + ' kg'
        + (collected ? '' : ' <button type="button" class="mini" data-correct-entry="' + esc(item.id) + '">更正重量</button>') + '</div>'
        + '<div class="meta">开始 ' + fmt(item.startAt) + (collected ? '｜收帘 ' + fmt(item.collectedAt) : '') + '</div>';

      const rows = (item.weighings || []).map((w, idx) => {
        const good = Number(w.moisture) < 12;
        return '<div class="wrow"><span>第' + (idx + 1) + '次 ' + fmt(w.at) + '｜' + esc(w.weight) + 'kg｜含水率 <b class="' + (good ? 'good' : 'warn') + '">' + esc(w.moisture) + '%</b> '
          + (good ? '合格' : '偏高') + '</span>'
          + (collected ? '' : '<button type="button" class="mini" data-correct="' + esc(item.id) + ':' + idx + '">更正重量</button>') + '</div>';
      }).join('');
      const weighings = '<div><b>称重记录</b></div>' + (rows || '<div class="meta">尚未称重</div>');

      let banner = '';
      if (item.release) {
        banner = '<div class="box ok">✅ 已放行可打包：两次含水率 ' + esc(item.release.first.moisture) + '%、' + esc(item.release.second.moisture)
          + '%，相隔 ' + Math.round((new Date(item.release.second.at) - new Date(item.release.first.at)) / 360000) / 10 + ' 小时<br><span class="meta">放行 ' + fmt(item.release.at) + '；更正重量或竹帘挪位将作废此放行</span></div>';
      } else {
        const lastVoid = (item.history || []).filter(h => h.type === '放行失效').slice(-1)[0];
        if (lastVoid) banner = '<div class="box bad">⛔ ' + esc(lastVoid.note) + '</div>';
      }

      let actions = '';
      if (!collected) {
        const moveOptions = emptySlots(item.id).map(s => '<option>' + s + '</option>').join('');
        actions = '<div class="actions">'
          + '<button type="button" class="secondary" data-pick="' + esc(item.id) + '">登记称重</button>'
          + '<div><label>竹帘挪位</label><select data-moveslot="' + esc(item.id) + '">' + moveOptions + '</select></div>'
          + '<button type="button" data-move="' + esc(item.id) + '">挪位</button>'
          + '<button type="button" data-collect="' + esc(item.id) + '"' + (item.release ? '' : ' disabled') + '>打包收帘</button>'
          + '</div>';
      }

      const logs = (item.history || []).slice().reverse().slice(0, 7)
        .map(l => '<div><span class="meta">' + fmt(l.at) + '</span> <b>· ' + l.type + '</b> ' + esc(l.note) + '</div>').join('');
      return '<article class="card">' + head + basic + weighings + banner + actions
        + '<div class="logs meta"><b>履历（最近 7 条）</b>' + logs + '</div></article>';
    }

    async function load() { items = (await api('/api/items')).map(i => ({ ...i, status: i.status })); render(); }

    cards.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      try {
        if (btn.dataset.pick) {
          itemSelect.value = btn.dataset.pick;
          weighForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (btn.dataset.correctEntry) {
          const id = btn.dataset.correctEntry;
          const item = items.find(i => i.id === id);
          const v = prompt('更正批次 ' + item.code + ' 的入晒重量（kg，原值 ' + item.weight + '）。\\n注意：若已放行，原放行将作废并需重新复称。');
          if (v == null || v.trim() === '') return;
          await api('/api/items/' + encodeURIComponent(id) + '/correct', { method: 'POST', body: JSON.stringify({ kind: 'entry', weight: v }) });
          await load();
        }
        if (btn.dataset.correct) {
          const [id, idx] = btn.dataset.correct.split(':');
          const item = items.find(i => i.id === id);
          const w = item.weighings[Number(idx)];
          const v = prompt('更正第 ' + (Number(idx) + 1) + ' 次称重重量（kg，原值 ' + w.weight + '）。\\n注意：更正重量会让原放行作废，旧结果留在履历。');
          if (v == null || v.trim() === '') return;
          await api('/api/items/' + encodeURIComponent(id) + '/correct', { method: 'POST', body: JSON.stringify({ kind: 'weighing', index: Number(idx), weight: v }) });
          await load();
        }
        if (btn.dataset.move) {
          const id = btn.dataset.move;
          const item = items.find(i => i.id === id);
          const target = document.querySelector('select[data-moveslot="' + CSS.escape(id) + '"]').value;
          if (!target) return alert('暂无可挪空位');
          if (!confirm('将批次 ' + item.code + ' 由 ' + item.slot + ' 挪到 ' + target + '？\\n挪位后原打包放行立即作废，需重新复称。')) return;
          await api('/api/items/' + encodeURIComponent(id) + '/move', { method: 'POST', body: JSON.stringify({ slot: target }) });
          await load();
        }
        if (btn.dataset.collect) {
          const id = btn.dataset.collect;
          const item = items.find(i => i.id === id);
          if (!confirm('确认批次 ' + item.code + ' 打包并收帘？收帘后竹帘位 ' + item.slot + ' 立即腾空，可排下一批。')) return;
          await api('/api/items/' + encodeURIComponent(id) + '/collect', { method: 'POST', body: '{}' });
          await load();
        }
      } catch (err) { alert(err.message); }
    });

    slotBoard.addEventListener('click', e => {
      const chip = e.target.closest('[data-slot]');
      if (!chip) return;
      slotSelect.value = chip.dataset.slot;
      createForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    createForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const f = Object.fromEntries(new FormData(createForm).entries());
        if (!f.slot) throw new Error('暂无空竹帘位，需先收帘腾位');
        await api('/api/items', { method: 'POST', body: JSON.stringify(f) });
        createForm.reset();
        document.querySelector('#startAtInput').value = localInputValue(new Date());
        await load();
      } catch (err) { alert(err.message); }
    };
    weighForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const f = Object.fromEntries(new FormData(weighForm).entries());
        await api('/api/items/' + encodeURIComponent(f.id) + '/weighings', { method: 'POST', body: JSON.stringify(f) });
        weighForm.reset();
        document.querySelector('#weighAtInput').value = localInputValue(new Date());
        await load();
      } catch (err) { alert(err.message); }
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    document.querySelector('#startAtInput').value = localInputValue(new Date());
    document.querySelector('#weighAtInput').value = localInputValue(new Date());
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const weight = toNumber(input.weight, "入晒重量");
      if (weight <= 0) return send(res, 400, { error: "入晒重量必须大于 0" });
      const slot = String(input.slot || "").trim();
      if (!SLOTS.includes(slot)) return send(res, 400, { error: "竹帘位不存在：" + slot });
      if (occupiedSlots(db.items).has(slot)) return send(res, 409, { error: "竹帘位 " + slot + " 尚未收帘，不能再排下一批" });
      const turner = String(input.turner || "").trim();
      if (!turner) return send(res, 400, { error: "请填写翻帘人" });
      const startAt = parseAt(input.startAt);
      const code = String(input.code || "").trim() || nextCode(db.items);
      if (db.items.some(i => i.code === code)) return send(res, 409, { error: "批次编号已存在：" + code });

      const item = {
        id: newId(), code, weight, slot, turner,
        startAt: startAt.toISOString(),
        weighings: [], release: null, needsReweigh: false, history: [],
      };
      pushHistory(item, "入晒", `登记入晒 ${weight}kg，竹帘位${slot}，翻帘人${turner}`, item.startAt);
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const weigh = url.pathname.match(/^\/api\/items\/([^/]+)\/weighings$/);
    if (weigh && req.method === "POST") {
      const item = db.items.find(x => x.id === weigh[1] || x.code === weigh[1]);
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.collectedAt) return send(res, 400, { error: "该批次已收帘，不能再称重" });
      const input = await body(req);
      const weight = toNumber(input.weight, "重量");
      const moisture = toNumber(input.moisture, "含水率");
      if (weight <= 0) return send(res, 400, { error: "重量必须大于 0" });
      if (moisture < 0 || moisture > 100) return send(res, 400, { error: "含水率应在 0~100 之间" });
      const at = parseAt(input.at).toISOString();

      item.weighings ||= [];
      item.weighings.push({ at, weight, moisture });
      item.needsReweigh = false;
      const good = moisture < MOISTURE_LIMIT;
      pushHistory(item, "称重", `第${item.weighings.length}次称重 ${weight}kg，含水率${moisture}%` + (good ? "" : "（不低于一成二，需复称）"), at);
      refreshRelease(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const correct = url.pathname.match(/^\/api\/items\/([^/]+)\/correct$/);
    if (correct && req.method === "POST") {
      const item = db.items.find(x => x.id === correct[1] || x.code === correct[1]);
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.collectedAt) return send(res, 400, { error: "该批次已收帘，记录不可更正" });
      const input = await body(req);
      const weight = toNumber(input.weight, "重量");
      if (weight <= 0) return send(res, 400, { error: "重量必须大于 0" });

      if (input.kind === "entry") {
        const old = item.weight;
        item.weight = weight;
        pushHistory(item, "重量更正", `入晒重量由 ${old}kg 更正为 ${weight}kg`);
        voidRelease(item, `入晒重量由 ${old}kg 更正为 ${weight}kg`);
      } else {
        const index = Number(input.index);
        if (!Number.isInteger(index) || !(index in (item.weighings || []))) return send(res, 400, { error: "称重记录不存在" });
        const old = item.weighings[index].weight;
        item.weighings[index] = { ...item.weighings[index], weight };
        pushHistory(item, "重量更正", `第${index + 1}次称重重量由 ${old}kg 更正为 ${weight}kg`);
        voidRelease(item, `第${index + 1}次称重重量由 ${old}kg 更正为 ${weight}kg`);
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const move = url.pathname.match(/^\/api\/items\/([^/]+)\/move$/);
    if (move && req.method === "POST") {
      const item = db.items.find(x => x.id === move[1] || x.code === move[1]);
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.collectedAt) return send(res, 400, { error: "该批次已收帘，无需挪位" });
      const input = await body(req);
      const target = String(input.slot || "").trim();
      if (!SLOTS.includes(target)) return send(res, 400, { error: "竹帘位不存在：" + target });
      if (occupiedSlots(db.items, item.id).has(target)) return send(res, 409, { error: "竹帘位 " + target + " 已被占用，未收帘不能重排" });
      const from = item.slot;
      if (from === target) return send(res, 400, { error: "新竹帘位与原位相同" });

      item.slot = target;
      pushHistory(item, "竹帘挪位", `竹帘由${from}挪至${target}`);
      voidRelease(item, `竹帘由${from}挪至${target}`);
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const collect = url.pathname.match(/^\/api\/items\/([^/]+)\/collect$/);
    if (collect && req.method === "POST") {
      const item = db.items.find(x => x.id === collect[1] || x.code === collect[1]);
      if (!item) return send(res, 404, { error: "批次不存在" });
      if (item.collectedAt) return send(res, 400, { error: "该批次已收帘" });
      if (!item.release) return send(res, 400, { error: "尚未取得打包放行（需连续两次含水率低于一成二且相隔六小时）" });
      const oldSlot = item.slot;
      item.collectedAt = nowIso();
      item.needsReweigh = false;
      pushHistory(item, "打包收帘", `打包完成并收帘，原竹帘位${oldSlot}已腾空`);
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("晾晒排位与打包放行台 listening on http://localhost:" + port));
