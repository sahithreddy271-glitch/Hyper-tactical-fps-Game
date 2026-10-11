'use strict';
/*
 * Tactical FPS Arena - 1v1 matchmaking server
 * - Serves index.html and multiplayer.js over HTTP
 * - WebSocket on the same port: public queue, private rooms, relay of player state
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 80;
const KILL_LIMIT = parseInt(process.env.KILL_LIMIT, 10) || 10;
const READY_TIMEOUT_MS = 45000;
const MAPS = ['neon', 'desert', 'arctic', 'nostalgia', 'jungle', 'classicfps', 'luxury', 'skatepark', 'spaceship', 'adrenaline'];
const OPERATORS = ['assault', 'medic', 'recon'];
const ABILITIES = ['overdrive', 'medkit', 'barrier'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/multiplayer.js': 'multiplayer.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const queue = [];          // sockets waiting in the public queue
const rooms = new Map();   // private rooms: code -> { host, map }

/* ---------- HTTP (static files) ---------- */
const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    const file = STATIC[url];
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    fs.readFile(path.join(__dirname, file), (err, data) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

/* ---------- helpers ---------- */
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const vec3 = (a) => (Array.isArray(a) ? [num(a[0], -500, 500), num(a[1], -100, 200), num(a[2], -500, 500)] : [0, 0, 0]);
const randomMap = () => MAPS[Math.floor(Math.random() * MAPS.length)];

function profile(m) {
    return {
        name: String(m.name || 'Player').slice(0, 20) || 'Player',
        op: OPERATORS.includes(m.op) ? m.op : 'assault',
        ab: ABILITIES.includes(m.ab) ? m.ab : 'overdrive',
        w: Math.floor(num(m.w, 0, 99, 0))
    };
}

function newCode() {
    for (let tries = 0; tries < 50; tries++) {
        let code = '';
        for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        if (!rooms.has(code)) return code;
    }
    return null;
}

function leaveLobby(ws) {
    const i = queue.indexOf(ws);
    if (i !== -1) queue.splice(i, 1);
    if (ws.room) {
        const r = rooms.get(ws.room);
        if (r && r.host === ws) rooms.delete(ws.room);
        ws.room = null;
    }
}

function endMatch(match, winner, reason) {
    if (match.over) return;
    match.over = true;
    clearTimeout(match.timer);
    for (const p of match.players) send(p, { t: 'end', winner, reason, kills: match.kills });
}

function leaveMatch(ws) {
    const m = ws.match;
    if (!m) return;
    ws.match = null;
    if (!m.over) endMatch(m, 1 - ws.idx, 'left');
}

function startMatch(a, b, map) {
    const match = { players: [a, b], kills: [0, 0], ready: [false, false], started: false, over: false, map, timer: null };
    [a, b].forEach((ws, idx) => { ws.match = match; ws.idx = idx; ws.lastDeath = 0; });
    for (let idx = 0; idx < 2; idx++) {
        const me = match.players[idx], other = match.players[1 - idx];
        send(me, { t: 'start', map, you: idx, limit: KILL_LIMIT, opp: other.prof });
    }
    match.timer = setTimeout(() => { if (!match.started) endMatch(match, -1, 'timeout'); }, READY_TIMEOUT_MS);
}

/* ---------- WebSocket protocol ---------- */
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.match = null; ws.idx = 0; ws.room = null; ws.prof = null; ws.lastDeath = 0;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let m;
        try { m = JSON.parse(data.toString()); } catch (_) { return; }
        if (!m || typeof m.t !== 'string') return;
        const match = ws.match;

        switch (m.t) {
            case 'find': {
                if (match && !match.over) return;
                leaveMatch(ws); leaveLobby(ws);
                ws.prof = profile(m);
                while (queue.length && queue[0].readyState !== 1) queue.shift();
                if (queue.length) startMatch(queue.shift(), ws, randomMap());
                else { queue.push(ws); send(ws, { t: 'waiting' }); }
                break;
            }
            case 'create': {
                if (match && !match.over) return;
                leaveMatch(ws); leaveLobby(ws);
                ws.prof = profile(m);
                const code = newCode();
                if (!code) return send(ws, { t: 'err', msg: 'SERVER BUSY, TRY AGAIN' });
                const map = MAPS.includes(m.map) ? m.map : randomMap();
                rooms.set(code, { host: ws, map });
                ws.room = code;
                send(ws, { t: 'created', code, map });
                break;
            }
            case 'join': {
                if (match && !match.over) return;
                leaveMatch(ws); leaveLobby(ws);
                ws.prof = profile(m);
                const code = String(m.code || '').trim().toUpperCase();
                const room = rooms.get(code);
                if (!room || room.host.readyState !== 1 || room.host === ws) return send(ws, { t: 'err', msg: 'ROOM NOT FOUND' });
                rooms.delete(code);
                room.host.room = null;
                startMatch(room.host, ws, room.map);
                break;
            }
            case 'cancel': leaveLobby(ws); break;
            case 'leave': leaveLobby(ws); leaveMatch(ws); break;

            case 'ready': {
                if (!match || match.over || match.started) return;
                match.ready[ws.idx] = true;
                if (match.ready[0] && match.ready[1]) {
                    match.started = true;
                    clearTimeout(match.timer);
                    for (const p of match.players) send(p, { t: 'go' });
                }
                break;
            }
            case 's': {   // player state -> opponent
                if (!match || !match.started || match.over) return;
                send(match.players[1 - ws.idx], {
                    t: 's', x: num(m.x, -200, 200), y: num(m.y, -50, 100), z: num(m.z, -200, 200),
                    yaw: num(m.yaw, -100, 100), pitch: num(m.pitch, -3, 3), hp: num(m.hp, 0, 100), al: m.al ? 1 : 0
                });
                break;
            }
            case 'f': {   // shot fired (visual tracer + sound for the opponent)
                if (!match || !match.started || match.over) return;
                send(match.players[1 - ws.idx], { t: 'f', o: vec3(m.o), d: vec3(m.d), w: Math.floor(num(m.w, 0, 99, 0)) });
                break;
            }
            case 'h': {   // damage dealt to the opponent
                if (!match || !match.started || match.over) return;
                const dmg = num(m.dmg, 0, 400);
                if (dmg > 0) send(match.players[1 - ws.idx], { t: 'h', dmg, head: !!m.head });
                break;
            }
            case 'd': {   // I died -> opponent scores
                if (!match || !match.started || match.over) return;
                const now = Date.now();
                if (now - ws.lastDeath < 1500) return;
                ws.lastDeath = now;
                const killer = 1 - ws.idx;
                match.kills[killer]++;
                for (const p of match.players) send(p, { t: 'k', kills: match.kills, killer });
                if (match.kills[killer] >= KILL_LIMIT) endMatch(match, killer, 'limit');
                break;
            }
        }
    });

    ws.on('close', () => { leaveLobby(ws); leaveMatch(ws); });
    ws.on('error', () => {});
});

// drop dead connections
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, 25000);

server.listen(PORT, () => console.log('Tactical FPS server listening on port ' + PORT));
