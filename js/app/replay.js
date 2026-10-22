/* Replay controller: the ONE playback state both views share - time (C4.Playback), range
 * (whole match / one round), player visibility, the selected player, hover and the display
 * options. It owns the controls bar, the timeline, the team panel and the kill & bomb feed,
 * and draws the active view (2D or 3D) on every frame. Switching views keeps all of it. */
import { upperBound } from './match.js';

const C4 = window.C4;
const { el, clear, fmtTime } = C4.ui;
const CFG = C4.mapConfig;
const PF = C4.collect.PF;
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

export class Replay {
  /** dom: {viewport, clock, controls, teams, feed, toolbar} */
  constructor(match, app, dom) {
    this.match = match;
    this.d = match.d;
    this.app = app;
    this.dom = dom;
    this.views = {};
    this.view = null;
    const d = this.d;
    // display state shared by both views
    this.selected = new Set(d.players.filter(p => p.team === 'A' || p.team === 'B').map(p => p.client));
    if (!this.selected.size) for (const p of d.players) this.selected.add(p.client);
    this.focus = null;               // the selected player: highlighted in both views, followed by the 3D camera
    this.selection = { a: null, b: null };   // the export range markers on the timeline (I / O)
    this.hover = null;               // player under the mouse in the team panel
    this.opts = { labels: true, lastKnown: false, trails: true, killLines: true, grenadeKinds: new Set(['smoke', 'frag', 'flash', 'concussion', 'other']) };
    this.scope = -1;
    this.base = 0;
    this.listeners = new Set();
    this.pb = new C4.Playback(t => this.frame(t));
    this.pb.active = true;
    this.buildControls();
    this.buildTeamPanel();
    this.setScope(-1);
  }

  /* ---------- views ---------- */
  addView(view) { this.views[view.key] = view; }
  setView(key) {
    const v = this.views[key];
    if (!v || v === this.view) return;
    if (this.view) this.view.hide();
    this.view = v;
    v.show();
    this.emit('view');
    this.pb.invalidate();
  }

