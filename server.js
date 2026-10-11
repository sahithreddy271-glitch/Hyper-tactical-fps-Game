'use strict';
/* Tactical FPS Arena 3D multiplayer server.
 * Public matchmaking: 10v10 team battle (20 players).
 * Private rooms: 1v1 remains available for friends.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 80;
const PRIVATE_KILL_LIMIT = parseInt(process.env.KILL_LIMIT, 10) || 10;
const TEAM_KILL_LIMIT = parseInt(process.env.TEAM_KILL_LIMIT, 10) || 50;
const TEAM_SIZE = 10;
const TEAM_MATCH_SIZE = TEAM_SIZE * 2;
const READY_TIMEOUT_MS = 60000;
const MAPS = ['neon', 'desert', 'arctic', 'nostalgia', 'jungle', 'classicfps', 'luxury', 'skatepark', 'spaceship', 'adrenaline'];
const OPERATORS = ['assault', 'medic', 'recon'];
const ABILITIES = ['overdrive', 'medkit', 'barrier'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/multiplayer.js': 'multiplayer.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const teamQueue = [];
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const file = STATIC[url];
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (match, obj, except = null) => match.players.forEach(p => { if (p !== except) send(p, obj); });
const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const vec3 = a => Array.isArray(a) ? [num(a[0], -500, 500), num(a[1], -100, 200), num(a[2], -500, 500)] : [0, 0, 0];
const randomMap = () => MAPS[Math.floor(Math.random() * MAPS.length)];
function profile(m) {
  return { name: String(m.name || 'Player').slice(0, 20) || 'Player', op: OPERATORS.includes(m.op) ? m.op : 'assault',
    ab: ABILITIES.includes(m.ab) ? m.ab : 'overdrive', w: Math.floor(num(m.w, 0, 99, 0)) };
}
function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let code = ''; for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}
function leaveLobby(ws) {
  const i = teamQueue.indexOf(ws); if (i !== -1) teamQueue.splice(i, 1);
  if (ws.room) { const r = rooms.get(ws.room); if (r && r.host === ws) rooms.delete(ws.room); ws.room = null; }
}
function teamOf(match, idx) { return match.teamMode ? match.teams[idx] : idx; }
function endMatch(match, winner, reason) {
  if (match.over) return;
  match.over = true; clearTimeout(match.timer);
  broadcast(match, { t: 'end', winner, reason, kills: match.kills, teamMode: match.teamMode });
}
function leaveMatch(ws) {
  const match = ws.match; if (!match) return;
  ws.match = null;
  if (!match.over) {
    const winner = match.teamMode ? 1 - teamOf(match, ws.idx) : (match.players.length === 2 ? 1 - ws.idx : -1);
    endMatch(match, winner, 'left');
  }
}
function startMatch(players, map, teamMode) {
  const teams = players.map((_, idx) => teamMode ? (idx < TEAM_SIZE ? 0 : 1) : idx);
  const match = { players, teams, teamMode, kills: [0, 0], ready: new Set(), started: false, over: false, map,
    limit: teamMode ? TEAM_KILL_LIMIT : PRIVATE_KILL_LIMIT, timer: null };
  players.forEach((ws, idx) => { ws.match = match; ws.idx = idx; ws.team = teams[idx]; ws.lastDeath = 0; ws.lastState = 0; ws.lastAttacker = -1; });
  players.forEach((ws, idx) => {
    const roster = players.map((p, i) => ({ id: i, team: teams[i], prof: p.prof || { name: 'Player', op: 'assault', w: 0 } }));
    send(ws, { t: 'start', map, you: idx, team: teams[idx], teamMode, limit: match.limit, roster });
  });
  match.timer = setTimeout(() => { if (!match.started) endMatch(match, -1, 'timeout'); }, READY_TIMEOUT_MS);
}
function cleanQueue() {
  for (let i = teamQueue.length - 1; i >= 0; i--) if (teamQueue[i].readyState !== 1 || teamQueue[i].match) teamQueue.splice(i, 1);
}
function makeTeamMatch() {
  cleanQueue();
  while (teamQueue.length >= TEAM_MATCH_SIZE) {
    const players = teamQueue.splice(0, TEAM_MATCH_SIZE);
    startMatch(players, randomMap(), true);
  }
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.match = null; ws.idx = -1; ws.team = -1; ws.room = null; ws.prof = null; ws.lastDeath = 0; ws.lastState = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    const match = ws.match;
    switch (m.t) {
      case 'team': {
        if (match && !match.over) return;
        leaveMatch(ws); leaveLobby(ws); ws.prof = profile(m); teamQueue.push(ws);
        send(ws, { t: 'waiting', mode: 'teams', queued: teamQueue.length, needed: TEAM_MATCH_SIZE });
        makeTeamMatch();
        // Refresh queue position for people still waiting.
        teamQueue.forEach((p, i) => send(p, { t: 'waiting', mode: 'teams', queued: i + 1, needed: TEAM_MATCH_SIZE }));
        break;
      }
      case 'create': {
        if (match && !match.over) return;
        leaveMatch(ws); leaveLobby(ws); ws.prof = profile(m);
        const code = newCode(); if (!code) return send(ws, { t: 'err', msg: 'SERVER BUSY, TRY AGAIN' });
        const map = MAPS.includes(m.map) ? m.map : randomMap(); rooms.set(code, { host: ws, map }); ws.room = code;
        send(ws, { t: 'created', code, map }); break;
      }
      case 'join': {
        if (match && !match.over) return;
        leaveMatch(ws); leaveLobby(ws); ws.prof = profile(m);
        const code = String(m.code || '').trim().toUpperCase(); const room = rooms.get(code);
        if (!room || room.host.readyState !== 1 || room.host === ws) return send(ws, { t: 'err', msg: 'ROOM NOT FOUND' });
        rooms.delete(code); room.host.room = null; startMatch([room.host, ws], room.map, false); break;
      }
      case 'cancel': leaveLobby(ws); break;
      case 'leave': leaveLobby(ws); leaveMatch(ws); break;
      case 'ready': {
        if (!match || match.over || match.started) return;
        match.ready.add(ws.idx);
        if (match.ready.size === match.players.length) { match.started = true; clearTimeout(match.timer); broadcast(match, { t: 'go' }); }
        break;
      }
      case 's': {
        if (!match || !match.started || match.over) return;
        const now = Date.now(); if (now - ws.lastState < 20) return; ws.lastState = now;
        broadcast(match, { t: 's', from: ws.idx, x: num(m.x, -200, 200), y: num(m.y, -50, 100), z: num(m.z, -200, 200),
          yaw: num(m.yaw, -100, 100), pitch: num(m.pitch, -3, 3), hp: num(m.hp, 0, 100), al: m.al ? 1 : 0 }, ws);
        break;
      }
      case 'f': {
        if (!match || !match.started || match.over) return;
        broadcast(match, { t: 'f', from: ws.idx, o: vec3(m.o), d: vec3(m.d), w: Math.floor(num(m.w, 0, 99, 0)) }, ws);
        break;
      }
      case 'h': {
        if (!match || !match.started || match.over) return;
        const targetIdx = Math.floor(num(m.target, -1, match.players.length - 1, -1));
        const target = match.players[targetIdx]; const dmg = num(m.dmg, 0, 400);
        if (!target || target === ws || dmg <= 0 || (match.teamMode && teamOf(match, targetIdx) === teamOf(match, ws.idx))) return;
        target.lastAttacker = ws.idx;
        send(target, { t: 'h', from: ws.idx, dmg, head: !!m.head });
        break;
      }
      case 'd': {
        if (!match || !match.started || match.over) return;
        const now = Date.now(); if (now - ws.lastDeath < 1500) return; ws.lastDeath = now;
        const killerIdx = ws.lastAttacker;
        ws.lastAttacker = -1;
        const killer = match.players[killerIdx];
        if (killer && killer !== ws && (!match.teamMode || teamOf(match, killerIdx) !== teamOf(match, ws.idx))) {
          const scoreTeam = teamOf(match, killerIdx); match.kills[scoreTeam]++;
          broadcast(match, { t: 'k', kills: match.kills, killer: killerIdx, killerTeam: scoreTeam, victim: ws.idx, teamMode: match.teamMode });
          if (match.kills[scoreTeam] >= match.limit) endMatch(match, scoreTeam, 'limit');
        }
        break;
      }
    }
  });
  ws.on('close', () => { leaveLobby(ws); leaveMatch(ws); });
  ws.on('error', () => {});
});
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (_) {} }); }, 25000);
server.listen(PORT, () => console.log(`Tactical FPS server listening on port ${PORT}; public mode ${TEAM_MATCH_SIZE}-player 10v10`));
