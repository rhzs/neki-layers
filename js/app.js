// App shell: stage navigation, hash routing, and the per-stage scaffold every
// simulation mounts into. Each stage module default-exports
// { id, nav, kicker, title, lede, facts, mount(ctx) }.
import { h, createClock, createLog, createStatus, segmented } from './core.js';
import overview from './stages/overview.js';
import client from './stages/client.js';
import routing from './stages/routing.js';
import topology from './stages/topology.js';
import shards from './stages/shards.js';
import control from './stages/control.js';
import replicator from './stages/replicator.js';
import platform from './stages/platform.js';

const STAGES = [overview, client, routing, topology, shards, control, replicator, platform];

const main = document.getElementById('stage');
const navList = document.getElementById('stage-nav');
const pauseBtn = document.getElementById('pause-btn');
const settings = { speed: 1, paused: false };
let current = null;

const speed = segmented({
  label: '',
  options: [{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }],
  value: 1,
  onChange: (v) => { settings.speed = v; if (current) current.clock.speed = v; },
});
document.getElementById('speed').replaceWith(speed.el);
speed.el.id = 'speed';
speed.el.setAttribute('aria-label', 'Simulation speed');

pauseBtn.addEventListener('click', () => {
  settings.paused = !settings.paused;
  pauseBtn.textContent = settings.paused ? 'Resume' : 'Pause';
  pauseBtn.setAttribute('aria-pressed', String(settings.paused));
  if (current) current.clock.paused = settings.paused;
});

STAGES.forEach((st, i) => {
  navList.append(h('li', {}, h('a', { href: `#/${st.id}`, 'data-id': st.id },
    h('span', { class: 'num', text: String(i) }), st.nav)));
});

function unmount() {
  if (!current) return;
  for (const fn of current.cleanups) { try { fn(); } catch (e) { console.error(e); } }
  current.clock.dispose();
  current = null;
}

function render() {
  const id = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const idx = Math.max(0, STAGES.findIndex((st) => st.id === id));
  const st = STAGES[idx];
  unmount();

  for (const a of navList.querySelectorAll('a')) {
    if (a.dataset.id === st.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const active = navList.querySelector('[aria-current="page"]');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const clock = createClock();
  clock.speed = settings.speed;
  clock.paused = settings.paused;

  const toolbar = h('div', { class: 'toolbar' });
  const viz = h('div', { class: 'viz' });
  const readout = h('div', { class: 'readout' });
  const extra = h('div', { class: 'extra' });
  const narration = h('div', { class: 'narration', 'aria-live': 'polite' });
  const statusEl = h('div');
  const logEl = h('ol', { class: 'log' });
  const prev = STAGES[idx - 1], next = STAGES[idx + 1];

  const page = h('div', { class: 'stage' },
    h('section', { class: 'stage-head' },
      h('div', { class: 'kicker', text: `Stage ${idx} of ${STAGES.length - 1} · ${st.kicker}` }),
      h('h1', { text: st.title }),
      h('p', { class: 'lede', text: st.lede })),
    h('div', { class: 'stage-body' },
      h('div', { class: 'panel viz-col' }, toolbar, viz, readout, extra),
      h('aside', { class: 'side' },
        h('section', { class: 'panel' }, h('h2', { text: "What's happening" }), narration),
        h('section', { class: 'panel' }, h('h2', { text: 'Your app sees' }), statusEl),
        h('section', { class: 'panel' }, h('h2', { text: 'Event log' }), logEl),
        st.facts && st.facts.length ? h('section', { class: 'panel' }, h('h2', { text: 'From the docs' }),
          h('ul', { class: 'facts' }, st.facts.map((f) => h('li', {},
            f.text, ' ', f.href ? h('a', { href: f.href, target: '_blank', rel: 'noopener', text: 'Source' }) : null)))) : null)),
    h('nav', { class: 'stage-foot', 'aria-label': 'Previous and next stage' },
      prev ? h('a', { href: `#/${prev.id}` }, h('small', { text: 'Previous' }), prev.nav) : null,
      next ? h('a', { class: 'next', href: `#/${next.id}` }, h('small', { text: 'Next' }), next.nav) : null));

  main.replaceChildren(page);
  document.title = st.id === 'overview' ? 'Neki, layer by layer' : `${st.title} · Neki, layer by layer`;

  current = { clock, cleanups: [] };
  const ctx = {
    clock, toolbar, viz, readout, extra,
    log: createLog(logEl, clock),
    status: createStatus(statusEl),
    narrate(html) { narration.innerHTML = html; },
    onCleanup(fn) { current.cleanups.push(fn); },
    go(stageId) { location.hash = `#/${stageId}`; },
  };
  try {
    const ret = st.mount(ctx);
    if (typeof ret === 'function') current.cleanups.push(ret);
  } catch (e) {
    console.error(e);
    viz.append(h('p', { text: `This simulation failed to start: ${e.message}` }));
  }
}

window.addEventListener('hashchange', () => { render(); main.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); });
render();
