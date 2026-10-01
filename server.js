#!/usr/bin/env node
/*
 * Сервер общего доступа для планировщика рейсов.
 * Без внешних зависимостей: нужен только Node.js 18+.
 *
 *   node server.js                     → http://localhost:8080
 *
 * Переменные окружения:
 *   PORT       — порт (по умолчанию 8080)
 *   HOST       — адрес (по умолчанию 0.0.0.0 — все интерфейсы)
 *   DATA_DIR   — папка для данных (по умолчанию ./data)
 *   AUTH_USER, AUTH_PASS — если заданы, вход по логину и паролю (HTTP Basic)
 *
 * Данные хранятся в DATA_DIR/state.json, резервные копии — в DATA_DIR/backups
 * (не чаще раза в час, хранятся последние 200).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const INDEX_FILE = path.join(__dirname, 'index.html');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const MAX_BODY = 20 * 1024 * 1024;
const BACKUP_EVERY = 60 * 60 * 1000;
const BACKUP_KEEP = 200;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// rev — номер версии общих данных; растёт при каждом сохранении
let store = { rev: 0, updatedAt: null, data: null };
try {
  store = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`Не удалось прочитать ${STATE_FILE}: ${e.message}`);
    process.exit(1);
  }
}

let lastBackup = 0;
function backupCurrent() {
  if (!fs.existsSync(STATE_FILE) || Date.now() - lastBackup < BACKUP_EVERY) return;
  lastBackup = Date.now();
  const name = `state-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.copyFileSync(STATE_FILE, path.join(BACKUP_DIR, name));
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('state-')).sort();
  files.slice(0, Math.max(0, files.length - BACKUP_KEEP)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}
function persist() {
  backupCurrent();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STATE_FILE); // атомарная замена — файл не повредится при сбое во время записи
}

// Подписчики на изменения (Server-Sent Events)
const clients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
const presence = () => broadcast('presence', { online: clients.size });
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authorized(req) {
  if (!AUTH_USER && !AUTH_PASS) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const okUser = safeEqual(u, AUTH_USER), okPass = safeEqual(rest.join(':'), AUTH_PASS); // обе проверки всегда
  return okUser && okPass;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Слишком большой запрос'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function validData(d) {
  return d && typeof d === 'object' && ['ports', 'legs', 'ships', 'voyages'].every(k => Array.isArray(d[k]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Voyage planner", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Требуется вход');
    return;
  }

  try {
    if (p.endsWith('/api/state') && req.method === 'GET') return sendJson(res, 200, store);
    if (p.endsWith('/api/rev') && req.method === 'GET') return sendJson(res, 200, { rev: store.rev, updatedAt: store.updatedAt });

    if (p.endsWith('/api/state') && req.method === 'PUT') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? e.message : 'Неверный JSON' }); }
      if (!validData(body.data)) return sendJson(res, 400, { error: 'Неверный формат данных' });
      // Оптимистическая блокировка: сохраняем, только если клиент видел последнюю версию.
      // Иначе возвращаем 409 с актуальными данными — клиент объединит изменения и повторит.
      if (body.baseRev !== store.rev) return sendJson(res, 409, store);
      store = { rev: store.rev + 1, updatedAt: new Date().toISOString(), data: body.data };
      persist();
      broadcast('rev', { rev: store.rev, client: body.client || null });
      return sendJson(res, 200, { rev: store.rev, updatedAt: store.updatedAt });
    }

    if (p.endsWith('/api/events') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: rev\ndata: ${JSON.stringify({ rev: store.rev })}\n\n`);
      clients.add(res);
      presence();
      req.on('close', () => { clients.delete(res); presence(); });
      return;
    }

    // Страница приложения (в т.ч. при размещении во вложенной папке за прокси)
    if (req.method === 'GET' && !p.includes('/api/') && ['', '.html'].includes(path.extname(p))) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Планировщик рейсов: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Данные: ${STATE_FILE}${AUTH_USER || AUTH_PASS ? ' · вход по паролю включён' : ''}`);
});
