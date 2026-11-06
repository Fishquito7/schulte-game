'use strict';
/**
 * 舒尔特方格 · 排行榜后端
 * 零依赖：只用 Node 内置模块（node >= 18 即可跑）。
 *
 *   node server.js
 *   PORT=8090 HOST=127.0.0.1 ALLOW_ORIGIN=https://你的站点 node server.js
 *
 * 数据落在 data/scores.json（原子写入：先写 .tmp 再 rename）。
 *
 * 身份模型：昵称 + 9 位档案号（前 3 位数字 + 后 6 位字母数字）。
 *   档案号是唯一的「钥匙」，昵称只是显示名，允许重名。
 */

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const PORT         = Number(process.env.PORT || 8090);
const HOST         = process.env.HOST || '127.0.0.1';
const DATA_FILE    = process.env.DATA_FILE || path.join(__dirname, 'data', 'scores.json');
const STATIC_DIR   = process.env.STATIC_DIR || path.resolve(__dirname, '..');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

const MODES       = new Set(['square', 'radial', 'star']);
const SIZES       = [3, 4, 5, 6, 7, 8];
const MAX_BOARD   = 200;      // 每个榜单最多保留多少人
const MAX_BODY    = 4096;
const RATE_WINDOW = 60000;
const RATE_LIMIT  = 30;       // 每 IP 每窗口最多提交次数

const ID_HEAD = '0123456789';
const ID_BODY = '23456789ABCDEFGHJKMNPQRSTVWXYZ';   // 去掉 0/1/I/L/O/U，避免手输歧义

/* ------------------------------------------------------------------ 存储 */

let db = { players: {}, scores: [] };

(function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && j.players && Array.isArray(j.scores)) db = { players: j.players, scores: j.scores };
  } catch (e) {
    db = { players: {}, scores: [] };            // 文件不存在 / 旧格式 → 空库
  }
})();

let dirty = false, writing = false;

function markDirty() {
  dirty = true;
  if (!writing) flush();
}

function flush() {
  if (!dirty) return;
  dirty = false;
  writing = true;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 3, players: db.players, scores: db.scores }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[store] 写入失败:', e.message);
    dirty = true;
  }
  writing = false;
  if (dirty) setTimeout(flush, 500);
}

process.on('SIGINT',  () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

/* ------------------------------------------------------------------ 玩家 */

function newId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 3; i++) id += ID_HEAD[crypto.randomInt(ID_HEAD.length)];
    for (let i = 0; i < 6; i++) id += ID_BODY[crypto.randomInt(ID_BODY.length)];
  } while (db.players[id]);
  return id;
}

function cleanName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f]/g, '')
    .trim()
    .slice(0, 12);
}

const isId = v => /^[0-9]{3}[A-Z0-9]{6}$/.test(String(v || '').toUpperCase());

function touch(id) {
  if (db.players[id]) db.players[id].last_seen = new Date().toISOString();
}

/* ------------------------------------------------------------------ 榜单 */

const boardOf = (mode, size, rev) =>
  db.scores.filter(r => r.mode === mode && r.size === size && r.rev === rev)
           .sort((a, b) => a.t - b.t);

function trimBoard(mode, size, rev) {
  const board = boardOf(mode, size, rev);
  if (board.length <= MAX_BOARD) return;
  const drop = new Set(board.slice(MAX_BOARD).map(r => r.id));
  db.scores = db.scores.filter(r => !drop.has(r.id));
}

/* ------------------------------------------------------------------ 工具 */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.until) { h = { n: 0, until: now + RATE_WINDOW }; hits.set(ip, h); }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > RATE_LIMIT;
}

const ipOf = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '-';

