// Shared building blocks for every stage: DOM and SVG builders, a pausable simulated
// clock, packet animation, form controls, and the status / log / chart widgets.

export const SVGNS = 'http://www.w3.org/2000/svg';
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- DOM ----------
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

// ---------- SVG ----------
export function s(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  if (parent) parent.append(el);
  return el;
}

let sceneSeq = 0;
const KINDS = ['query', 'control', 'mgmt', 'muted', 'danger'];

// A responsive SVG with paint-ordered layers: bg < edges < nodes < packets < labels.
export function scene(container, w, hgt, label) {
  const id = `sc${++sceneSeq}`;
  const svg = s('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'scene', role: 'img', 'aria-label': label });
  const defs = s('defs', {}, svg);
  for (const kind of KINDS) {
    const m = s('marker', { id: `${id}-${kind}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6,
      orient: 'auto-start-reverse' }, defs);
    s('path', { d: 'M0 0 L10 5 L0 10 z', class: `arrowhead arrowhead--${kind}` }, m);
  }
  const sc = {
    svg, w, h: hgt,
    bg: s('g', {}, svg), edges: s('g', {}, svg), nodes: s('g', {}, svg), packets: s('g', {}, svg), labels: s('g', {}, svg),
    marker: (kind) => `${id}-${kind}`,
  };
  container.append(svg);
  return sc;
}

// A box with a title and optional subtitle. `kind` picks the style (client, router, pg,
// sidecar, pm, control, mgmt, shard, band, ghost). Returns handles and anchor points.
export function node(sc, { x, y, w, h: ht, title = '', sub, kind = 'default', rx = 10, layer, onClick, label }) {
  const g = s('g', { class: `node node--${kind}`, transform: `translate(${x},${y})` }, layer || sc.nodes);
  const rect = s('rect', { width: w, height: ht, rx }, g);
  const hasSub = sub != null && sub !== '';
  const t = s('text', { x: w / 2, y: hasSub ? ht / 2 - 3 : ht / 2 + 5, 'text-anchor': 'middle', class: 'node-title', text: title }, g);
  const st = s('text', { x: w / 2, y: ht / 2 + 15, 'text-anchor': 'middle', class: 'node-sub', text: hasSub ? sub : '' }, g);
  let tagEl = null;
  if (onClick) {
    g.dataset.clickable = '';
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', label || title);
    g.addEventListener('click', onClick);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } });
  }
  return {
    g, rect, x, y, w, h: ht,
    cx: x + w / 2, cy: y + ht / 2,
    top: [x + w / 2, y], bottom: [x + w / 2, y + ht], left: [x, y + ht / 2], right: [x + w, y + ht / 2],
    at: (fx, fy) => [x + w * fx, y + ht * fy],
    setState(state) { if (state) g.dataset.state = state; else delete g.dataset.state; },
    setTitle(v) { t.textContent = v; },
    setSub(v) {
      st.textContent = v || '';
      t.setAttribute('y', v ? ht / 2 - 3 : ht / 2 + 5);
    },
    // A small pill pinned to the top-right corner. tag(null) removes it.
    tag(text, kind2 = 'ink') {
      if (tagEl) { tagEl.remove(); tagEl = null; }
      if (!text) return;
      const tw = Math.max(36, text.length * 6.6 + 16);
      tagEl = s('g', { class: `tag tag--${kind2}`, transform: `translate(${w - tw + 8},-10)` }, g);
      s('rect', { width: tw, height: 20, rx: 10 }, tagEl);
      s('text', { x: tw / 2, y: 14, 'text-anchor': 'middle', text }, tagEl);
    },
  };
}

// A polyline with an optional arrow head. kind: query | control | mgmt | muted | danger.
export function edge(sc, points, { kind = 'query', dashed = false, arrow = true, layer } = {}) {
  const path = s('path', {
    d: pathD(points),
    class: `edge edge--${kind}${dashed ? ' edge--dashed' : ''}`,
    'marker-end': arrow ? `url(#${sc.marker(kind)})` : null,
  }, layer || sc.edges);
  return {
    path, points,
    setState(state) { if (state) path.dataset.state = state; else delete path.dataset.state; },
    setKind(k) {
      path.setAttribute('class', `edge edge--${k}${dashed ? ' edge--dashed' : ''}`);
      if (arrow) path.setAttribute('marker-end', `url(#${sc.marker(k)})`);
    },
    remove() { path.remove(); },
  };
}

export const pathD = (pts) => 'M ' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L ');

// Right-angle route from a to b through a horizontal lane at y = viaY.
export const viaY = (a, b, y) => [a, [a[0], y], [b[0], y], b];
// Right-angle route from a to b through a vertical lane at x = viaX.
export const viaX = (a, b, x) => [a, [x, a[1]], [x, b[1]], b];
// Stop `gap` px before the end so arrow heads do not overlap the target.
export function shorten(points, gap = 4) {
  const p = points.map((q) => [...q]);
  const n = p.length - 1;
  const [x1, y1] = p[n - 1], [x2, y2] = p[n];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  p[n] = [x2 - ((x2 - x1) / len) * gap, y2 - ((y2 - y1) / len) * gap];
  return p;
}

export function text(sc, x, y, str, { cls = 'text', anchor = 'start', layer } = {}) {
  return s('text', { x, y, class: cls, 'text-anchor': anchor, text: str }, layer || sc.labels);
}

// ---------- simulated clock ----------
// Every stage gets its own clock. Pausing or changing speed affects timers and packets alike.
export function createClock() {
  let now = 0, speed = 1, paused = false, last = null, raf = 0, disposed = false;
  const timers = new Set();
  const frames = new Set();
  function loop(t) {
    if (disposed) return;
    if (last == null) last = t;
    const dt = Math.min(100, t - last);
    last = t;
    if (!paused && !document.hidden) {
      now += dt * speed;
      for (const tm of [...timers]) {
        if (!timers.has(tm) || now < tm.at) continue;
        if (tm.every) { tm.at += tm.every; if (tm.at <= now) tm.at = now + tm.every; } else timers.delete(tm);
        try { tm.fn(now); } catch (e) { console.error(e); }
      }
      for (const f of [...frames]) { try { f(now, dt * speed); } catch (e) { console.error(e); } }
    }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  return {
    get now() { return now; },
    get speed() { return speed; }, set speed(v) { speed = v; },
    get paused() { return paused; }, set paused(v) { paused = v; },
    after(ms, fn) { const tm = { at: now + ms, fn }; timers.add(tm); return () => timers.delete(tm); },
    every(ms, fn, { immediate = false } = {}) {
      const tm = { at: now + (immediate ? 0 : ms), every: ms, fn }; timers.add(tm); return () => timers.delete(tm);
    },
    frame(fn) { frames.add(fn); return () => frames.delete(fn); },
    // Cancel every pending timer and frame callback (use when restarting a simulation).
    reset() { timers.clear(); frames.clear(); },
    dispose() { disposed = true; cancelAnimationFrame(raf); timers.clear(); frames.clear(); },
  };
}

// A dot that travels along a polyline at constant speed, then calls onDone.
// kind: query | control | mgmt | danger. Durations are simulated milliseconds.
export function packet(sc, clock, points, { kind = 'query', duration = 900, r = 6, onDone } = {}) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    segs.push({ x1, y1, x2, y2, len, start: total });
    total += len;
  }
  const c = s('circle', { r, cx: points[0][0], cy: points[0][1], class: `packet packet--${kind}` }, sc.packets);
  const start = clock.now;
  const dur = reducedMotion() ? 1 : duration;
  let done = false;
  const stop = clock.frame((now) => {
    const t = Math.min(1, (now - start) / dur);
    const d = t * total;
    const sg = segs.find((q) => d <= q.start + q.len) || segs[segs.length - 1];
    const f = sg && sg.len ? (d - sg.start) / sg.len : 1;
    if (sg) { c.setAttribute('cx', sg.x1 + (sg.x2 - sg.x1) * f); c.setAttribute('cy', sg.y1 + (sg.y2 - sg.y1) * f); }
    if (t >= 1 && !done) { done = true; stop(); c.remove(); if (onDone) onDone(); }
  });
  return { el: c, cancel() { done = true; stop(); c.remove(); } };
}

// ---------- controls ----------
export function button(label, onClick, { variant = 'secondary', title, disabled, icon } = {}) {
  const b = h('button', { type: 'button', class: `btn btn--${variant}`, title, onClick }, icon ? iconSvg(icon) : null, label);
  if (disabled) b.disabled = true;
  return b;
}

export function slider({ label, min, max, step = 1, value, unit = '', format, onInput }) {
  const fmt = format || ((v) => `${v}${unit}`);
  const input = h('input', { type: 'range', min, max, step, value });
  const out = h('output', { text: fmt(Number(value)) });
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); if (onInput) onInput(Number(input.value)); });
  const el = h('label', { class: 'ctl' }, h('span', { class: 'ctl-label' }, h('span', { text: label }), out), input);
  return { el, input, get value() { return Number(input.value); }, set(v) { input.value = v; out.textContent = fmt(Number(v)); } };
}

