/* 3D view: the exported map (or the minimap as ground plane), players, effects and four camera
 * modes, drawn from the shared Replay state - so time, selection and filters carry over from 2D. */
import * as THREE from 'three';
import '../c4/ui/killfeed.js';                     // C4.killfeed (a classic script, loaded here: see the file)
import { loadWorld, groundPlane, resolveMap, loadTexture } from './mapLoader.js';
import { Actors, EYE, stanceOf } from './actors.js';
import { Effects } from './effects.js';
import { Cameras, MODES } from './cameras.js';
import { AuditView } from './audit.js';
import { CharacterLibrary, AnimationLibrary } from './characters.js';
import { SUN, PROBES, installGameFog } from './lighting.js';
import { SunShadows, castShadows } from './shadows.js';
import { Sky } from './sky.js';
import { FxSystem } from './fx.js';
import { ScriptModels } from './scriptModels.js';
import { SoundSystem } from './sound.js';

const C4 = window.C4;
const { el } = C4.ui;
const CFG = C4.mapConfig;
const CAM_KEY = 'cod4demo3d.camera';
const PLAYERS_KEY = 'cod4demo3d.players';
/** shared colour maps of the exported data (maps3d/_textures), D3D texture coordinates */
const texCache = new Map();
function mapTexture(file) {
  if (!file) return null;
  if (!texCache.has(file)) {
    const t = loadTexture('maps3d/' + file);
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texCache.set(file, t);
  }
  return texCache.get(file);
}
const PROPS_KEY = 'cod4demo3d.props';
const MODE_HELP = { orbit: 'Left drag: rotate · right drag: pan · wheel: zoom · click a player: select',
  free: 'Drag: look · W A S D: move · R / F: up / down · Shift: fast · wheel: speed',
  follow: 'Follows the selected player · drag: turn around them · wheel: distance',
  fp: 'Eyes of the selected player (their real view angles)' };
const stored = key => { try { return localStorage.getItem(key); } catch (err) { return null; } };
const store = (key, v) => { try { localStorage.setItem(key, v); } catch (err) { /* not stored */ } };
const SOUND_KEY = 'cod4demo3d.sound';
const KILLFEED_KEY = 'cod4demo3d.killfeed';      // 'on' / 'off' (default on)
const KILL_ICONS_KEY = 'cod4demo3d.killIcons';    // 'on' / 'off' (default off)

export class View3D {
  constructor(replay, container) {
    this.key = '3d';
    this.R = replay;
    this.M = replay.match;
    this.visible = false;
    this.t = replay.pb.t;
    this.stage = el('div', { class: 'view-stage view3d' });
    this.stage.hidden = true;
    container.append(this.stage);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;    // gamma-space colours, as the game
    this.stage.append(this.renderer.domElement);
    this.labels = el('div', { class: 'label-layer' });
    this.hint = el('div', { class: 'map-hint' }, 'Loading the 3D map …');
    this.camHint = el('div', { class: 'cam-hint', hidden: true });
    this.stage.append(this.labels, this.hint, this.camHint);

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e12);
    this.camera = new THREE.PerspectiveCamera(60, 1, 4, 80000);
    const hemi = new THREE.HemisphereLight(0xdde6f0, 0x3a3328, 1.6);
    hemi.position.set(0, 0, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-0.4, -0.5, 1);
    scene.add(hemi, this.sun);
    this.characters = new CharacterLibrary(mapTexture);
    this.animations = new AnimationLibrary();
    this.actors = new Actors(scene, this.labels, this.M, this.characters, failed => this.showPlayerNotice(failed), this.animations);
    this.actors.onLoaded = () => { this.R.invalidate(); this.needsRender = true; };
    this.playerNotice = el('div', { class: 'player-notice', hidden: true });
    this.stage.append(this.playerNotice);
    this.effects = new Effects(scene, this.labels, this.M);
    // the kill feed over the view, top right (js/c4/ui/killfeed.js, the side panel's icons)
    this.killfeed = new C4.killfeed.Overlay(this.stage, replay.app, this.M.d);
    this.needsRender = true;
    this.cams = new Cameras(this.camera, this.renderer.domElement, () => { this.needsRender = true; });
    this.buildToolbar();
    this.setKillfeed(stored(KILLFEED_KEY) !== 'off');
    this.setKillIcons(stored(KILL_ICONS_KEY) === 'on');
    let mode = 'orbit';
    try { const v = localStorage.getItem(CAM_KEY); if (MODES.some(m => m[0] === v)) mode = v; } catch (err) { /* default */ }
    this.setMode(mode);
    let players = 'simple';
    try { if (localStorage.getItem(PLAYERS_KEY) === 'models') players = 'models'; } catch (err) { /* default */ }
    this.setPlayersMode(players);