/* ------------------------------------------------------------------ 路由 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(STATIC_DIR, rel));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/api/health') {
    return send(res, 200, { ok: true, players: Object.keys(db.players).length, scores: db.scores.length });
  }

  /* ---- 建档 ---- */
  if (p === '/api/register' && req.method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'too many requests' });
    try {
      const d = JSON.parse((await readBody(req, MAX_BODY)) || '{}');
      const name = cleanName(d.name);
      if (!name) return send(res, 400, { error: 'name required' });

      const id = newId();
      db.players[id] = { name, created_at: new Date().toISOString(), last_seen: new Date().toISOString() };
      markDirty();
      return send(res, 201, { id, name });
    } catch (e) {
      return send(res, 400, { error: 'bad request' });
    }
  }

  /* ---- 登录（用档案号换昵称） ---- */
  if (p === '/api/login' && req.method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'too many requests' });
    try {
      const d = JSON.parse((await readBody(req, MAX_BODY)) || '{}');
      const id = String(d.id || '').toUpperCase();
      if (!isId(id)) return send(res, 400, { error: 'invalid id' });
      const pl = db.players[id];
      if (!pl) return send(res, 404, { error: 'not found' });
      touch(id); markDirty();
      return send(res, 200, { id, name: pl.name });
    } catch (e) {
      return send(res, 400, { error: 'bad request' });
    }
  }

  /* ---- 改昵称 ---- */
  if (p === '/api/player' && req.method === 'PATCH') {
    try {
      const d = JSON.parse((await readBody(req, MAX_BODY)) || '{}');
      const id = String(d.id || '').toUpperCase();
      if (!isId(id) || !db.players[id]) return send(res, 404, { error: 'not found' });
      const name = cleanName(d.name);
      if (!name) return send(res, 400, { error: 'name required' });
      db.players[id].name = name;
      touch(id); markDirty();
      return send(res, 200, { id, name });
    } catch (e) {
      return send(res, 400, { error: 'bad request' });
    }
  }

  /* ---- 榜单 ---- */
  if (p === '/api/scores' && req.method === 'GET') {
    const mode = url.searchParams.get('mode') || '';
    const size = Number(url.searchParams.get('size'));
    const rev  = ['1', 'true'].includes(url.searchParams.get('rev') || '');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    if (!MODES.has(mode) || !SIZES.includes(size)) return send(res, 400, { error: 'bad mode/size' });

    const items = boardOf(mode, size, rev).slice(0, limit).map(r => ({
      id: r.id,
      name: (db.players[r.id] && db.players[r.id].name) || '匿名',
      t: r.t, s: r.s, created_at: r.at
    }));
    return send(res, 200, { items });
  }

  /* ---- 提交成绩 ---- */
  if (p === '/api/scores' && req.method === 'POST') {
    if (rateLimited(ipOf(req))) return send(res, 429, { error: 'too many requests' });
    try {
      const d = JSON.parse((await readBody(req, MAX_BODY)) || '{}');
      const id = String(d.id || '').toUpperCase();
      if (!db.players[id]) return send(res, 401, { error: 'unknown id' });

      const mode = String(d.mode || '');
      if (!MODES.has(mode)) return send(res, 400, { error: 'invalid mode' });
      const size = Number(d.size);
      if (!SIZES.includes(size)) return send(res, 400, { error: 'invalid size' });
      const rev = d.rev === true || d.rev === 1 || d.rev === '1' || d.rev === 'true';
      const t = Number(d.t);
      if (!Number.isFinite(t) || t < 2 || t > 900) return send(res, 400, { error: 'invalid score' });
      const s = Math.round(Number(d.s));
      if (!Number.isFinite(s) || s < 0 || s > 150) return send(res, 400, { error: 'invalid score' });

      const idx = db.scores.findIndex(r => r.id === id && r.mode === mode && r.size === size && r.rev === rev);
      let improved = false;
      if (idx === -1) {
        db.scores.push({ id, mode, size, rev, t: Math.round(t * 100) / 100, s, at: new Date().toISOString() });
        improved = true;
      } else if (t < db.scores[idx].t) {
        Object.assign(db.scores[idx], { t: Math.round(t * 100) / 100, s, at: new Date().toISOString() });
        improved = true;
      }

      touch(id);
      trimBoard(mode, size, rev);
      markDirty();

      const board = boardOf(mode, size, rev);
      const rank = board.findIndex(r => r.id === id) + 1;
      const mine = board.find(r => r.id === id);
      return send(res, 201, { ok: true, rank, improved, best: mine ? mine.t : null });
    } catch (e) {
      return send(res, 400, { error: 'bad request' });
    }
  }

  if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, p);
});

server.listen(PORT, HOST, () => {
  console.log(`舒尔特方格后端已启动: http://${HOST}:${PORT}`);
  console.log(`  静态目录: ${STATIC_DIR}`);
  console.log(`  数据文件: ${DATA_FILE}  (${Object.keys(db.players).length} 位玩家 / ${db.scores.length} 条成绩)`);
  console.log(`  允许来源: ${ALLOW_ORIGIN}`);
});
