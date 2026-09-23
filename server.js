import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-drying-release.json");
const port = Number(process.env.PORT || 3039);

// 一成二 = 12%
const MOISTURE_LIMIT = 12;
const WEIGH_GAP_MS = 6 * 60 * 60 * 1000;
const STATUS = { DRYING: "晾晒中", REWEIGH: "待复称", PACKABLE: "可打包", PACKED: "已收帘" };
const stages = [STATUS.DRYING, STATUS.REWEIGH, STATUS.PACKABLE, STATUS.PACKED];

const seed = {
  slots: ["甲字一帘", "甲字二帘", "甲字三帘", "乙字一帘", "乙字二帘", "乙字三帘", "丙字一帘", "丙字二帘", "丙字三帘", "丁字一帘", "丁字二帘", "丁字三帘"],
  items: [
    {
      id: "LS-1001",
      code: "LS-20260923-01",
      weightIn: 42.5,
      slot: "甲字一帘",
      turner: "周福",
      startedAt: "2026-09-23T01:00:00+08:00",
      status: STATUS.DRYING,
      round: 1,
      releasedAt: null,
      releasedBy: null,
      packedAt: null,
      weights: [
        { at: "2026-09-23T08:30:00+08:00", weight: 38.1, moisture: 14.2, round: 1, by: "周福" }
      ],
      turns: [],
      history: [
        { at: "2026-09-23T01:00:00+08:00", type: "入晒", note: "入晒 42.5kg，排位 甲字一帘，翻帘人 周福" }
      ]
    },
    {
      id: "LS-1002",
      code: "LS-20260923-02",
      weightIn: 38,
      slot: "甲字二帘",
      turner: "陈巧",
      startedAt: "2026-09-23T02:00:00+08:00",
      status: STATUS.REWEIGH,
      round: 1,
      releasedAt: null,
      releasedBy: null,
      packedAt: null,
      weights: [
        { at: "2026-09-23T07:00:00+08:00", weight: 34.2, moisture: 13.4, round: 1, by: "陈巧" },
        { at: "2026-09-23T10:00:00+08:00", weight: 33.8, moisture: 12.6, round: 1, by: "陈巧" }
      ],
      turns: [],
      history: [
        { at: "2026-09-23T02:00:00+08:00", type: "入晒", note: "入晒 38kg，排位 甲字二帘，翻帘人 陈巧" }
      ]
    },
    {
      id: "LS-1003",
      code: "LS-20260923-03",
      weightIn: 45,
      slot: "甲字三帘",
      turner: "林素",
      startedAt: "2026-09-23T01:30:00+08:00",
      status: STATUS.PACKABLE,
      round: 1,
      releasedAt: "2026-09-23T09:00:00+08:00",
      releasedBy: "林素",
      packedAt: null,
      weights: [
        { at: "2026-09-23T02:30:00+08:00", weight: 40.6, moisture: 11.4, round: 1, by: "林素" },
        { at: "2026-09-23T09:00:00+08:00", weight: 40.1, moisture: 10.8, round: 1, by: "林素" }
      ],
      turns: [],
      history: [
        { at: "2026-09-23T01:30:00+08:00", type: "入晒", note: "入晒 45kg，排位 甲字三帘，翻帘人 林素" },
        { at: "2026-09-23T09:00:00+08:00", type: "放行", note: "两次称重含水率均低于 12% 且相隔满 6 小时，放行可打包" }
      ]
    }
  ],
  seq: 1003
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.slots ||= [];
  db.items ||= [];
  db.seq ||= 1000;
  return db;
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
function err(res, status, code, message) { return send(res, status, { error: code, message }); }
function nowIso() { return new Date().toISOString(); }
function parseAt(input) {
  if (!input || !String(input).trim()) return new Date();
  const t = new Date(input);
  return isNaN(t) ? null : t;
}
function num(input) {
  const n = Number(input);
  return Number.isFinite(n) ? n : NaN;
}

function occupiedSlots(db) {
  const set = new Set();
  for (const item of db.items) {
    if (item.status !== STATUS.PACKED) set.add(item.slot);
  }
  return set;
}

// 依据当前轮次的最近两次连续称重判定是否放行
function evaluateWeighings(item) {
  if (item.status === STATUS.PACKED) return item.status;
  const round = item.round || 1;
  const list = (item.weights || []).filter(w => (w.round || 1) === round);
  if (list.length < 2) return list.length === 1 ? STATUS.REWEIGH : STATUS.DRYING;
  const [a, b] = list.slice(-2);
  const pass = Number(a.moisture) < MOISTURE_LIMIT &&
    Number(b.moisture) < MOISTURE_LIMIT &&
    new Date(b.at).getTime() - new Date(a.at).getTime() >= WEIGH_GAP_MS;
  return pass ? STATUS.PACKABLE : STATUS.REWEIGH;
}

// 重量更正 / 竹帘挪位：放行失效，旧结果留在履历，下一轮称重重新算
function invalidateRelease(db, item, reason, by) {
  const wasReleased = item.status === STATUS.PACKABLE;
  item.round = (item.round || 1) + 1;
  if (wasReleased) {
    item.status = STATUS.REWEIGH;
    item.releasedAt = null;
    item.releasedBy = null;
    item.history.push({ at: nowIso(), type: "放行作废", note: reason + (by ? "（操作人：" + by + "）" : "") });
  }
}

function findItem(db, id) {
  return db.items.find(x => x.id === id || x.code === id);
}

function itemView(db, item) {
  const occupied = occupiedSlots(db);
  const lastWeights = (item.weights || []).filter(w => (w.round || 1) === (item.round || 1)).slice(-2);
  return { ...item, lastWeights, slotFree: !occupied.has(item.slot) ? true : item.status === STATUS.PACKED };
}

function overview(db) {
  const occupied = occupiedSlots(db);
  const counts = Object.fromEntries(stages.map(s => [s, 0]));
  for (const item of db.items) counts[item.status] = (counts[item.status] || 0) + 1;
  const slotView = db.slots.map(slot => {
    const item = db.items.find(i => i.slot === slot && i.status !== STATUS.PACKED);
    return { slot, free: !item, itemId: item ? item.id : null, code: item ? item.code : null, status: item ? item.status : null };
  });
  return {
    items: db.items.map(i => itemView(db, i)),
    slots: slotView,
    stats: {
      ...counts,
      totalSlots: db.slots.length,
      freeSlots: db.slots.length - occupied.size
    }
  };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>晾晒排位与打包放行台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#b07a2a; --ok:#3d7a4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; font-size:13px; }
    button.secondary { background:#69736a; } button.warn { background:var(--warn); } button.hold { background:var(--hold); } button:disabled { opacity:.45; cursor:not-allowed; }
    .row { display:flex; gap:8px; flex-wrap:wrap; } .row > * { flex:1; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:24px; } .stat.free strong { color:var(--ok); font-size:30px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .board { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
    .cell { border:1px solid var(--line); border-radius:6px; padding:7px 10px; font-size:13px; background:#fbfdf9; min-width:108px; }
    .cell b { display:block; } .cell.free { border-style:dashed; color:var(--ok); }
    .cell.busy { background:#f6f1e7; border-color:#d8c49a; color:#7a5a1d; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; }
    .pill.drying { background:#eef3e8; } .pill.reweigh { background:#f8f0df; color:var(--hold); } .pill.packable { background:#e4f0e7; color:var(--ok); font-weight:700; } .pill.packed { background:#eef0ee; color:var(--muted); }
    .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:13px; } .kv b { color:var(--muted); font-weight:400; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:150px; overflow:auto; font-size:12px; display:grid; gap:3px; }
    .old { color:var(--muted); text-decoration:line-through; } .tag { font-size:11px; border:1px solid var(--line); border-radius:4px; padding:0 5px; color:var(--muted); }
    .warnText { color:var(--warn); font-weight:700; } .rule { font-size:13px; color:var(--muted); line-height:1.7; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>晾晒排位与打包放行台</h1><div class="meta">入晒登记 · 竹帘位防重排 · 两次复称放行 · 更正留履历</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>批次入晒登记</h2>
        <div class="row">
          <div><label>批次编号（留空自动生成）</label><input name="code" placeholder="LS-20260923-04"></div>
        </div>
        <div class="row">
          <div><label>入晒重量（kg）</label><input name="weightIn" type="number" step="0.01" min="0" required></div>
          <div><label>翻帘人</label><input name="turner" required></div>
        </div>
        <label>竹帘位（未收帘的位置不能再排）</label>
        <div class="row">
          <select name="slot" id="slotSelect" required></select>
          <button type="button" class="secondary" id="addSlot" style="flex:0 0 auto">新帘位</button>
        </div>
        <label>开始晾晒时刻（留空为现在）</label>
        <input name="startedAt" type="datetime-local" id="startTime">
        <div style="margin-top:12px"><button>登记入晒并占位</button></div>
      </form>
      <div class="panel" style="margin-top:14px">
        <h2>放行规则</h2>
        <div class="rule">
          1. 入晒登记入晒重量、竹帘位、翻帘人和开始时刻，系统自动占位。<br>
          2. 竹帘位未收帘前，不能再排下一批；换班先看竹帘看板。<br>
          3. 晾晒结束后连续两次称重，含水率<b>均低于 12%（一成二）</b>且两次<b>相隔满 6 小时</b>，才放行打包。<br>
          4. 入晒重量更正或竹帘挪位，原放行立即作废，旧称重结果保留在批次履历中，需重新复称。<br>
          5. 打包收帘后竹帘位才释放为空位。
        </div>
      </div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px">
        <h2>竹帘位看板</h2>
        <div class="board" id="board"></div>
      </div>
      <div class="toolbar">
        <select id="statusFilter">
          <option value="">全部批次</option>
          <option value="晾晒中">晾晒中</option>
          <option value="待复称">待复称</option>
          <option value="可打包">可打包</option>
          <option value="已收帘">已收帘</option>
        </select>
        <input id="search" placeholder="搜索编号、翻帘人、竹帘位">
      </div>
      <div class="grid" id="cards"></div>
    </section>
  </main>
  <script>
    const stages = ["晾晒中", "待复称", "可打包", "已收帘"];
    const createForm = document.querySelector('#createForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const boardEl = document.querySelector('#board');
    const slotSelect = document.querySelector('#slotSelect');
    let data = { items: [], slots: [], stats: {} };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { 'Content-Type': 'application/json' } } : options);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || '请求失败');
      return json;
    }
    function esc(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function fmt(at) {
      if (!at) return '';
      const d = new Date(at);
      if (isNaN(d)) return at;
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function localNow() {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    async function act(path, method, payload) {
      try { await api(path, { method, body: payload ? JSON.stringify(payload) : undefined }); await load(); }
      catch (e) { alert(e.message); }
    }

    function renderSlots() {
      const free = data.slots.filter(s => s.free);
      slotSelect.innerHTML = (free.length ? free : data.slots).map(s => '<option value="' + esc(s.slot) + '"' + (s.free ? '' : ' disabled') + '>' + esc(s.slot) + (s.free ? '（空位）' : '（占用中）') + '</option>').join('');
      boardEl.innerHTML = data.slots.map(s => s.free
        ? '<div class="cell free"><b>' + esc(s.slot) + '</b>空位</div>'
        : '<div class="cell busy"><b>' + esc(s.slot) + '</b>' + esc(s.code) + '<br>' + esc(s.status) + '</div>').join('');
    }

    function renderStats() {
      const s = data.stats;
      const cells = [
        ['free', '空竹帘位', (s.freeSlots || 0) + ' / ' + (s.totalSlots || 0)],
        ['', '晾晒中', s['晾晒中'] || 0],
        ['', '待复称', s['待复称'] || 0],
        ['', '可打包', s['可打包'] || 0],
        ['', '已收帘', s['已收帘'] || 0]
      ];
      statsEl.innerHTML = cells.map(([cls, k, v]) => '<div class="stat ' + cls + '"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
    }

    function renderCards() {
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = data.items.filter(i =>
        (!status || i.status === status) &&
        (!q || [i.code, i.turner, i.slot, i.weightIn].join(' ').includes(q)));
      cards.innerHTML = visible.map(cardHtml).join('') || '<div class="panel meta">没有符合条件的批次</div>';
      bindCardButtons();
    }

    function cardHtml(item) {
      const cls = { '晾晒中': 'drying', '待复称': 'reweigh', '可打包': 'packable', '已收帘': 'packed' }[item.status];
      const weightRows = (item.weights || []).map(w => {
        const old = (w.round || 1) !== (item.round || 1);
        return '<div class="' + (old ? 'old' : '') + '">称 ' + fmt(w.at) + ' · ' + esc(w.weight) + 'kg · 含水率 ' + esc(w.moisture) + '%' + (old ? ' <span class="tag">旧轮次作废</span>' : '') + ' · ' + esc(w.by || '') + '</div>';
      }).join('');
      const turnRows = (item.turns || []).map(t => '<div>翻帘 ' + fmt(t.at) + ' · ' + esc(t.by || '') + (t.note ? ' · ' + esc(t.note) : '') + '</div>').join('');
      const histRows = (item.history || []).map(h => '<div>[' + esc(h.type) + '] ' + fmt(h.at) + ' ' + esc(h.note) + '</div>').join('');
      const hint = weighHint(item);
      const buttons = buttonsHtml(item);
      return '<article class="card">'
        + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3>' + esc(item.code) + '</h3><span class="pill ' + cls + '">' + item.status + '</span></div>'
        + '<div class="kv">'
        + '<b>入晒重量</b><span>' + esc(item.weightIn) + ' kg</span>'
        + '<b>竹帘位</b><span>' + esc(item.slot) + '</span>'
        + '<b>翻帘人</b><span>' + esc(item.turner) + '</span>'
        + '<b>开始时刻</b><span>' + fmt(item.startedAt) + '</span>'
        + (item.releasedAt ? '<b>放行时刻</b><span class="warnText" style="color:var(--ok)">' + fmt(item.releasedAt) + '（' + esc(item.releasedBy || '') + '）</span>' : '')
        + (item.packedAt ? '<b>收帘时刻</b><span>' + fmt(item.packedAt) + '</span>' : '')
        + '</div>'
        + (hint ? '<div class="meta">' + hint + '</div>' : '')
        + (item.status === '已收帘' ? '' : '<div class="row">' + buttons + '</div>')
        + '<div class="logs"><b class="meta">批次履历（旧结果保留可查）</b>' + (weightRows + turnRows + histRows || '<div>暂无记录</div>') + '</div>'
        + '</article>';
    }

    function weighHint(item) {
      if (item.status === '已收帘') return '已打包收帘，竹帘位已释放。';
      if (item.status === '可打包') return '本轮连续两次称重达标，已放行；更正重量或挪位将作废放行。';
      const w = item.lastWeights || [];
      if (!w.length) return '尚未称重：晾晒结束后登记第一次称重，状态转为「待复称」。';
      if (w.length === 1) {
        const next = new Date(new Date(w[0].at).getTime() + 6 * 3600 * 1000);
        const needTime = Number(w[0].moisture) >= 12;
        return '已称 1 次（含水率 ' + esc(w[0].moisture) + '%）。需在 ' + fmt(next.toISOString()) + ' 之后复称，且两次含水率均低于 12%。' + (needTime ? ' 当前含水率未达标。' : '');
      }
      const [a, b] = w;
      const gapH = ((new Date(b.at) - new Date(a.at)) / 3600000).toFixed(1);
      const badMoist = Number(a.moisture) >= 12 || Number(b.moisture) >= 12;
      return '最近两次含水率 ' + esc(a.moisture) + '% / ' + esc(b.moisture) + '%，相隔 ' + gapH + ' 小时。'
        + (badMoist ? '含水率未全部低于 12%。' : '')
        + (gapH < 6 ? '相隔不足 6 小时。' : '')
        + ' 再称一次按最近两次连续结果判定。';
    }

    function buttonsHtml(item) {
      const freeSlots = data.slots.filter(s => s.free).map(s => s.slot);
      let html = '<button data-act="weigh" data-id="' + esc(item.id) + '">称重登记</button>';
      html += '<button class="secondary" data-act="turn" data-id="' + esc(item.id) + '">翻帘记录</button>';
      html += '<button class="secondary" data-act="weightIn" data-id="' + esc(item.id) + '">重量更正</button>';
      html += '<button class="hold" data-act="move" data-id="' + esc(item.id) + '"' + (freeSlots.length ? '' : ' disabled') + '>竹帘挪位</button>';
      if (item.status === '可打包') html += '<button data-act="pack" data-id="' + esc(item.id) + '">打包收帘</button>';
      return html;
    }

    function bindCardButtons() {
      document.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = () => onAction(btn.dataset.act, btn.dataset.id);
      });
    }

    async function onAction(act, id) {
      const item = data.items.find(i => i.id === id);
      if (act === 'weigh') {
        const weight = prompt('本次重量（kg）');
        if (weight === null || isNaN(Number(weight))) return;
        const moisture = prompt('本次含水率（%），达标线为低于 12');
        if (moisture === null || isNaN(Number(moisture))) return;
        const by = prompt('称重人', item.turner || '');
        if (by === null) return;
        const at = prompt('称重时刻（默认现在）', localNow());
        if (at === null) return;
        await act('/api/items/' + encodeURIComponent(id) + '/weighings', 'POST', { weight: Number(weight), moisture: Number(moisture), by, at });
      } else if (act === 'turn') {
        const by = prompt('本次翻帘人', item.turner || '');
        if (by === null) return;
        const note = prompt('翻帘备注（可留空）', '') || '';
        await act('/api/items/' + encodeURIComponent(id) + '/turns', 'POST', { by, note });
      } else if (act === 'weightIn') {
        const value = prompt('更正确认：新的入晒重量（kg）。原重量 ' + item.weightIn + 'kg；若本批已放行，放行将作废并留履历。', item.weightIn);
        if (value === null || isNaN(Number(value))) return;
        const by = prompt('更正操作人');
        if (by === null) return;
        await act('/api/items/' + encodeURIComponent(id) + '/weight-correction', 'POST', { weightIn: Number(value), by });
      } else if (act === 'move') {
        const free = data.slots.filter(s => s.free);
        if (!free.length) return alert('没有空竹帘位可挪');
        const target = prompt('挪到哪个空竹帘位？可选：' + free.map(s => s.slot).join('、') + '。若本批已放行，放行将作废并留履历。');
        if (!target) return;
        if (!free.some(s => s.slot === target)) return alert('该竹帘位不是空位，不能挪入');
        const by = prompt('挪位操作人');
        if (by === null) return;
        await act('/api/items/' + encodeURIComponent(id) + '/move', 'POST', { slot: target, by });
      } else if (act === 'pack') {
        const by = prompt('打包收帘操作人');
        if (by === null) return;
        await act('/api/items/' + encodeURIComponent(id) + '/pack', 'POST', { by });
      }
    }

    function render() { renderSlots(); renderStats(); renderCards(); }
    async function load() { data = await api('/api/overview'); render(); }

    createForm.onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(createForm).entries());
      try {
        await api('/api/items', { method: 'POST', body: JSON.stringify({ code: f.code, weightIn: Number(f.weightIn), slot: f.slot, turner: f.turner, startedAt: f.startedAt }) });
        createForm.reset();
        document.querySelector('#startTime').value = '';
        await load();
      } catch (err) { alert(err.message); }
    };
    document.querySelector('#addSlot').onclick = async () => {
      const name = prompt('新竹帘位名称（如 戊字一帘）');
      if (!name) return;
      try { await api('/api/slots', { method: 'POST', body: JSON.stringify({ slot: name }) }); await load(); slotSelect.value = name; }
      catch (e) { alert(e.message); }
    };
    document.querySelector('#statusFilter').onchange = renderCards;
    document.querySelector('#search').oninput = renderCards;
    document.querySelector('#reload').onclick = load;
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

    if (req.method === "GET" && url.pathname === "/api/overview") return send(res, 200, overview(db));
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(i => itemView(db, i)));
    if (req.method === "GET" && url.pathname === "/api/slots") {
      const occupied = occupiedSlots(db);
      return send(res, 200, db.slots.map(slot => ({ slot, free: !occupied.has(slot) })));
    }

    if (req.method === "POST" && url.pathname === "/api/slots") {
      const input = await body(req);
      const name = String(input.slot || "").trim();
      if (!name) return err(res, 400, "slot_required", "请填写竹帘位名称");
      if (db.slots.includes(name)) return err(res, 409, "slot_exists", "该竹帘位已存在");
      db.slots.push(name);
      await saveDb(db);
      return send(res, 201, { slot: name, free: true });
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const slot = String(input.slot || "").trim();
      const turner = String(input.turner || "").trim();
      const weightIn = num(input.weightIn);
      if (!slot) return err(res, 400, "slot_required", "请选择竹帘位");
      if (!db.slots.includes(slot)) return err(res, 400, "slot_unknown", "竹帘位不存在：" + slot);
      if (occupiedSlots(db).has(slot)) return err(res, 409, "slot_occupied", "竹帘位「" + slot + "」上还有未收帘的批次，不能再排下一批");
      if (!turner) return err(res, 400, "turner_required", "请填写翻帘人");
      if (!Number.isFinite(weightIn) || weightIn <= 0) return err(res, 400, "weight_required", "请填写正确的入晒重量");

      const code = String(input.code || "").trim();
      if (code && db.items.some(i => i.code === code)) return err(res, 409, "code_exists", "批次编号已存在：" + code);

      const t = parseAt(input.startedAt);
      if (input.startedAt && !t) return err(res, 400, "bad_time", "开始时刻格式不正确");
      const startedAt = (t || new Date()).toISOString();

      db.seq = (db.seq || 1000) + 1;
      const item = {
        id: "LS-" + db.seq,
        code: code || "LS-" + new Date(startedAt).toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(db.items.length + 1).padStart(2, "0"),
        weightIn,
        slot,
        turner,
        startedAt,
        status: STATUS.DRYING,
        round: 1,
        releasedAt: null,
        releasedBy: null,
        packedAt: null,
        weights: [],
        turns: [],
        history: [{ at: startedAt, type: "入晒", note: "入晒 " + weightIn + "kg，排位 " + slot + "，翻帘人 " + turner }]
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, itemView(db, item));
    }

    const weigh = url.pathname.match(/^\/api\/items\/([^/]+)\/weighings$/);
    if (weigh && req.method === "POST") {
      const item = findItem(db, weigh[1]);
      if (!item) return err(res, 404, "item_not_found", "批次不存在");
      if (item.status === STATUS.PACKED) return err(res, 400, "already_packed", "该批次已收帘，不能再称重");
      if (item.status === STATUS.PACKABLE) return err(res, 409, "released", "该批次已放行打包；如确需复称，请先做重量更正或竹帘挪位作废放行");

      const input = await body(req);
      const weight = num(input.weight);
      const moisture = num(input.moisture);
      if (!Number.isFinite(weight) || weight <= 0) return err(res, 400, "weight_required", "请填写正确的称重重量");
      if (!Number.isFinite(moisture) || moisture < 0 || moisture > 100) return err(res, 400, "moisture_required", "请填写 0-100 之间的含水率");
      const t = parseAt(input.at);
      if (input.at && !t) return err(res, 400, "bad_time", "称重时刻格式不正确");
      const at = (t || new Date()).toISOString();

      const round = item.round || 1;
      const last = (item.weights || []).filter(w => (w.round || 1) === round).at(-1);
      if (last && new Date(at).getTime() < new Date(last.at).getTime()) {
        return err(res, 400, "time_order", "称重时刻不能早于上一次称重");
      }

      item.weights ||= [];
      item.weights.push({ at, weight, moisture, round, by: String(input.by || "").trim() });

      const before = item.status;
      const next = evaluateWeighings(item);
      item.status = next;
      item.history.push({
        at,
        type: "称重",
        note: "重量 " + weight + "kg，含水率 " + moisture + "%（第 " + (item.weights.filter(w => (w.round || 1) === round).length) + " 次）"
      });
      if (next === STATUS.PACKABLE) {
        item.releasedAt = at;
        item.releasedBy = String(input.by || "").trim();
        item.history.push({ at, type: "放行", note: "连续两次称重含水率均低于 " + MOISTURE_LIMIT + "% 且相隔满 6 小时，放行可打包" });
      } else if (before === STATUS.DRYING && next === STATUS.REWEIGH) {
        item.history.push({ at, type: "转待复称", note: "已完成第一次称重，等待 6 小时后复称" });
      }
      await saveDb(db);
      return send(res, 201, itemView(db, item));
    }

    const turn = url.pathname.match(/^\/api\/items\/([^/]+)\/turns$/);
    if (turn && req.method === "POST") {
      const item = findItem(db, turn[1]);
      if (!item) return err(res, 404, "item_not_found", "批次不存在");
      if (item.status === STATUS.PACKED) return err(res, 400, "already_packed", "该批次已收帘");
      const input = await body(req);
      const by = String(input.by || "").trim();
      if (!by) return err(res, 400, "turner_required", "请填写翻帘人");
      const at = nowIso();
      item.turns ||= [];
      item.turns.push({ at, by, note: String(input.note || "").trim() });
      item.history.push({ at, type: "翻帘", note: "翻帘人 " + by + (input.note ? "，" + input.note : "") });
      await saveDb(db);
      return send(res, 201, itemView(db, item));
    }

    const correct = url.pathname.match(/^\/api\/items\/([^/]+)\/weight-correction$/);
    if (correct && req.method === "POST") {
      const item = findItem(db, correct[1]);
      if (!item) return err(res, 404, "item_not_found", "批次不存在");
      if (item.status === STATUS.PACKED) return err(res, 400, "already_packed", "该批次已收帘，不能更正");
      const input = await body(req);
      const value = num(input.weightIn);
      if (!Number.isFinite(value) || value <= 0) return err(res, 400, "weight_required", "请填写正确的入晒重量");
      const by = String(input.by || "").trim();
      const old = item.weightIn;
      const wasReleased = item.status === STATUS.PACKABLE;
      invalidateRelease(db, item, "入晒重量由 " + old + "kg 更正为 " + value + "kg，原放行失效", by);
      item.weightIn = value;
      item.history.push({
        at: nowIso(),
        type: "重量更正",
        note: "入晒重量 " + old + "kg → " + value + "kg" + (wasReleased ? "，此前称重结果保留于履历，重新复称" : "") + (by ? "（操作人：" + by + "）" : "")
      });
      await saveDb(db);
      return send(res, 200, itemView(db, item));
    }

    const move = url.pathname.match(/^\/api\/items\/([^/]+)\/move$/);
    if (move && req.method === "POST") {
      const item = findItem(db, move[1]);
      if (!item) return err(res, 404, "item_not_found", "批次不存在");
      if (item.status === STATUS.PACKED) return err(res, 400, "already_packed", "该批次已收帘，不能挪位");
      const input = await body(req);
      const target = String(input.slot || "").trim();
      const by = String(input.by || "").trim();
      if (!db.slots.includes(target)) return err(res, 400, "slot_unknown", "竹帘位不存在：" + target);
      if (target === item.slot) return err(res, 400, "same_slot", "目标竹帘位与当前位置相同");
      if (occupiedSlots(db).has(target)) return err(res, 409, "slot_occupied", "竹帘位「" + target + "」上还有未收帘的批次，不能挪入");
      const oldSlot = item.slot;
      const wasReleased = item.status === STATUS.PACKABLE;
      invalidateRelease(db, item, "竹帘由 " + oldSlot + " 挪至 " + target + "，原放行失效", by);
      item.slot = target;
      item.history.push({
        at: nowIso(),
        type: "竹帘挪位",
        note: oldSlot + " → " + target + (wasReleased ? "，原放行作废，此前称重结果保留于履历，重新复称" : "") + (by ? "（操作人：" + by + "）" : "")
      });
      await saveDb(db);
      return send(res, 200, itemView(db, item));
    }

    const pack = url.pathname.match(/^\/api\/items\/([^/]+)\/pack$/);
    if (pack && req.method === "POST") {
      const item = findItem(db, pack[1]);
      if (!item) return err(res, 404, "item_not_found", "批次不存在");
      if (item.status !== STATUS.PACKABLE) return err(res, 409, "not_released", "含水率与间隔未达标或放行已作废，不能打包");
      const input = await body(req);
      const by = String(input.by || "").trim();
      const at = nowIso();
      item.status = STATUS.PACKED;
      item.packedAt = at;
      item.history.push({ at, type: "打包收帘", note: "凭有效放行打包，竹帘位「" + item.slot + "」释放为空位" + (by ? "（操作人：" + by + "）" : "") });
      await saveDb(db);
      return send(res, 200, itemView(db, item));
    }

    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, () => console.log("晾晒排位与打包放行台 listening on http://localhost:" + port));
