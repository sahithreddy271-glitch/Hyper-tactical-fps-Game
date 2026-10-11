/* =====================================================================
 *  Tactical FPS Arena 3D - 10v10 team battle + private rooms
 *  Loaded AFTER the main game script, so it shares the game's globals
 *  (state, player, scene, camera, WEAPONS, ...). Solo mode is untouched.
 * ===================================================================== */
(function () {
    'use strict';

    const SEND_MS = 50;          // network tick for player state
    const RESPAWN_MS = 3000;
    const PROTECT_MS = 2000;     // spawn protection

    const M = {
        mode: 'solo',            // solo | teams | create | join
        joinCode: '',
        ws: null,
        phase: 'idle',           // idle | connecting | waiting | found | playing | over
        inMatch: false,
        started: false,          // both players ready and countdown finished
        idx: 0, team: 0, teamMode: false, scoreIndex: 0, limit: 10, kills: [0, 0],
        opp: null, players: [], lastAttacker: -1,
        frozen: false, dead: false, respawnAt: 0, protectUntil: 0,
        pendingStart: null, lastSend: 0, lastHud: 0, tracers: []
    };

    /* ---------------------------------------------------------------
     *  UI
     * --------------------------------------------------------------- */
    const css = document.createElement('style');
    css.textContent = `
        #mp-mode, #mp-wait, #mp-result { position:absolute; inset:0; z-index:60; display:none; justify-content:center; align-items:center; background:rgba(6,8,13,.92); }
        .mp-card { width:440px; max-width:94vw; padding:30px 34px; text-align:center; border-radius:10px; }
        .mp-card .btn { margin-top:10px; }
        .mp-card .title { font-size:26px; }
        .mp-code { font:900 46px 'Orbitron',sans-serif; letter-spacing:10px; color:#00ff9d; margin:14px 0 4px; text-shadow:0 0 18px rgba(0,255,157,.45); }
        .mp-msg { color:#9eafc2; font-size:14px; letter-spacing:2px; margin:12px 0 6px; min-height:20px; }
        .mp-score { font:900 40px 'Orbitron',sans-serif; margin:10px 0 4px; color:#fff; }
        .mp-divider { height:1px; background:var(--line); margin:14px 0 4px; }
        #mp-hud { display:none; }
        body.mp-active #mp-hud { display:flex; }
        body.mp-active .hud-top:not(#mp-hud), body.mp-active #mission-panel { display:none !important; }
        #mp-hud .me b { color:var(--cyan); } #mp-hud .op b { color:var(--red); }
        #mp-hud .mid b { font-size:13px; color:#fff; letter-spacing:1px; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
        #mp-oppbar { display:none; position:absolute; top:84px; left:50%; transform:translateX(-50%); width:200px; height:6px; background:rgba(0,0,0,.55); border:1px solid #2a3442; }
        body.mp-active #mp-oppbar { display:block; }
        #mp-oppbar i { display:block; height:100%; width:100%; background:var(--red); box-shadow:0 0 8px var(--red); transition:width .1s linear; }
    `;
    document.head.appendChild(css);

    const make = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };

    const modeEl = make(`
        <div id="mp-mode"><div class="menu-card glass mp-card">
            <h1 class="title">SELECT MODE</h1>
            <div class="sub">CHOOSE HOW TO PLAY</div>
            <button class="btn green" data-mode="solo">SOLO &middot; WAVES VS BOTS</button>
            <div class="mp-divider"></div>
            <button class="btn green" data-mode="teams">10V10 &middot; TEAM BATTLE (20 PLAYERS)</button>
            <button class="btn" data-mode="create">PRIVATE ROOM &middot; CREATE 1V1</button>
            <input id="mp-code-input" class="input-field" placeholder="ROOM CODE" maxlength="4" style="text-transform:uppercase;text-align:center">
            <button class="btn" data-mode="join">PRIVATE ROOM &middot; JOIN WITH CODE</button>
            <div class="mp-msg" id="mp-mode-msg"></div>
            <button class="btn grey" data-mode="cancel">CANCEL</button>
        </div></div>`);

    const waitEl = make(`
        <div id="mp-wait"><div class="menu-card glass mp-card">
            <h1 class="title" id="mp-wait-title">MULTIPLAYER</h1>
            <div class="sub" id="mp-wait-sub"></div>
            <div class="mp-code" id="mp-wait-code" style="display:none"></div>
            <div class="mp-msg" id="mp-wait-msg"></div>
            <button class="btn green" id="mp-ready-btn" style="display:none">READY &mdash; FIGHT!</button>
            <button class="btn grey" id="mp-cancel-btn">CANCEL</button>
        </div></div>`);

    const resultEl = make(`
        <div id="mp-result"><div class="menu-card glass mp-card">
            <h1 class="title" id="mp-result-title">VICTORY</h1>
            <div class="sub" id="mp-result-sub"></div>
            <div class="mp-score" id="mp-result-score">0 - 0</div>
            <button class="btn" id="mp-result-btn">RETURN TO ARMORY</button>
        </div></div>`);

    const hudEl = make(`
        <div id="mp-hud" class="hud-top glass">
            <div class="me"><small>YOU</small><b id="mp-me">0</b></div>
            <div class="mid"><small id="mp-limit">FIRST TO 10</small><b id="mp-oppname">OPPONENT</b></div>
            <div class="op"><small>OPP</small><b id="mp-opp">0</b></div>
        </div>`);
    const oppBar = make('<div id="mp-oppbar"><i></i></div>');

    document.body.append(modeEl, waitEl, resultEl);
    $('hud').append(hudEl, oppBar);

    /* ---------- original function references ---------- */
    const _deploy = window.deployToCombat;
    const _showStep = window.showDeployStep;
    const _fire = window.fireShot;
    const _die = window.die;
    const _startWave = window.startWave;
    const _updateWaves = window.updateWaves;
    const _updatePlayer = window.updatePlayer;
    const _radar = window.drawRadar;
    const _pause = window.pauseGame;
    const _setWeapon = window.setWeapon;

    /* ---------- mode picker ---------- */
    function openModePicker() {
        $('mp-code-input').value = '';
        $('mp-mode-msg').textContent = '';
        modeEl.style.display = 'flex';
    }
    modeEl.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        if (mode === 'cancel') { modeEl.style.display = 'none'; return; }
        if (mode === 'join') {
            const code = $('mp-code-input').value.trim().toUpperCase();
            if (code.length !== 4) { $('mp-mode-msg').textContent = 'ENTER THE 4-CHARACTER ROOM CODE'; return; }
            M.joinCode = code;
        }
        M.mode = mode;
        modeEl.style.display = 'none';
        openDeploymentSelection();
    }));

    // replace the lobby DEPLOY button so it opens the mode picker first
    const oldBtn = $('deploy-btn');
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    newBtn.addEventListener('click', openModePicker);

    /* ---------- deployment flow tweaks ---------- */
    window.showDeployStep = function (step) {
        const multiplayer = M.mode !== 'solo';
        const skipMap = M.mode === 'teams' || M.mode === 'join';
        if (skipMap && step === 3) {              // map is random / chosen by the room host
            $('operator-select-overlay').style.display = 'none';
            window.deployToCombat();
            return;
        }
        _showStep(step);
        if (!multiplayer) return;
        const names = { teams: '10V10 TEAM BATTLE', create: 'PRIVATE 1V1', join: 'PRIVATE 1V1 JOIN' };
        const total = skipMap ? 2 : 3;
        $('deploy-step-label').textContent = 'DEPLOYMENT // ' + names[M.mode] + ' // STEP 0' + step + ' OF 0' + total;
        $('deploy-step-count').textContent = '0' + step + ' / 0' + total;
        if (skipMap && step === 2) {
            $('deploy-next-btn').textContent = M.mode === 'teams' ? '\u25B6  FIND 10V10 MATCH' : '\u25B6  JOIN ROOM';
            $('ability-help').textContent = M.mode === 'teams' ? '10v10 team battle; matchmaking starts when 20 players join.' : 'The room host picked the map.';
        }
        if (M.mode === 'create' && step === 3) $('deploy-next-btn').textContent = '\u25B6  CREATE ROOM';
    };

    window.deployToCombat = function () {
        if (M.mode === 'solo') return _deploy();
        startMatchmaking();
    };

    /* ---------- waiting overlay ---------- */
    function showWait(msg, o = {}) {
        $('mp-wait-title').textContent = o.title || (M.mode === 'teams' ? '10V10 TEAM BATTLE' : 'PRIVATE MATCH');
        $('mp-wait-sub').textContent = o.sub || '';
        const code = $('mp-wait-code');
        code.style.display = o.code ? 'block' : 'none';
        code.textContent = o.code || '';
        $('mp-wait-msg').textContent = msg;
        $('mp-ready-btn').style.display = o.ready ? 'block' : 'none';
        $('mp-cancel-btn').textContent = o.cancelLabel || 'CANCEL';
        waitEl.style.display = 'flex';
    }
    const hideWait = () => { waitEl.style.display = 'none'; };

    function fail(msg) {
        closeSocket();
        M.phase = 'idle';
        M.pendingStart = null;
        showWait(msg, { title: 'CONNECTION PROBLEM', cancelLabel: 'BACK' });
    }

    $('mp-cancel-btn').addEventListener('click', () => {
        if (M.ws) send({ t: 'cancel' });
        closeSocket();
        M.phase = 'idle'; M.mode = 'solo'; M.pendingStart = null;
        hideWait();
    });

    /* ---------- networking ---------- */
    function serverUrl() {
        const q = new URLSearchParams(location.search).get('server');
        const host = q || location.host;
        if (!host) return null;
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + host;
    }
    function send(obj) { const ws = M.ws; if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
    function closeSocket() {
        const ws = M.ws;
        M.ws = null;
        if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) {} }
    }
    const profile = () => ({ name: username, op: selectedOperatorId, ab: selectedAbilityId, w: selectedWeaponIndex });

    function startMatchmaking() {
        const url = serverUrl();
        if (!url) { showWait('OPEN THE GAME FROM THE SERVER ADDRESS (NOT FROM A FILE)', { title: 'NO SERVER', cancelLabel: 'BACK' }); return; }
        M.phase = 'connecting';
        showWait('CONNECTING TO SERVER...');
        closeSocket();
        let ws;
        try { ws = new WebSocket(url); } catch (e) { fail('COULD NOT CONNECT TO THE SERVER'); return; }
        M.ws = ws;
        ws.onopen = () => {
            if (M.mode === 'teams') send(Object.assign({ t: 'team' }, profile()));
            else if (M.mode === 'create') send(Object.assign({ t: 'create', map: $('map-select').value }, profile()));
            else if (M.mode === 'join') send(Object.assign({ t: 'join', code: M.joinCode }, profile()));
        };
        ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } handle(m); };
        ws.onerror = () => { if (M.ws === ws && M.phase === 'connecting') fail('COULD NOT REACH THE MULTIPLAYER SERVER'); };
        ws.onclose = () => {
            if (M.ws !== ws) return;
            M.ws = null;
            if (M.phase === 'connecting' || M.phase === 'waiting' || M.phase === 'found') fail('CONNECTION LOST');
            else if (M.inMatch && M.phase === 'playing') endLocal(-1, 'disconnect');
        };
    }

    function handle(m) {
        switch (m.t) {
            case 'waiting': M.phase = 'waiting'; showWait('WAITING FOR PLAYERS (' + (m.queued || 1) + ' / 20)...', { title: '10V10 TEAM BATTLE', sub: 'PUBLIC MATCH \u00B7 10 PLAYERS PER TEAM' }); break;
            case 'created': M.phase = 'waiting'; showWait('WAITING FOR YOUR FRIEND TO JOIN...', { code: m.code, sub: 'PRIVATE ROOM \u00B7 SHARE THIS CODE' }); break;
            case 'err': fail(m.msg || 'SOMETHING WENT WRONG'); break;
            case 'start': onFound(m); break;
            case 'go': onGo(); break;
            case 's': onState(m); break;
            case 'f': onRemoteShot(m); break;
            case 'h': onHitMe(m); break;
            case 'k': onKill(m); break;
            case 'end': endLocal(m.winner, m.reason, m.kills); break;
        }
    }

    /* ---------- match found / ready ---------- */
    function onFound(m) {
        M.phase = 'found'; M.idx = m.you; M.team = m.team || 0; M.teamMode = !!m.teamMode;
        M.scoreIndex = M.teamMode ? M.team : M.idx; M.limit = m.limit || (M.teamMode ? 50 : 10); M.kills = [0, 0];
        M.pendingStart = m; M.lastAttacker = -1;
        M.players = (m.roster || []).filter(p => p.id !== M.idx).map(p => ({
            id: p.id, team: p.team, name: p.prof.name || 'Player', op: p.prof.op, w: p.prof.w,
            mesh: null, alive: true, seen: false, hp: 100, walk: 0, yaw: 0,
            pos: new THREE.Vector3(0, -100, 0), tx: 0, ty: 0, tz: 0, tyaw: 0
        }));
        M.opp = M.players.find(p => !M.teamMode || p.team !== M.team) || M.players[0] || null;
        const label = MAPS[m.map] ? MAPS[m.map].label : m.map;
        const subtitle = M.teamMode ? ('TEAM ' + (M.team === 0 ? 'ALPHA' : 'BRAVO') + ' · 20 PLAYERS') : ('VS ' + (M.opp ? M.opp.name.toUpperCase() : 'OPPONENT'));
        showWait('MAP: ' + label, { title: M.teamMode ? '10V10 MATCH FOUND' : 'PRIVATE MATCH FOUND', sub: subtitle, ready: true, cancelLabel: 'LEAVE' });
    }

    $('mp-ready-btn').addEventListener('click', () => {
        const m = M.pendingStart;
        if (!m) return;
        hideWait();
        if (MAPS[m.map]) $('map-select').value = m.map;      // original deploy applies the selected map
        M.inMatch = true; M.phase = 'playing'; M.frozen = true; M.dead = false; M.started = false;
        document.body.classList.add('mp-active');
        _deploy();                                            // builds HUD, starts the match, locks the pointer
        placeAtSpawn(true);
        buildOpponent();
        updateHud(true);
        announce(M.teamMode ? 'WAITING FOR ALL 20 PLAYERS...' : 'WAITING FOR OPPONENT...', '#00e5ff');
        send({ t: 'ready' });
    });

    function onGo() {
        if (!M.inMatch || M.phase !== 'playing') return;
        let n = 3;
        announce(String(n), '#ffb300');
        const iv = setInterval(() => {
            if (!M.inMatch || M.phase !== 'playing') { clearInterval(iv); return; }
            n--;
            if (n > 0) { announce(String(n), '#ffb300'); return; }
            clearInterval(iv);
            M.frozen = false; M.started = true;
            announce('FIGHT!', '#00ff9d');
            sfx.wave();
        }, 1000);
    }

    /* ---------- spawning ---------- */
    function placeAtSpawn(initial) {
        let pick = null;
        const side = M.teamMode ? M.team : M.idx;
        const localIdx = M.teamMode ? (M.idx % 10) : M.idx;
        const sign = side === 0 ? 1 : -1;
        const candidates = [];
        for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) {
            candidates.push([-36 + col * 18, sign * (28 + row * 5)]);
        }
        candidates.sort((a, b) => Math.hypot(a[0] - ((localIdx % 5) - 2) * 16, a[1] - sign * (28 + Math.floor(localIdx / 5) * 10)) - Math.hypot(b[0] - ((localIdx % 5) - 2) * 16, b[1] - sign * (28 + Math.floor(localIdx / 5) * 10)));
        if (!initial) candidates.reverse();
        for (const c of candidates) {
            if (!hitsSolid(c[0], 0, c[1], 0.8, 2.6)) { pick = c; break; }
        }
        if (!pick) { const p = pickFreePoint(0, false); pick = [p.x, p.z]; }
        player.pos.set(pick[0], 0, pick[1]); player.vel.set(0, 0, 0);
        player.vy = 0; player.pitch = 0; player.yaw = Math.atan2(-pick[0], -pick[1]);
    }

    /* ---------- remote player models ---------- */
    function buildOpponent() {
        for (const p of M.players) {
            if (p.mesh) continue;
            const bot = buildBotModel('grunt');
            bot.scale.setScalar(0.68);
            const friendly = M.teamMode && p.team === M.team;
            bot.userData.plate.color.setHex(friendly ? 0x00b8ff : 0xff3d57);
            if (bot.userData.bar) bot.userData.bar.visible = false;
            bot.visible = false; scene.add(bot); p.mesh = bot;
        }
        M.opp = M.players.find(p => !M.teamMode || p.team !== M.team) || M.players[0] || null;
        if (M.teamMode) oppBar.style.display = 'none';
    }

    function onState(m) {
        const o = M.players.find(p => p.id === m.from);
        if (!o) return;
        const wasAlive = o.alive;
        o.tx = m.x; o.ty = m.y; o.tz = m.z; o.tyaw = m.yaw;
        o.hp = m.hp; o.alive = !!m.al;
        if (!o.seen || (!wasAlive && o.alive)) { o.pos.set(m.x, m.y, m.z); o.yaw = m.yaw; o.seen = true; }
    }

    function onRemoteShot(m) {
        if (!M.inMatch) return;
        const w = WEAPONS[m.w] || WEAPONS[0];
        const origin = new THREE.Vector3(m.o[0], m.o[1], m.o[2]);
        const dir = new THREE.Vector3(m.d[0], m.d[1], m.d[2]).normalize();
        const mesh = new THREE.Mesh(bulletGeo, tracerMat(0xff6a3d));
        mesh.position.copy(origin); mesh.lookAt(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z);
        scene.add(mesh); M.tracers.push({ mesh, dir, life: 0.45 });
        shotSound(w, clamp(1 / (1 + origin.distanceTo(player.pos) * 0.05), 0.08, 0.9));
    }

    function onHitMe(m) {
        if (!M.inMatch || M.phase !== 'playing' || M.frozen || M.dead) return;
        if (performance.now() < M.protectUntil) return;
        M.lastAttacker = Number.isInteger(m.from) ? m.from : -1;
        const attacker = M.players.find(p => p.id === M.lastAttacker);
        damagePlayer(Math.min(400, +m.dmg || 0), attacker && attacker.mesh ? attacker.mesh.position : null);
    }

    function onKill(m) {
        M.kills = m.kills || M.kills;
        const killer = M.players.find(p => p.id === m.killer);
        const victim = M.players.find(p => p.id === m.victim);
        if (m.killer === M.idx) { sfx.kill(); addFeed('YOU ELIMINATED ' + (victim ? victim.name : 'ENEMY').toUpperCase(), false, true); }
        else if (m.victim === M.idx) addFeed((killer ? killer.name : 'ENEMY').toUpperCase() + ' ELIMINATED YOU', false, true);
        else if (killer && victim) addFeed(killer.name.toUpperCase() + ' ELIMINATED ' + victim.name.toUpperCase(), false, true);
        updateHud(true);
    }

    /* ---------- hit detection (shooter side) ---------- */
    const _rc = new THREE.Raycaster();
    const _o = new THREE.Vector3(), _base = new THREE.Vector3(), _dir = new THREE.Vector3();

    function hitscan() {
        const res = { dmg: 0, head: false, point: null, hits: Object.create(null) };
        const targets = M.players.filter(p => p.mesh && p.alive && p.seen && (!M.teamMode || p.team !== M.team));
        if (!targets.length) return res;
        const w = currentWeapon(), op = currentOperator();
        camera.updateMatrixWorld(true); camera.getWorldPosition(_o); camera.getWorldDirection(_base);
        const moveFactor = clamp(Math.hypot(player.vel.x, player.vel.z) / CFG.playerSpeed, 0, 1) * 0.6 + (player.grounded ? 0 : 1);
        const sp = w.spread * op.spread * (1 + bloom * 0.06 + moveFactor) * (1 - 0.65 * adsT);
        const R = 0.55, H = 1.85, HEAD = 1.33;
        for (let pellet = 0; pellet < w.pellets; pellet++) {
            _dir.copy(_base); _dir.x += (Math.random() - 0.5) * 2 * sp; _dir.y += (Math.random() - 0.5) * 2 * sp;
            _dir.z += (Math.random() - 0.5) * 2 * sp; _dir.normalize();
            let nearest = null;
            for (const target of targets) {
                const cx = target.pos.x, cz = target.pos.z, fy = target.pos.y;
                const ox = _o.x - cx, oz = _o.z - cz;
                const a = _dir.x * _dir.x + _dir.z * _dir.z; if (a < 1e-6) continue;
                const b = ox * _dir.x + oz * _dir.z, c = ox * ox + oz * oz - R * R;
                const disc = b * b - a * c; if (disc < 0) continue;
                const sq = Math.sqrt(disc); let t = (-b - sq) / a; if (t < 0) t = (-b + sq) / a;
                if (t < 0 || t > 200 || (nearest && t >= nearest.t)) continue;
                const y = _o.y + _dir.y * t - fy; if (y < 0 || y > H) continue;
                _rc.set(_o, _dir); _rc.near = 0; _rc.far = t;
                if (_rc.intersectObjects(solids, false).length) continue;
                nearest = { target, t, head: y > HEAD };
            }
            if (nearest) {
                const pelletDamage = w.damage * op.damage * (nearest.head ? 2 : 1);
                res.dmg += pelletDamage;
                if (nearest.head) res.head = true;
                if (!res.hits[nearest.target.id]) res.hits[nearest.target.id] = { dmg: 0, head: false };
                res.hits[nearest.target.id].dmg += pelletDamage;
                res.hits[nearest.target.id].head = res.hits[nearest.target.id].head || nearest.head;
                if (!res.point) res.point = new THREE.Vector3().copy(_o).addScaledVector(_dir, nearest.t);
            }
        }
        return res;
    }

    window.fireShot = function (now) {
        if (!M.inMatch) return _fire(now);
        if (M.frozen || M.dead || M.phase !== 'playing') return;
        const hit = hitscan();
        const dir = camera.getWorldDirection(new THREE.Vector3());
        _fire(now);
        const mz = muzzleAnchor.getWorldPosition(new THREE.Vector3());
        send({ t: 'f', o: [mz.x, mz.y, mz.z], d: [dir.x, dir.y, dir.z], w: selectedWeaponIndex });
        if (hit.dmg > 0) {
            for (const [id, result] of Object.entries(hit.hits)) {
                send({ t: 'h', target: Number(id), dmg: Math.round(result.dmg * 10) / 10, head: result.head });
                const target = M.players.find(p => p.id === Number(id)); if (target) target.hp = Math.max(0, target.hp - result.dmg);
            }
            showHitmarker(hit.head); sfx.hit(hit.head);
            if (hit.point) spawnSparks(hit.point, hit.head ? 7 : 4, hit.head ? sparkMats.white : sparkMats.cyan, 4.5, 0.3);
        }
    };

    /* ---------- death / respawn ---------- */
    window.die = function () {
        if (!M.inMatch) return _die();
        if (M.dead || M.phase !== 'playing') return;
        M.dead = true;
        M.respawnAt = performance.now() + RESPAWN_MS;
        mouseHeld = false; adsHeld = false;
        announce('ELIMINATED', '#ff3d57');
        send({ t: 'd', killer: M.lastAttacker }); M.lastAttacker = -1;
    };

    function respawn() {
        M.dead = false;
        player.health = 100;
        setHealthHud();
        placeAtSpawn(false);
        WEAPONS.forEach((w, i) => { ammo[i] = w.mag; });
        cancelReload();
        updateAmmoHud();
        M.protectUntil = performance.now() + PROTECT_MS;
        announce('RESPAWNED', '#00ff9d');
    }

    /* ---------- end of match ---------- */
    function endLocal(winner, reason, kills) {
        if (!M.inMatch || M.phase === 'over') return;
        M.phase = 'over';
        if (kills) M.kills = kills;
        updateHud(true);
        state = 'dead';
        mouseHeld = false; adsHeld = false;
        document.exitPointerLock();
        $('hud').style.display = 'none';

        const title = $('mp-result-title');
        let text, sub = '';
        if (winner === (M.teamMode ? M.team : M.idx)) { text = 'VICTORY'; title.style.background = 'linear-gradient(135deg,#00ff9d,#00b8ff)'; }
        else if (winner === -1) { text = 'MATCH ENDED'; title.style.background = 'linear-gradient(135deg,#7d8da1,#4a5568)'; }
        else { text = 'DEFEAT'; title.style.background = 'linear-gradient(135deg,#ff3d57,#a30f26)'; }
        title.style.webkitBackgroundClip = 'text'; title.style.backgroundClip = 'text'; title.style.webkitTextFillColor = 'transparent';
        if (reason === 'left') sub = M.teamMode ? 'A PLAYER LEFT THE MATCH' : 'YOUR OPPONENT LEFT THE MATCH';
        else if (reason === 'timeout') sub = 'NOT ALL PLAYERS GOT READY IN TIME';
        else if (reason === 'disconnect') sub = 'CONNECTION TO THE SERVER WAS LOST';
        else sub = M.teamMode ? 'FIRST TEAM TO ' + M.limit + ' ELIMINATIONS' : 'FIRST TO ' + M.limit + ' KILLS';
        title.textContent = text; $('mp-result-sub').textContent = sub;
        const scoreIdx = M.teamMode ? M.team : M.idx;
        $('mp-result-score').textContent = M.kills[scoreIdx] + '  -  ' + M.kills[1 - scoreIdx];
        $('pause-screen').style.display = 'none';
        resultEl.style.display = 'flex';
    }

    function cleanup(sendLeave) {
        if (sendLeave && M.ws) send({ t: 'leave' });
        closeSocket();
        for (const p of M.players) if (p.mesh) disposeBot(p.mesh);
        for (const t of M.tracers) scene.remove(t.mesh);
        M.tracers.length = 0;
        M.inMatch = false; M.phase = 'idle'; M.opp = null; M.players = []; M.teamMode = false; M.lastAttacker = -1; oppBar.style.display = '';
        M.frozen = false; M.dead = false; M.started = false;
        M.mode = 'solo'; M.pendingStart = null;
        document.body.classList.remove('mp-active');
        resultEl.style.display = 'none';
        hideWait();
    }

    $('mp-result-btn').addEventListener('click', () => { returnToLobby(); cleanup(true); });
    $('quit-btn').addEventListener('click', () => { if (M.inMatch) cleanup(true); });

    /* ---------- wrappers that keep solo-only systems out of multiplayer ---------- */
    window.startWave = function (n) {
        if (M.inMatch) { wave = n; waveState = 'mp'; return; }
        return _startWave(n);
    };
    window.updateWaves = function (dt) { if (!M.inMatch) return _updateWaves(dt); };

    window.updatePlayer = function (dt, now) {
        if (M.inMatch && (M.frozen || M.dead)) {
            for (const k in keys) keys[k] = false;
            mouseHeld = false; adsHeld = false;
        }
        return _updatePlayer(dt, now);
    };

    window.setWeapon = function (i) { if (M.inMatch) return; return _setWeapon(i); };   // fixed loadout during multiplayer

    window.pauseGame = function () {
        if (!M.inMatch) { document.querySelector('#pause-screen .title').textContent = 'PAUSED'; return _pause(); }
        if (M.phase !== 'playing') return;
        // the match keeps running while the menu is open, so the state stays 'playing'
        mouseHeld = false; adsHeld = false;
        for (const k in keys) keys[k] = false;
        document.querySelector('#pause-screen .title').textContent = 'MATCH MENU';
        $('sens').value = settings.sens;
        $('vol').value = settings.volume;
        $('pause-screen').style.display = 'flex';
    };
    document.addEventListener('pointerlockchange', () => {
        if (M.inMatch && document.pointerLockElement === $('game-canvas')) $('pause-screen').style.display = 'none';
    });

    window.drawRadar = function (now) {
        _radar(now);
        if (!M.inMatch) return;
        const s = Math.sin(player.yaw), c = Math.cos(player.yaw);
        for (const o of M.players) {
            if (!o.seen || !o.alive) continue;
            const dx = o.pos.x - player.pos.x, dz = o.pos.z - player.pos.z;
            let sx = RS * (c * dx - s * dz), sy = RS * (s * dx + c * dz);
            const len = Math.hypot(sx, sy), maxR = RAD - 8;
            if (len > maxR) { sx *= maxR / len; sy *= maxR / len; }
            rctx.setTransform(1, 0, 0, 1, 0, 0);
            rctx.fillStyle = M.teamMode && o.team === M.team ? '#00b8ff' : (Math.floor(now / 250) % 2 === 0 ? '#ff3d57' : '#ff8a99');
            rctx.strokeStyle = '#fff'; rctx.lineWidth = 1;
            rctx.beginPath(); rctx.arc(RAD + sx, RAD + sy, 3, 0, Math.PI * 2); rctx.fill(); rctx.stroke();
        }
    };

    /* ---------- HUD ---------- */
    function updateHud(force) {
        const now = performance.now();
        if (!force && now - M.lastHud < 100) return;
        M.lastHud = now;
        const scoreIdx = M.teamMode ? M.team : M.idx;
        $('mp-me').textContent = M.kills[scoreIdx]; $('mp-opp').textContent = M.kills[1 - scoreIdx];
        $('mp-limit').textContent = M.teamMode ? 'FIRST TO ' + M.limit : 'FIRST TO ' + M.limit;
        $('mp-hud').querySelector('.me small').textContent = M.teamMode ? (M.team === 0 ? 'ALPHA' : 'BRAVO') : 'YOU';
        $('mp-hud').querySelector('.op small').textContent = M.teamMode ? (M.team === 0 ? 'BRAVO' : 'ALPHA') : 'OPP';
        $('mp-oppname').textContent = M.teamMode ? 'TEAM SCORE' : (M.opp ? M.opp.name.toUpperCase() : 'OPPONENT');
        const hp = M.opp ? clamp(M.opp.hp, 0, 100) : 100; if (oppBar.firstChild) oppBar.firstChild.style.width = hp + '%';
    }

    /* ---------- main per-frame work ---------- */
    let last = performance.now();
    function tick(now) {
        requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!M.inMatch) return;

        // Interpolate all 19 other players (teammates and opponents).
        for (const o of M.players) {
            if (!o.mesh) continue;
            o.mesh.visible = o.seen && o.alive;
            if (!o.seen) continue;
            const k = 1 - Math.exp(-dt * 14); const px = o.pos.x, pz = o.pos.z;
            o.pos.x += (o.tx - o.pos.x) * k; o.pos.y += (o.ty - o.pos.y) * k; o.pos.z += (o.tz - o.pos.z) * k;
            let dy = o.tyaw - o.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); o.yaw += dy * k;
            o.mesh.position.copy(o.pos); o.mesh.rotation.y = o.yaw + Math.PI;
            const moved = Math.hypot(o.pos.x - px, o.pos.z - pz); const ud = o.mesh.userData;
            if (moved / Math.max(dt, 0.001) > 1) o.walk += moved * 2.4;
            const sw = moved / Math.max(dt, 0.001) > 1 ? Math.sin(o.walk) * 0.75 : 0;
            if (ud.legL) ud.legL.rotation.x = sw; if (ud.legR) ud.legR.rotation.x = -sw;
            if (ud.armL) ud.armL.rotation.x = -sw * 0.32; if (ud.armR) ud.armR.rotation.x = sw * 0.22;
        }

        // remote tracers
        for (let i = M.tracers.length - 1; i >= 0; i--) {
            const t = M.tracers[i];
            t.life -= dt;
            t.mesh.position.addScaledVector(t.dir, 190 * dt);
            if (t.life <= 0 || insideSolid(t.mesh.position)) { scene.remove(t.mesh); M.tracers.splice(i, 1); }
        }

        const pnow = performance.now();
        if (M.phase === 'playing') {
            if (M.dead && pnow >= M.respawnAt) respawn();
            if (pnow - M.lastSend >= SEND_MS) {
                M.lastSend = pnow;
                send({ t: 's', x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2),
                       yaw: +player.yaw.toFixed(3), pitch: +player.pitch.toFixed(3),
                       hp: Math.max(0, Math.round(player.health)), al: M.dead ? 0 : 1 });
            }
        }
        updateHud(false);
    }
    requestAnimationFrame(tick);
})();