    // click a player to select them (not after a drag)
    let down = null;
    this.renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      // audit mode: name the asset under the cursor
      if (this.audit && this.world) {
        const a = this.audit.pick(ray, [this.world.group, this.scriptModels ? this.scriptModels.group : null, this.fx ? this.fx.group : null].filter(Boolean));
        this.auditInfo.textContent = a ? a.kind + ' ' + a.name + ': ' + a.status + (a.issues.length ? ' - ' + a.issues.join('; ') : '')
          : this.audit.legend();
      }
      const cl = this.actors.pick(ray);
      if (cl != null) this.R.setFocus(cl);
    });
    this.offFocus = replay.on(what => { if (what === 'focus') this.syncPlayerSelect(); });
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.loop = this.loop.bind(this);
    this.last = null;
    this.load();
  }

  /* ---------- map ---------- */
  async load() {
    const M = this.M, map = M.d.meta.map;
    let name = null;
    try { name = await resolveMap(map); } catch (err) { name = null; }
    if (name) {
      try {
        // ?lighting=scene: players and props lit by the scene lights instead of the game's light grid
        const gameLighting = new URLSearchParams(location.search).get('lighting') !== 'scene';
        const w = await loadWorld(name, { gameLighting, onProgress: f => { this.hint.textContent = 'Loading the 3D map ' + name + ' … ' + Math.round(f * 100) + ' %'; } });
        this.world = w;
        this.scene.add(w.group);
        this.scene.background = new THREE.Color(0x8ea2b4);
        // the map's sky (sky.js; the flat colour until it is loaded / without one)
        if (w.info.sky) Sky.load('maps3d/' + name + '/', w.info.sky).then(sky => {
          if (!sky || this.world !== w) return;
          this.sky = sky; this.scene.add(sky.mesh); this.needsRender = true;
        }).catch(err => console.warn('sky not loaded:', err));
        const b = w.info.bounds;
        const span = b ? Math.max(b.maxs[0] - b.mins[0], b.maxs[1] - b.mins[1]) : 8000;
        // the fog: with the game's lighting the fog the server sent (config string 9; most servers send
        // none), else a light distance haze
        const gfog = this.M.d.meta.fog;
        if (gameLighting) {
          installGameFog();
          this.scene.fog = gfog ? new THREE.Fog(new THREE.Color(...gfog.color), gfog.start, -gfog.density) : null;
        } else this.scene.fog = new THREE.Fog(0x8ea2b4, span * 0.9, span * 3);
        if (w.info.sun && w.info.sun.angles) {
          const [p, y] = w.info.sun.angles.map(a => a * Math.PI / 180);
          this.sun.position.set(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p));
          if (w.info.sun.sunColor) this.sun.color.setRGB(...w.info.sun.sunColor);
          // the game's sun (sunPosition / sunDiffuse of its shaders): direction towards the sun, colour
          // x (sunLight - ambientScale) x (1 - diffuseFraction); older exports: colour x sunLight
          SUN.dir.value.copy(this.sun.position).normalize();
          if (w.info.sun.dir) SUN.dir.value.set(...w.info.sun.dir).normalize();
          const k = w.info.sun.sunLight != null ? w.info.sun.sunLight : 1;
          if (w.info.sun.diffuse) SUN.color.value.setRGB(...w.info.sun.diffuse);
          else SUN.color.value.setRGB(...(w.info.sun.sunColor || [1, 1, 1]).map(c => c * k));
        }
        this.effects.setSites(w.sites || []);
        // the script models: destructible cars and the gametypes' objects, with their state from the demo
        this.scriptModels = new ScriptModels(this.M, w.scriptModels, this.characters, w.lightGrid, () => { this.needsRender = true; }, w.props);
        this.scriptModels.setCollision(w.scriptCollision);
        this.scene.add(this.scriptModels.group);
        // ?audit=1: the assets coloured by the audit's status (audit.js, tools/audit/asset_audit.py)
        if (new URLSearchParams(location.search).get('audit')) {
          AuditView.load('maps3d/' + name + '/').then(a => {
            if (!a || this.world !== w) return;
            this.audit = a;
            this.auditInfo = el('div', { class: 'audit-info' }, 'Audit: ' + a.legend() + ' - click an asset');
            this.stage.append(this.auditInfo);
            const apply = () => { a.apply(this.world.group); if (this.scriptModels) a.apply(this.scriptModels.group); if (this.fx) a.apply(this.fx.group); this.needsRender = true; };
            apply();
            this.auditTimer = setInterval(apply, 1000);         // script models appear later
          });
        }
        this.propsToggle.hidden = !w.props;
        if (w.props) { this.propsSel.value = this.loadPropsMode(w.props); }
        this.mapName = name;
        this.actors.setLightGrid(w.lightGrid);
        // the effects (fx.js): the map's ambient effects (smoke, fire, dust from the createfx placements)
        // and the demo's own (explosions, smoke grenades, blood, muzzle flashes, scripted effects);
        // ?fx=off: none, ?fx=ambient / ?fx=demo: only those
        const fxOpt = new URLSearchParams(location.search).get('fx');
        // the sounds (sound.js; ?sound=off: none): the world impacts come from the effects' traces
        if (new URLSearchParams(location.search).get('sound') !== 'off') {
          SoundSystem.load(name).then(snd => {
            if (!snd || this.world !== w) return;
            this.sound = snd;
            snd.setDemo(this.M, this.fx);
            snd.setVolume(this.soundVolume);
            this.soundToggle.hidden = false;
            if (this.soundWanted && navigator.userActivation && navigator.userActivation.hasBeenActive) this.setSound(true);
            else if (this.soundWanted) this.soundBtn.textContent = 'Sound on (click)';
          }).catch(err => console.warn('sounds not loaded:', err));
        }
        if (fxOpt !== 'off') {
          FxSystem.load('maps3d/' + name + '/', w.lightGrid, w.info.lights, w.info.sun && w.info.sun.index != null ? w.info.sun.index : 1).then(fx => {
            if (!fx || this.world !== w) return;
            fx.setModels(this.characters, () => { this.needsRender = true; });   // a debris model loaded
            fx.setDemo(this.M);
            fx.scripts = this.scriptModels;            // the cars stop bullets and debris (scriptModels.js trace)
            // the players' hit boxes in their animated pose (hitboxes.js): the animations in any player mode
            const A = this.actors;
            if (A.anims) {
              fx.animLoad = A.loadAnimations().catch(() => false);
              fx.hitBoxes.setAnimation({ animator: A.animator, anims: A.anims, controllers: A.controllers, ready: () => A.animReady });
            }
            fx.setWorld(w);
            this.fxOpts = { ambient: fxOpt !== 'demo', demo: fxOpt !== 'ambient' };
            this.fx = fx; this.scene.add(fx.group); this.needsRender = true;
            if (this.sound) this.sound.setDemo(this.M, fx);
            this.effects.realFx = this.fxOpts.demo;     // no marker clouds where the real smoke is drawn
            this.actors.realFlash = this.fxOpts.demo;   // no marker sphere where the muzzle flash is drawn
          }).catch(err => console.warn('effects not loaded:', err));
        }
        // the reflection probes of the specular maps; ?reflections=off for comparison
        PROBES.on.value = 0;
        if (w.probes) w.probes.activate(new URLSearchParams(location.search).get('reflections') !== 'off');
        this.actors.setProbes(w.probes);
        // the game's sun shadow map (shadows.js): world, props and players cast; ?shadows=off
        if (w.lightGrid && new URLSearchParams(location.search).get('shadows') !== 'off') {
          this.shadows = this.shadows || new SunShadows(this.renderer);
          castShadows(w.mesh);
          if (w.props) { castShadows(w.props.high); castShadows(w.props.low); }
        }
        this.updateHint();
      } catch (err) {
        console.error(err);
        this.fallback('The 3D map data for ' + name + ' could not be loaded (' + err.message + ').');
      }
    } else {
      this.fallback('No 3D map data for ' + (map || 'this map') + ' - run tools/export/export_maps.py (see README).');
    }
    // start the camera over the area the players used
    const b = M.bbox;
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
    // deep link ?cam=x,y,z,yaw,pitch: a free camera there (yaw / pitch in degrees)
    const cam = (new URLSearchParams(location.search).get('cam') || '').split(',').map(Number);
    if (cam.length === 5 && cam.every(Number.isFinite)) {
      this.cams.place(...cam);
      if (this.modeSel) this.modeSel.value = 'free';
      this.camHint.textContent = MODE_HELP.free;
    }
    this.needsRender = true;
    this.R.invalidate();
  }

  fallback(text) {
    const g = groundPlane(this.M);
    this.scene.add(g.group);
    this.scene.background = new THREE.Color(0x0b0e12);
    this.propsToggle.hidden = true;
    this.hint.textContent = text + ' Showing the minimap as the ground.';
    this.hint.classList.add('warn');
  }

  /* ---------- toolbar ---------- */
  buildToolbar() {
    const modeSel = el('select', { title: 'Camera mode (C cycles)', onchange: e => this.setMode(e.target.value) });
    for (const [k, label] of MODES) modeSel.append(el('option', { value: k }, label));
    this.modeSel = modeSel;
    const playerSel = el('select', { title: 'Selected player (follow / first person); also click a player in the view or the team panel',
      onchange: e => { const v = e.target.value; if (v === '') { if (this.R.focus != null) this.R.setFocus(this.R.focus); } else if (Number(v) !== this.R.focus) this.R.setFocus(Number(v)); } });
    this.playerSel = playerSel;
    this.fillPlayerSelect();
    this.propsSel = el('select', { title: 'Static models (props): the real models (LOD 0 or the lowest LOD), see-through boxes of their bounds, or none',
      onchange: e => this.setPropsMode(e.target.value) },
      el('option', { value: 'high' }, 'Models'), el('option', { value: 'low' }, 'Models (low detail)'),
      el('option', { value: 'boxes' }, 'Boxes'), el('option', { value: 'off' }, 'Off'));
    this.propsToggle = el('label', { class: 'opt' }, 'Props ', this.propsSel);
    this.playersSel = el('select', { onchange: e => this.setPlayersMode(e.target.value) },
      el('option', { value: 'simple' }, 'Simple'), el('option', { value: 'models' }, 'Models'));
    // sound: off until switched on (the browsers start audio only after a click); remembered
    this.soundWanted = false; this.soundVolume = 0.8;
    try { this.soundWanted = localStorage.getItem(SOUND_KEY) === 'on'; const v = Number(localStorage.getItem(SOUND_KEY + '.volume')); if (v >= 0 && v <= 1 && localStorage.getItem(SOUND_KEY + '.volume') != null) this.soundVolume = v; } catch (err) { /* default */ }
    this.soundBtn = el('button', { class: 'btn small', title: 'The game\'s sounds with the replay: shots, impacts, footsteps, explosions, the announcer (heard at the camera)',
      onclick: () => this.setSound(!(this.sound && this.sound.enabled), true) }, 'Sound off');
    this.soundVol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(this.soundVolume), title: 'Volume',
      oninput: e => { this.soundVolume = Number(e.target.value); if (this.sound) this.sound.setVolume(this.soundVolume); try { localStorage.setItem(SOUND_KEY + '.volume', String(this.soundVolume)); } catch (err) { /* not stored */ } } });
    this.soundToggle = el('span', { class: 'opt sound-opt', hidden: true }, this.soundBtn, ' ', this.soundVol);
    this.killfeedBox = el('input', { type: 'checkbox', onchange: e => this.setKillfeed(e.target.checked, true) });
    this.killIconsBox = el('input', { type: 'checkbox', onchange: e => this.setKillIcons(e.target.checked, true) });
    // a remembered "on" starts with the first click / key in the page
    const arm = () => { if (this.soundWanted && this.sound && this.visible && (!this.sound.enabled || this.sound.ctx.state !== 'running')) this.setSound(true); };
    window.addEventListener('pointerdown', arm, { capture: true });
    window.addEventListener('keydown', arm, { capture: true });
    this.offArm = () => { window.removeEventListener('pointerdown', arm, { capture: true }); window.removeEventListener('keydown', arm, { capture: true }); };
    this.toolbar = el('div', { class: 'toolbar-view' },
      el('label', { class: 'opt' }, 'Camera ', modeSel), el('label', { class: 'opt' }, 'Player ', playerSel),
      el('label', { class: 'opt', title: 'Player display: capsules, or the real character models (body and head from the demo, posed by stance)' }, 'Players ', this.playersSel), this.propsToggle,
      el('label', { class: 'opt', title: 'The kills and bomb plants / defuses of the last ' + C4.mapConfig.EXPORT.KILLFEED_MS / 1000 + ' s over the view, with the weapon icons' }, this.killfeedBox, 'Kill feed'),
      el('label', { class: 'opt', title: 'The weapon icon over each death marker' }, this.killIconsBox, 'Kill icons'),
      this.soundToggle,
      el('button', { class: 'btn small', title: 'Back to the overview', onclick: () => this.resetView() }, 'Reset view'));
  }
  fillPlayerSelect() {
    const d = this.M.d, sel = this.playerSel;
    sel.textContent = '';
    sel.append(el('option', { value: '' }, '— POV / followed —'));
    for (const t of d.teams) {
      const ps = d.players.filter(p => p.team === t.key && d.positions[p.client]);
      if (!ps.length) continue;
      const g = el('optgroup', { label: this.R.app.teamName(t.key) });
      for (const p of ps) g.append(el('option', { value: String(p.client) }, p.cleanName));
      sel.append(g);
    }
    this.syncPlayerSelect();
  }
  syncPlayerSelect() { this.playerSel.value = this.R.focus != null ? String(this.R.focus) : ''; this.needsRender = true; }

  setMode(mode) {
    this.cams.setMode(mode);
    this.modeSel.value = mode;
    this.R.invalidate();
    try { localStorage.setItem(CAM_KEY, mode); } catch (err) { /* not stored */ }
    this.camHint.textContent = MODE_HELP[mode];
    this.camHint.hidden = false;
    this.needsRender = true;
  }
  /** the kill feed over the view on / off (user: from the toolbar - remembered) */
  setKillfeed(on, user = false) {
    this.killfeed.visible = on;
    this.killfeedBox.checked = on;
    if (user) store(KILLFEED_KEY, on ? 'on' : 'off');
    this.killfeed.update(this.t || 0);
  }
  /** weapon icons over the death markers on / off */
  setKillIcons(on, user = false) {
    this.effects.killIcons = on;
    this.killIconsBox.checked = on;
    if (user) store(KILL_ICONS_KEY, on ? 'on' : 'off');
    this.R.invalidate();
  }
  /** sound on / off (user: from the button - remembered) */
  setSound(on, user = false) {
    if (user) { this.soundWanted = on; try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch (err) { /* not stored */ } }
    if (!this.sound) return;
    this.sound.enable(on && this.visible);
    this.soundBtn.textContent = on ? 'Sound on' : 'Sound off';
    this.soundBtn.classList.toggle('active', on);
  }
  loadPropsMode(props) {
    let mode = 'high';
    try { const v = localStorage.getItem(PROPS_KEY); if (['high', 'low', 'boxes', 'off'].includes(v)) mode = v; } catch (err) { /* default */ }
    return props.setMode(mode);
  }
  setPropsMode(mode) {
    const p = this.world && this.world.props;
    if (!p) return;
    this.propsSel.value = p.setMode(mode);
    if (this.shadows) this.shadows.invalidate();              // the props cast from the static map
    try { localStorage.setItem(PROPS_KEY, mode); } catch (err) { /* not stored */ }
    this.updateHint();
    this.needsRender = true;
  }
  /** map, triangle counts and load times (world / props) */
  updateHint() {
    const w = this.world;
    if (!w) return;
    const p = w.props, k = n => (n / 1000).toFixed(0) + 'k';
    const propsText = !p ? 'no props' : p.mode === 'off' ? 'props off'
      : p.mode === 'boxes' ? p.instanceCount + ' props as boxes'
      : p.instanceCount + ' props (' + p.modelCount + ' models' + (p.fallbackModels.length ? ', ' + p.fallbackModels.length + ' as boxes' : '') + ', ' + k(p.triangles) + ' triangles' + (p.mode === 'low' ? ', low detail' : '') + ')';
    this.hint.textContent = 'Map: ' + this.mapName + ' (' + k(w.info.triangleCount) + ' triangles, ' + propsText + '; loaded in ' +
      ((w.worldMs + (w.propsMs || 0)) / 1000).toFixed(1) + ' s). Extracted from the game files.' +
      (this.mapName !== this.M.d.meta.map ? ' Using ' + this.mapName + ' for ' + this.M.d.meta.map + '.' : '');
  }
  setPlayersMode(mode) {
    mode = mode === 'models' ? 'models' : 'simple';
    this.playersSel.value = mode;
    this.actors.setMode(mode);
    try { localStorage.setItem(PLAYERS_KEY, mode); } catch (err) { /* not stored */ }
    if (mode === 'simple') this.playerNotice.hidden = true; else if (this.actors.failed.size) this.showPlayerNotice([...this.actors.failed.keys()]);
    this.R.invalidate();
    this.needsRender = true;
  }
  showPlayerNotice(failed) {
    if (this.actors.mode !== 'models' || !failed.length) return;
    this.playerNotice.textContent = 'Player models not available: ' + failed.join(', ') + ' - those players are shown as capsules.';
    this.playerNotice.hidden = false;
  }
  resetView() {
    const M = this.M, b = M.bbox;
    if (this.cams.mode !== 'orbit') this.setMode('orbit');
    if (b) this.cams.frame({ mins: [b.minX, b.minY, M.zRange[0]], maxs: [b.maxX, b.maxY, M.zRange[1]] });
  }
  capturesKeys(e) {
    if (!this.visible) return false;
    if (e.code === 'KeyC') { const i = MODES.findIndex(m => m[0] === this.cams.mode); this.setMode(MODES[(i + 1) % MODES.length][0]); return true; }
    return this.cams.captureKey(e);
  }

  /* ---------- show / hide / size ---------- */
  show() {
    this.visible = true; this.stage.hidden = false; this.resize(); this.needsRender = true; this.last = null; requestAnimationFrame(this.loop);
    if (this.sound && this.soundWanted && this.sound.ctx) this.sound.enable(true);
  }
  hide() { this.visible = false; this.stage.hidden = true; if (this.sound && this.sound.enabled) this.sound.enable(false); }
  resize() {
    if (this.exporting) return;                    // the video export renders at its own size
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.w = r.width; this.h = r.height;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /* ---------- per playback frame ---------- */
  draw(t) {
    this.t = t;
    const R = this.R;
    this.actors.update(t, { shown: R.shownPlayers(), focus: R.focus, hover: R.hover, labels: R.opts.labels, lastKnown: R.opts.lastKnown,
      kills: R.recentKills(t, CFG.DEATH_MARKER_MS) });
    this.effects.update(t, R);
    this.killfeed.update(t);
    if (this.scriptModels) this.scriptModels.update(t);
    this.needsRender = true;
  }

  /** the centre of the sun shadow map: the orbit target, else a point ahead of the camera */
  shadowCenter() {
    if (this.cams.mode === 'orbit' && this.cams.orbit && this.cams.orbit.target) return this.cams.orbit.target.clone();
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    return this.camera.position.clone().addScaledVector(f, 700);
  }

  /** the player the follow / first-person camera uses: the selection, else the POV's followed player */
  cameraTarget() {
    const M = this.M, t = this.t;
    const cl = this.R.focus != null ? this.R.focus : M.followedAt(t);
    const s = cl != null ? M.sampleAt(cl, t) : null;
    if (!s || s.age > C4.mapConfig.STALE_MS) return { cl, target: null };
    const pos = new THREE.Vector3(s.x, s.y, s.z);
    return { cl, target: { pos, eye: new THREE.Vector3(s.x, s.y, s.z + EYE[stanceOf(s)]), yaw: s.yaw, pitch: s.pitch } };
  }

  loop(now) {
    if (!this.visible) return;
    requestAnimationFrame(this.loop);
    if (this.exporting) { this.last = null; return; }   // the export renders its frames (and plays the WebM's sound) itself
    const dt = this.last == null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.renderFrame(dt, this.lastShadowT == null ? 0 : (now - this.lastShadowT) / 1000)) this.lastShadowT = now;
    // the sounds at the camera; the first-person camera's player hears his own (the "_plr" aliases)
    if (this.sound && this.sound.enabled) {
      const fp = this.cams.mode === 'fp' ? this.cameraTarget().cl : null;
      this.sound.update(this.t || 0, this.camera, this.R.pb, fp);
    }
  }

  /** move the camera by dt (s), then render if anything changed (force: always) - the shadow maps'
   *  fades advance by shadowDt (s). -> the client hidden for the first-person view, or false when
   *  nothing was rendered */
  renderFrame(dt, shadowDt, force = false) {
    const mode = this.cams.mode;
    let hideClient = null;
    if (mode === 'follow' || mode === 'fp') {
      const { cl, target } = this.cameraTarget();
      if (this.cams.tick(dt, target)) this.needsRender = true;
      const name = cl != null ? this.M.name(cl) : null;
      const msg = !target ? (name ? name + ' is not visible at this time (dead or not sent by the server)' : 'Select a player to follow') : null;
      this.camHint.textContent = msg || (mode === 'fp' ? 'First person: ' + name : 'Following ' + name + ' · drag to turn around them');
      if (mode === 'fp' && target) { hideClient = cl; this.actors.hide(cl); }
    } else if (this.cams.tick(dt, null)) this.needsRender = true;
    if (!this.needsRender && !force) return false;
    this.needsRender = false;
    if (this.shadows) {
      this.camera.updateMatrixWorld();
      this.shadows.update(this.scene, this.shadowCenter(), SUN.dir.value, this.camera, this.world && this.world.info.lights, shadowDt);
    }
    if (this.fx) this.fx.update((this.t || 0) + (this.M.d.meta.firstServerTime || 0), this.camera, cl => this.actors.muzzle(cl), this.fxOpts);
    this.renderer.render(this.scene, this.camera);
    if (!this.exporting) {
      this.actors.projectLabels(this.camera, this.w, this.h, hideClient);
      this.effects.projectLabels(this.camera, this.w, this.h);
    }
    return { hideClient };
  }

  /* ---------- video export (exportVideo3d.js, loaded on first use) ---------- */
  exportVideo() {
    import('./exportVideo3d.js').then(m => m.openExport(this)).catch(err => { console.error(err); alert('The video export could not be loaded: ' + err.message); });
  }

  destroy() {
    this.visible = false;
    this.offFocus();
    this.actors.dispose();
    this.effects.dispose();
    this.killfeed.dispose();
    this.cams.dispose();
    if (this.shadows) { this.shadows.dispose(); this.shadows = null; }
    if (this.sky) { this.sky.dispose(); this.sky = null; }
    if (this.fx) { this.fx.dispose(); this.fx = null; }
    if (this.scriptModels) { this.scriptModels.dispose(); this.scriptModels = null; }
    if (this.auditTimer) { clearInterval(this.auditTimer); this.auditTimer = null; }
    if (this.sound) { this.sound.dispose(); this.sound = null; }
    if (this.offArm) this.offArm();
    this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.renderer.dispose();
    this.renderer.forceContextLoss();          // free the GPU memory when the next demo is opened
    this.stage.remove();
  }
}
