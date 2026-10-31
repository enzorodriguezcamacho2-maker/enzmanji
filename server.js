/* ==========================================================================
   server.js — Servidor de salas de "Tablero Encantado" (sin dependencias)
   --------------------------------------------------------------------------
   Es un RELÉ: no conoce las reglas del juego. El motor sigue ejecutándose en
   la pantalla principal (la TV); este servidor solo
     · sirve el HTML,
     · crea salas con un código corto,
     · reenvía las acciones de cada móvil a la TV y espera su respuesta,
     · reenvía a cada móvil SU vista del estado (la TV ya oculta los secretos),
     · detecta desconexiones.
   Protocolo: HTTP + Server-Sent Events (nada que instalar).
   Seguridad: no hay claves privadas. Cada sala tiene un token de anfitrión
   aleatorio y cada móvil un secreto aleatorio; el servidor fuerza qué jugador
   actúa en cada petición y solo deja pasar una lista cerrada de acciones.
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = __dirname;                // versión plana: index.html está junto a server.js
const MAX_BODY = 1024 * 1024;            // los dibujos y el chat con 8 móviles son lo más grande
const MAX_ROOMS = 20;
const ROOM_TTL = 6 * 3600 * 1000;        // sala inactiva > 6 h se borra
const RPC_TIMEOUT = 6000;
const OFFLINE_GRACE = 6000;              // un móvil sin stream durante 6 s cuenta como desconectado
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O (se confunden con 1 y 0)
// Misma lista que el juego (index.html): chat, votaciones, jungla, impostor, reacciones… (el motor de la TV valida cada acción)
const PHONE_ACTIONS = new Set(['roll', 'answer', 'pass', 'useItem', 'spin', 'useShield', 'declineShield', 'shopDone', 'playCard', 'submitMemory', 'guess', 'drawUpdate', 'drawFinish', 'rename', 'jBet', 'jFlash', 'jEvent', 'jReact', 'jGift', 'impTrap', 'impHelp', 'impVote', 'impBoost', 'sVote', 'qAdd', 'qDel', 'fb', 'survey', 'chat', 'buy']);

const rooms = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');

function newCode() {
  for (let k = 0; k < 200; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function lanUrls() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(list => (list || []).forEach(i => {
    if (i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + PORT);
  }));
  return out;
}

/* ------------------------------ utilidades HTTP ------------------------------ */
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sseOpen(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\n');
}
const sseSend = (res, event, data) => { try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* conexión cerrada */ } };
const safeEq = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b); };

/* ------------------------------ salas ------------------------------ */
function hostAuth(q) { const r = rooms.get(String(q.get('code') || '').toUpperCase()); return r && safeEq(q.get('token'), r.hostToken) ? r : null; }
function toHost(room, event, data) { if (room.hostRes) sseSend(room.hostRes, event, data); }

function rpc(room, payload) {              // pregunta a la TV y espera su respuesta
  return new Promise(resolve => {
    if (!room.hostRes) return resolve({ ok: false, error: 'La pantalla principal está desconectada.' });
    const reqId = rid(6);
    const timer = setTimeout(() => { room.pending.delete(reqId); resolve({ ok: false, error: 'La pantalla principal no responde.' }); }, RPC_TIMEOUT);
    room.pending.set(reqId, r => { clearTimeout(timer); resolve(r); });
    toHost(room, 'rpc', Object.assign({ reqId }, payload));
  });
}
function setPresence(room, c, online) {
  if (c.online === online) return;
  c.online = online;
  toHost(room, 'presence', { clientId: c.clientId, pid: c.pid, online });
}
function closeRoom(room, why) {
  rooms.forEach((r, k) => { if (r === room) rooms.delete(k); });
  room.phones.forEach(c => { if (c.res) { sseSend(c.res, 'closed', { why: why || 'La sala se ha cerrado.' }); c.res.end(); } clearTimeout(c.offTimer); });
  if (room.hostRes) { try { room.hostRes.end(); } catch (e) { /* ya cerrada */ } }
}
setInterval(() => { const t = Date.now(); rooms.forEach(r => { if (t - r.lastActive > ROOM_TTL) closeRoom(r, 'Sala caducada por inactividad.'); }); }, 60000).unref();
setInterval(() => { rooms.forEach(r => { if (r.hostRes) r.hostRes.write(': hb\n\n'); r.phones.forEach(c => { if (c.res) c.res.write(': hb\n\n'); }); }); }, 15000).unref();