  /** change notifications for views and panels: 'focus' | 'selection' | 'options' | 'scope' | 'view' */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }

  setFocus(cl) {
    this.focus = this.focus === cl ? null : cl;
    if (this.focus != null) this.selected.add(this.focus);
    this.emit('focus');
    this.pb.invalidate();
  }
  setHover(cl) { if (this.hover !== cl) { this.hover = cl; this.pb.invalidate(); } }
  setOption(key, value) { this.opts[key] = value; this.emit('options'); this.pb.invalidate(); }
  invalidate() { this.pb.invalidate(); }

  /** the players drawn: the visible ones plus the hovered and the selected player */
  shownPlayers() {
    const s = new Set(this.selected);
    if (this.hover != null) s.add(this.hover);
    if (this.focus != null) s.add(this.focus);
    return s;
  }

  /** seek to t (ms); switches to the whole match if t is outside the current round */
  seek(t, dir) { this.pb.seek(t, dir); }
  gotoEvent(t, roundIndex) {
    const d = this.d;
    const ri = roundIndex != null && roundIndex >= 0 ? roundIndex : C4.events.roundAt(d.rounds, t);
    if (this.scope >= 0 && this.scope !== ri) this.setScope(ri >= 0 ? ri : -1);
    this.pb.seek(Math.max(this.pb.range[0], t));
    this.pb.invalidate();
  }

  /* ---------- controls + timeline ---------- */
  buildControls() {
    const d = this.d, M = this.match;
    const scopeSel = el('select', { class: 'scope', title: 'Replay range', onchange: e => this.setScope(Number(e.target.value)) }, el('option', { value: '-1' }, 'Whole match'));
    d.rounds.forEach((r, i) => scopeSel.append(el('option', { value: String(i) },
      (r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : r.kind === 'aftermatch' ? 'Aftermatch' : 'Round ' + r.label) + '  (' + fmtTime(M.live[i]) + ')')));
    this.scopeSel = scopeSel;
    const playBtn = el('button', { class: 'btn primary play', title: 'Play / pause (Space)', onclick: () => this.pb.toggle() }, '▶');
    this.playBtn = playBtn;
    const speedSeg = el('div', { class: 'seg' });
    for (const s of CFG.SPEEDS) {
      const b = el('button', { class: s === 1 ? 'active' : null, title: 'Playback speed', onclick: () => { this.pb.speed = s; speedSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); } }, s + '×');
      speedSeg.append(b);
    }
    this.timeNow = el('span', { class: 'time-now' });
    const tlBox = el('div', { class: 'timeline' });
    this.timeline = new C4.Timeline(tlBox, (t, dir) => this.pb.seek(t, dir));
    this.exportBtn = el('button', { class: 'btn', title: 'Export the current view as MP4 or GIF', onclick: () => this.view && this.view.exportVideo && this.view.exportVideo() }, 'Export video');
    // start / end markers of the export range (keys I / O; clicking a set marker's button again clears it)
    const mark = (which, label, title) => el('button', { class: 'btn mark', title, onclick: () => this.setMark(which) }, label);
    this.markBtns = { a: mark('a', '[', 'Export range: start at the current time (I) - again to clear'), b: mark('b', ']', 'Export range: end at the current time (O) - again to clear') };
    clear(this.dom.controls).append(scopeSel,
      el('button', { class: 'btn', title: '−5 s (←)', onclick: () => this.pb.seek(this.pb.t - CFG.SEEK_STEP_MS, -1) }, '⏪'),
      playBtn,
      el('button', { class: 'btn', title: '+5 s (→)', onclick: () => this.pb.seek(this.pb.t + CFG.SEEK_STEP_MS, 1) }, '⏩'),
      speedSeg, this.timeNow, tlBox, this.markBtns.a, this.markBtns.b, this.exportBtn);

    // shared display options (both views)
    const opt = (label, key, title) => el('label', { class: 'opt', title: title || null },
      el('input', { type: 'checkbox', checked: this.opts[key] || null, onchange: e => this.setOption(key, e.target.checked) }), label);
    const gOpts = el('span', { class: 'opt-group', title: 'The thrower of a grenade is not in the demo, so grenades are shown for all players. Smoke size and duration are display constants.' }, 'Grenades:');
    for (const kind of ['smoke', 'frag', 'flash']) {
      const c = CFG.GRENADE[kind];
      gOpts.append(el('label', { class: 'opt', style: { color: c.color } }, el('input', { type: 'checkbox', checked: true, onchange: e => {
        if (e.target.checked) this.opts.grenadeKinds.add(kind); else this.opts.grenadeKinds.delete(kind);
        this.emit('options'); this.pb.invalidate();
      } }), c.label));
    }
    this.sharedToolbar = el('div', { class: 'toolbar-shared' },
      opt('Names', 'labels'), opt('Trails', 'trails', 'Last ' + CFG.TRAIL_MS / 1000 + ' s of movement'),
      opt('Kill lines', 'killLines', 'Line from killer to victim for 5 s after a kill'),
      opt('Last known position', 'lastKnown', 'Players the server stopped sending are drawn hollow at their last known position (same life only)'),
      gOpts);
  }

  setScope(i) {
    const d = this.d, M = this.match;
    this.scope = i;
    this.scopeSel.value = String(i);
    const mw = d.meta.mapWindow || { start: 0, end: d.meta.durationMs };
    const range = i < 0 ? [mw.start, mw.end] : [M.live[i], Math.min(d.rounds[i].segEnd, mw.end)];
    this.base = i < 0 ? 0 : M.live[i];
    this.pb.skips = i < 0 ? M.countdowns : [];
    this.pb.setRange(range[0], range[1]);
    if (i >= 0 || this.pb.t < range[0] || this.pb.t > range[1]) this.pb.seek(range[0]);
    const markers = [];
    for (const k of d.kills) markers.push({ t: k.t, kind: 'kill', color: k.world || k.suicide ? '#9aa4b2' : this.app.teamColor(k.attackerTeam) });
    for (const e of d.events) {
      if (e.type === 'bomb_planted') markers.push({ t: e.t, kind: 'bomb', color: '#f5c451' });
      if (e.type === 'bomb_defused') markers.push({ t: e.t, kind: 'bomb', color: '#58d68d' });
    }
    if (i < 0) for (const t of M.live) markers.push({ t, kind: 'round' });
    this.timeline.set(range, markers, { skips: this.pb.skips, base: this.base });
    this.buildFeed(range);
    this.emit('scope');
    this.pb.invalidate();
  }

  /** set the export range's start ('a') or end ('b') to the current time; the same time again clears it */
  setMark(which, t = this.pb.t) {
    const s = this.selection;
    s[which] = s[which] === t ? null : t;
    if (s.a != null && s.b != null && s.b < s.a) { const x = s.a; s.a = s.b; s.b = x; }
    for (const k of ['a', 'b']) this.markBtns[k].classList.toggle('active', s[k] != null);
    this.timeline.setSelection(s);
    this.emit('selection-range');
  }

  /* ---------- kill & bomb feed (side panel) ---------- */
  buildFeed(range) {
    const d = this.d, box = this.dom.feed;
    clear(box);
    this.evItems = [];
    this.evCurrent = -1;
    const items = [];
    for (const k of d.kills) if (k.t >= range[0] && k.t <= range[1]) items.push({ t: k.t, kill: k });
    for (const e of d.events) if ((e.type === 'bomb_planted' || e.type === 'bomb_defused') && e.t >= range[0] && e.t <= range[1]) items.push({ t: e.t, ev: e });
    items.sort((a, b) => a.t - b.t);
    for (const it of items) {
      const node = el('div', { class: 'map-ev', title: 'Jump to 2 s before', onclick: () => this.pb.seek(it.t - 2000) },
        el('span', { class: 'time' }, fmtTime(it.t - this.base)),
        C4.ui.phaseBadge(C4.rounds.phaseAt(d.phases, it.t)),
        el('span', { class: 'tl-what' }, it.kill ? C4.ui.killNodes(this.app, it.kill) : el('span', { style: { color: 'var(--warn)' } }, it.ev.text)));
      box.append(node);
      this.evItems.push({ t: it.t, node });
    }
    if (!items.length) box.append(el('div', { class: 'empty' }, 'No kills or bomb events in this range.'));
  }

  /* ---------- team panel: players of the round at the playback time ---------- */
  buildTeamPanel() {
    const d = this.d, app = this.app, box = this.dom.teams;
    clear(box);
    const withPos = p => !!d.positions[p.client];
    const title = el('div', { class: 'rp-title' }), status = el('div', { class: 'rp-status' });
    const all = d.players.filter(withPos).map(p => p.client);
    const setAll = (cls, on) => { for (const cl of cls) { if (on) this.selected.add(cl); else this.selected.delete(cl); } this.emit('selection'); this.pb.invalidate(); };
    this.statsCtx = { app, data: d, time: () => this.pb.t, roundAt: t => this.match.roundAtOrBefore(t), onChange: () => this.pb.invalidate() };
    box.append(el('div', { class: 'rp-head' },
      el('div', { class: 'rp-head-text' }, title, status),
      el('div', { class: 'rp-tools' },
        el('button', { class: 'btn small', title: 'Show every player', onclick: () => setAll(all, true) }, 'All'),
        el('button', { class: 'btn small', title: 'Hide every player', onclick: () => setAll(all, false) }, 'None'))));
    this.rp = { title, status, cards: [], rows: new Map() };
    const addCard = (key, name, ps, color) => {
      const score = el('span', { class: 'rp-score' }), side = el('span', { class: 'rp-side' }), alive = el('span', { class: 'rp-alive' });
      const card = el('div', { class: 'rp-card', style: { '--tc': color } },
        el('div', { class: 'rp-card-head' },
          el('span', { class: 'rp-team-name', title: name + ' - click: show / hide the whole team',
            onclick: () => setAll(ps.map(p => p.client), !ps.every(p => this.selected.has(p.client))) }, name),
          score, side, alive));
      const tbody = el('tbody');
      card.append(el('table', { class: 'rp-table' },
        el('thead', null, el('tr', null, el('th', null, ''), el('th', null, 'Player'), el('th', null, 'In hand'), el('th', { class: 'num' }, 'K'), el('th', { class: 'num' }, 'D'), el('th', null, ''))), tbody));
      for (const p of ps) this.rp.rows.set(p.client, this.playerRow(p, tbody));
      box.append(card);
      if (key) this.rp.cards.push({ key, score, side, alive, ps });
    };
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && withPos(p));
      if (ps.length) addCard(t.key, t.name, ps, app.teamColor(t.key));
    }
    const specs = d.players.filter(p => p.team !== 'A' && p.team !== 'B' && withPos(p));
    if (specs.length) addCard(null, 'Spectators', specs, app.teamColor('spectator'));
    box.append(el('p', { class: 'note' }, 'Click a player to select them (highlighted in 2D and 3D; the 3D follow camera uses the selection). The eye shows or hides a player.'));
  }

  playerRow(p, tbody) {
    const w = el('td', { class: 'rp-w' }), k = el('td', { class: 'num' }), dd = el('td', { class: 'num' });
    const eye = el('button', { class: 'rp-eye', title: 'Show / hide ' + p.cleanName, 'aria-label': 'Show or hide ' + p.cleanName,
      onclick: e => { e.stopPropagation(); if (this.selected.has(p.client)) this.selected.delete(p.client); else this.selected.add(p.client); this.emit('selection'); this.pb.invalidate(); } }, '●');
    const stats = el('button', { class: 'rp-stats', title: 'Player stats', 'aria-label': 'Player stats: ' + p.cleanName,
      onclick: e => { e.stopPropagation(); C4.mapStats.open(stats, p.client, this.statsCtx); } }, C4.mapStats.statsIcon());
    const tr = el('tr', { class: 'rp-row', title: p.cleanName + ' - click: select', onclick: () => this.setFocus(p.client),
      onmouseenter: () => this.setHover(p.client), onmouseleave: () => this.setHover(null) },
      el('td', { class: 'rp-eye-td' }, eye),
      el('td', { class: 'rp-name' }, el('span', { class: 'rp-dot' }), el('span', { class: 'rp-pname' }, p.cleanName),
        p.isPov ? el('span', { class: 'badge pov rp-pov', title: 'Recording player' }, 'POV') : null),
      w, k, dd, el('td', { class: 'rp-stats-td' }, stats));
    tbody.append(tr);
    return { p, tr, w, k, d: dd };
  }

  updateTeamPanel(t) {
    const d = this.d, M = this.match;
    const r = M.roundAtOrBefore(t);
    const phase = C4.rounds.phaseAt(d.phases, t);
    setText(this.rp.title, r ? (r.kind === 'round' ? 'Round ' + r.label : r.kind === 'knife' ? 'Knife round' : r.kind === 'prematch' ? 'Pre-match round' : 'Aftermatch') : 'Before the first round');
    let st;
    if (phase === 'halftime') st = 'Halftime';
    else if (phase === 'timeout') st = 'Timeout';
    else if (phase === 'warmup') st = 'Warm-up';
    else if (!r) st = '-';
    else if (r.end != null && t >= r.end) st = 'Won by ' + (r.winnerTeam ? this.app.teamName(r.winnerTeam) : 'unknown team') + (r.reason ? ' (' + r.reason + ')' : '');
    else if (r.start != null && t < r.start) st = 'Strat time';
    else if (t >= r.segEnd) st = 'Round over';
    else st = 'In progress';
    setText(this.rp.status, st);
    const kd = new Map(), dead = new Set();
    for (const k of d.kills) {
      if (k.t > t) break;
      if (r && k.t >= r.segStart) dead.add(k.victim);
      if (k.phase !== 'live') continue;
      const { credit, death } = C4.build.kdRule(k);
      if (credit) { const o = kd.get(k.attacker) || { k: 0, d: 0 }; o.k++; kd.set(k.attacker, o); }
      if (death) { const o = kd.get(k.victim) || { k: 0, d: 0 }; o.d++; kd.set(k.victim, o); }
    }
    this.deadNow = dead;
    let score = d.initialScore || { A: 0, B: 0 };
    for (const x of d.rounds) if (x.kind === 'round' && x.end != null && x.end <= t && x.scoreAfter) score = x.scoreAfter;
    this.scoreNow = score;
    for (const c of this.rp.cards) {
      setText(c.score, String(score[c.key] != null ? score[c.key] : 0));
      const sd = r && r.sides ? r.sides[c.key] : null;
      setText(c.side, sd === 'attack' ? 'ATTACK' : sd === 'defence' ? 'DEFENCE' : '');
      const inRound = r ? c.ps.filter(p => { const P = d.positions[p.client]; const i = upperBound(P.t, r.segEnd) - 1; return i >= 0 && P.t[i] >= r.segStart; }) : [];
      setText(c.alive, r ? inRound.filter(p => !dead.has(p.client)).length + '/' + inRound.length + ' alive' : '');
    }
    for (const [cl, row] of this.rp.rows) {
      const o = kd.get(cl) || { k: 0, d: 0 };
      setText(row.k, String(o.k));
      setText(row.d, String(o.d));
      const isDead = dead.has(cl);
      let w = '-';
      if (!isDead && r) {
        const P = d.positions[cl], i = upperBound(P.t, t) - 1;
        if (i >= 0 && P.t[i] >= r.segStart && !(P.flags[i] & PF.DEAD)) w = M.weaponLabel(P.weapon[i], P.t[i]);
      }
      setText(row.w, w);
      row.tr.classList.toggle('dead', isDead);
      row.tr.classList.toggle('off', !this.selected.has(cl));
      row.tr.classList.toggle('hover', this.hover === cl);
      row.tr.classList.toggle('focus', this.focus === cl);
    }
  }

  /* ---------- one frame ---------- */
  frame(t) {
    const r =C4.events.roundAt(this.d.rounds, t);
    const rl = r >= 0 ? C4.ui.fmtRoundTime(this.d, r, t) : '';
    setText(this.dom.clock, this.scope >= 0 ? (rl ? rl + '  ·  ' : '') + 'match ' + fmtTime(t) : fmtTime(t) + (rl ? '  ·  ' + rl : ''));
    setText(this.timeNow, fmtTime(t - this.base) + ' / ' + fmtTime(this.pb.range[1] - this.base));
    setText(this.playBtn, this.pb.playing ? '❚❚' : '▶');
    this.timeline.setTime(t);
    this.updateTeamPanel(t);
    if (this.view) this.view.draw(t);
    C4.mapStats.refresh();
    // feed highlight
    if (this.evItems && this.evItems.length) {
      let cur = -1;
      for (let i = 0; i < this.evItems.length; i++) if (this.evItems[i].t <= t) cur = i; else break;
      if (cur !== this.evCurrent) {
        if (this.evCurrent >= 0 && this.evItems[this.evCurrent]) this.evItems[this.evCurrent].node.classList.remove('current');
        if (cur >= 0) {
          const n = this.evItems[cur].node, box = this.dom.feed;
          n.classList.add('current');
          if (n.offsetTop < box.scrollTop || n.offsetTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = n.offsetTop - box.clientHeight / 2;
        }
        this.evCurrent = cur;
      }
    }
  }

  /** kills shown as kill lines / markers at t (the last KILL_LINE_MS, same round) */
  recentKills(t, ms = 5000) {
    const out = [], ep = this.match.epochStart(t);
    for (const k of this.d.kills) {
      if (k.t > t) break;
      if (t - k.t <= ms && k.t >= ep) out.push(k);
    }
    return out;
  }

  destroy() {
    this.pb.active = false;
    this.pb.playing = false;
    this.pb.onFrame = () => {};
    C4.mapStats.close();
    for (const v of Object.values(this.views)) if (v.destroy) v.destroy();
  }
}