export function select({ label, options, value, onChange }) {
  const sel = h('select', {}, options.map((o) => h('option', { value: o.value, text: o.label })));
  sel.value = value;
  sel.addEventListener('change', () => onChange && onChange(sel.value));
  const el = h('label', { class: 'ctl' }, h('span', { class: 'ctl-label', text: label }), sel);
  return { el, input: sel, get value() { return sel.value; }, set(v) { sel.value = v; } };
}

export function toggle({ label, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  const el = h('label', { class: 'ctl toggle' }, input, h('span', { text: label }));
  return { el, input, get value() { return input.checked; }, set(v) { input.checked = v; } };
}

export function segmented({ label, options, value, onChange }) {
  const wrap = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  let cur = value;
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', text: o.label, 'aria-pressed': String(o.value === value) });
    b.addEventListener('click', () => { api.set(o.value); if (onChange) onChange(o.value); });
    wrap.append(b);
    return [o.value, b];
  });
  const el = label ? h('div', { class: 'ctl' }, h('span', { class: 'ctl-label', text: label }), wrap) : wrap;
  const api = {
    el, get value() { return cur; },
    set(v) { cur = v; for (const [val, b] of btns) b.setAttribute('aria-pressed', String(val === v)); },
  };
  return api;
}

export function textInput({ label, value = '', width, onChange, type = 'text' }) {
  const input = h('input', { type, value, style: width ? { width: `${width}px` } : null });
  input.addEventListener('change', () => onChange && onChange(input.value));
  const el = h('label', { class: 'ctl' }, h('span', { class: 'ctl-label', text: label }), input);
  return { el, input, get value() { return input.value; }, set(v) { input.value = v; } };
}