/* ------------------------------ rutas ------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, q = url.searchParams, m = req.method;

  /* ---------- API ---------- */
  if (p === '/api/info' && m === 'GET') return json(res, 200, { ok: true, urls: lanUrls(), port: PORT, rooms: rooms.size });

  if (p === '/api/room' && m === 'POST') {             // la TV crea una sala
    if (rooms.size >= MAX_ROOMS) return json(res, 429, { ok: false, error: 'Demasiadas salas abiertas.' });
    const code = newCode(); if (!code) return json(res, 500, { ok: false, error: 'No se pudo crear la sala.' });
    const room = { code, hostToken: rid(16), hostRes: null, phones: new Map(), pid2client: new Map(), pending: new Map(), lastViews: {}, createdAt: Date.now(), lastActive: Date.now() };
    rooms.set(code, room);
    return json(res, 200, { ok: true, code, token: room.hostToken });
  }

  if (p === '/api/host/stream' && m === 'GET') {        // canal TV ← servidor
    const room = hostAuth(q); if (!room) return json(res, 403, { ok: false, error: 'Sala o token no válidos.' });
    if (room.hostRes) { try { room.hostRes.end(); } catch (e) { /* ya cerrada */ } }
    sseOpen(res); room.hostRes = res; room.lastActive = Date.now();
    sseSend(res, 'ready', { code: room.code, phones: [...room.phones.values()].map(c => ({ clientId: c.clientId, pid: c.pid, name: c.name, online: !!c.online })) });
    room.phones.forEach(c => { if (c.res) sseSend(c.res, 'status', { hostOnline: true }); });
    req.on('close', () => { if (room.hostRes === res) { room.hostRes = null; room.phones.forEach(c => { if (c.res) sseSend(c.res, 'status', { hostOnline: false }); }); } });
    return;
  }

  if (p === '/api/host/reply' && m === 'POST') {        // la TV responde a una pregunta
    const room = hostAuth(q); if (!room) return json(res, 403, { ok: false });
    const b = await readBody(req); const f = room.pending.get(b.reqId);
    if (f) { room.pending.delete(b.reqId); f(b.result || { ok: false, error: 'Sin respuesta.' }); }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/host/push' && m === 'POST') {         // la TV publica vistas por jugador
    const room = hostAuth(q); if (!room) return json(res, 403, { ok: false });
    const b = await readBody(req); room.lastActive = Date.now();
    Object.keys(b.views || {}).forEach(pid => {
      room.lastViews[pid] = b.views[pid];
      const c = room.pid2client.get(pid);
      if (c && c.res) sseSend(c.res, 'view', b.views[pid]);
    });
    (b.kicked || []).forEach(pid => {
      const c = room.pid2client.get(pid); if (!c) return;
      if (c.res) sseSend(c.res, 'kicked', { why: 'La pantalla principal te ha quitado de la partida.' });
      room.pid2client.delete(pid); room.phones.delete(c.clientId); delete room.lastViews[pid];
    });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/host/close' && m === 'POST') {
    const room = hostAuth(q); if (!room) return json(res, 403, { ok: false });
    closeRoom(room, 'La sala se ha cerrado.'); return json(res, 200, { ok: true });
  }

  if (p === '/api/join' && m === 'POST') {              // un móvil entra con el código
    const b = await readBody(req);
    const room = rooms.get(String(b.code || '').trim().toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'No existe ninguna sala con ese código.' });
    room.lastActive = Date.now();
    const known = b.clientId && room.phones.get(String(b.clientId));
    if (known && safeEq(b.secret, known.secret)) {      // reconexión
      return json(res, 200, { ok: true, pid: known.pid, clientId: known.clientId, secret: known.secret, reconnect: true });
    }
    const name = String(b.name || '').trim().slice(0, 14);
    if (!name) return json(res, 400, { ok: false, error: 'Escribe tu nombre.' });
    const clientId = rid(6), secret = rid(16);
    const r = await rpc(room, { kind: 'join', clientId, name });
    if (!r || !r.ok) return json(res, 409, { ok: false, error: (r && r.error) || 'No se pudo entrar.' });
    const c = { clientId, secret, pid: r.pid, name, res: null, online: false, offTimer: null };
    room.phones.set(clientId, c); room.pid2client.set(r.pid, c);
    return json(res, 200, { ok: true, pid: r.pid, clientId, secret });
  }

  if (p === '/api/play/stream' && m === 'GET') {        // canal móvil ← servidor
    const room = rooms.get(String(q.get('code') || '').toUpperCase());
    const c = room && room.phones.get(String(q.get('clientId') || ''));
    if (!c || !safeEq(q.get('secret'), c.secret)) return json(res, 403, { ok: false, error: 'Sesión no válida. Vuelve a entrar.' });
    if (c.res) { try { c.res.end(); } catch (e) { /* ya cerrada */ } }
    sseOpen(res); c.res = res; clearTimeout(c.offTimer); setPresence(room, c, true);
    sseSend(res, 'status', { hostOnline: !!room.hostRes });
    if (room.lastViews[c.pid]) sseSend(res, 'view', room.lastViews[c.pid]);
    req.on('close', () => {
      if (c.res !== res) return; c.res = null;
      c.offTimer = setTimeout(() => setPresence(room, c, false), OFFLINE_GRACE);
    });
    return;
  }

  if (p === '/api/play/action' && m === 'POST') {       // un móvil actúa (siempre como SU jugador)
    const b = await readBody(req);
    const room = rooms.get(String(b.code || '').toUpperCase());
    const c = room && room.phones.get(String(b.clientId || ''));
    if (!c || !safeEq(b.secret, c.secret)) return json(res, 403, { ok: false, error: 'Sesión no válida. Vuelve a entrar.' });
    const a = b.action;
    if (!a || typeof a.type !== 'string' || !PHONE_ACTIONS.has(a.type)) return json(res, 400, { ok: false, error: 'Acción no permitida.' });
    room.lastActive = Date.now();
    if (a.type === 'drawUpdate') {                       // se dispara a menudo: sin esperar respuesta
      toHost(room, 'rpc', { reqId: '-', kind: 'action', pid: c.pid, action: a }); return json(res, 200, { ok: true });
    }
    return json(res, 200, await rpc(room, { kind: 'action', pid: c.pid, action: a }));
  }

  /* ---------- estáticos ---------- */
  if (m !== 'GET') return json(res, 405, { ok: false });
  if (p !== '/' && p !== '/play' && p !== '/index.html') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
  let file = '/index.html';
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC + path.sep) && full !== PUBLIC) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { if (!res.headersSent) json(res, 400, { ok: false, error: 'Petición no válida.' }); else res.end(); });
});
server.requestTimeout = 0;                 // los streams SSE son largos

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Tablero Encantado · servidor de salas\n');
    console.log('  En ESTE ordenador (la TV):   http://localhost:' + PORT);
    const l = lanUrls();
    if (l.length) console.log('  Los móviles (misma wifi):    ' + l.join('   ')); else console.log('  (No se detecta red local: conecta el ordenador a la wifi)');
    console.log('\n  Para parar: Ctrl+C\n');
  });
}
module.exports = { server, rooms, PORT };