// A titled cluster of controls for the toolbar.
export function group(title, ...controls) {
  return h('div', { class: 'ctl-group' }, title ? h('div', { class: 'ctl-group__title', text: title }) : null,
    controls.flat().map((c) => (c && c.el) ? c.el : c));
}

const ICONS = {
  play: '<path d="M7 5 L19 12 L7 19 Z"/>',
  pause: '<path d="M9 5 L9 19"/><path d="M15 5 L15 19"/>',
  restart: '<path d="M4 12 A8 8 0 1 0 7 5.8"/><path d="M4 4 L4 9 L9 9"/>',
  zap: '<path d="M13 3 L5 14 L12 14 L11 21 L19 10 L12 10 Z"/>',
  plus: '<path d="M12 5 L12 19"/><path d="M5 12 L19 12"/>',
  x: '<path d="M6 6 L18 18"/><path d="M18 6 L6 18"/>',
  send: '<path d="M4 12 L20 4 L14 20 L11 13 Z"/>',
  next: '<path d="M9 6 L15 12 L9 18"/>',
  prev: '<path d="M15 6 L9 12 L15 18"/>',
};
export function iconSvg(name, size = 16) {
  const el = s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  el.innerHTML = ICONS[name] || '';
  return el;
}

// ---------- widgets ----------
export function metric(label, value = '—', tone) {
  const v = h('span', { class: 'metric__value', text: value });
  const el = h('div', { class: 'metric' }, h('span', { class: 'metric__label', text: label }), v);
  if (tone) el.dataset.tone = tone;
  return {
    el,
    set(val, tone2) { v.textContent = val; if (tone2) el.dataset.tone = tone2; else delete el.dataset.tone; },
  };
}

export function createLog(listEl, clock, max = 80) {
  return {
    add(textStr, kind = 'info') {
      const t = (clock.now / 1000).toFixed(1);
      listEl.prepend(h('li', { 'data-kind': kind }, h('time', { text: `${t}s` }), h('span', { text: textStr })));
      while (listEl.children.length > max) listEl.lastChild.remove();
    },
    clear() { listEl.textContent = ''; },
  };
}

const STATUS_TEXT = {
  normal: 'Normal: queries run as usual',
  slower: 'Slower: queries are held, not failed',
  error: 'Errors: some queries fail',
  down: 'Disconnected: the connection dropped',
  na: 'Your app is not involved here',
};
export function createStatus(el) {
  const dot = h('span', { class: 'status__dot', 'aria-hidden': 'true' });
  const label = h('span');
  el.classList.add('status');
  el.append(dot, label);
  const api = {
    state: 'na',
    set(state, textStr) { api.state = state; el.dataset.state = state; label.textContent = textStr || STATUS_TEXT[state] || state; },
  };
  api.set('na');
  return api;
}

// Rolling bar chart of what the app experiences: push(latencyMs, 'ok' | 'slow' | 'error' | 'idle').
export function createChart(container, { label = 'App latency', max = 1000, unit = 'ms', bars = 60 } = {}) {
  const W = 600, H = 120, P = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': label });
  s('line', { x1: 0, y1: H - P, x2: W, y2: H - P, class: 'axis' }, svg);
  s('text', { x: 0, y: 12, text: `${label} (${unit})` }, svg);
  s('text', { x: W, y: 12, 'text-anchor': 'end', text: `max ${max}` }, svg);
  const g = s('g', {}, svg);
  const data = [];
  container.append(svg);
  const bw = W / bars;
  function draw() {
    g.textContent = '';
    data.forEach((d, i) => {
      const v = d.state === 'error' ? max : Math.min(max, d.v);
      const hh = Math.max(2, ((H - P - 18) * v) / max);
      s('rect', { x: i * bw + 1, y: H - P - hh, width: bw - 2, height: hh, rx: 1.5, class: `bar--${d.state}` }, g);
    });
  }
  return {
    el: svg,
    push(v, state = 'ok') { data.push({ v, state }); if (data.length > bars) data.shift(); draw(); },
    clear() { data.length = 0; draw(); },
  };
}

// ---------- maths ----------
// FNV-1a, 32-bit. Neki uses xxhash shard indexes; this demo uses FNV-1a only to illustrate.
export function fnv1a(str) {
  let x = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return x >>> 0;
}
export const hex = (n, width = 8) => (n >>> 0).toString(16).padStart(width, '0');

export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
