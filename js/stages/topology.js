// Stage 3 · Data topology. Route a tenant_id through a shard index and key ranges,
// watch rows spread across shards, split a range, and compare GSI vs scatter lookups.
import {
  h, s, scene, node, edge, packet, text, button, toggle, textInput, group, metric, fnv1a, hex, rng,
} from '../core.js';

const BAR = { x0: 80, x1: 880, y: 150, h: 40 };
const SHARD_Y = 300, SHARD_H = 70;
const LETTERS = ['B', 'C', 'D', 'E', 'F', 'G'];
const byteOf = (tenant) => fnv1a(String(tenant)) >>> 24;
const xOf = (byte) => BAR.x0 + ((BAR.x1 - BAR.x0) * byte) / 256;
const hex2 = (n) => n.toString(16).padStart(2, '0');

export default {
  id: 'topology',
  nav: 'Data topology',
  kicker: 'Layer 3 · Logical placement',
  title: 'Where does a row live?',
  lede: 'A shard index turns column values into a routing value. Key ranges map routing values to shards. '
    + 'Route a tenant, pour in rows, split a range, and see why lookups without the shard key fan out.',
  facts: [
    { text: 'A shard index turns values from table columns into routing values; key ranges assign parts of that space to shards.', href: 'https://planetscale.com/docs/neki/terminology' },
    { text: 'Provisioning a shard adds capacity. It does not move rows: the data topology controls placement.', href: 'https://planetscale.com/docs/neki/terminology' },
    { text: 'A GSI maps another key to the owner row’s shard key, so the router can avoid a scatter.', href: 'https://planetscale.com/docs/neki/reference-tables-and-gsis' },
    { text: 'Reference tables keep a copy of the same rows in several shard groups for local joins.', href: 'https://planetscale.com/docs/neki/reference-tables-and-gsis' },
    { text: 'Once data is sharded, keep the authoritative shard group on its own shard.', href: 'https://planetscale.com/docs/neki/best-practices' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(7);
    let ranges, rows, gsi = false, refTable = false, live = false, stopLive = null, lastMoved = 0;

    // ---------- scene: static parts ----------
    const sc = scene(ctx.viz, 960, 540, 'Data topology: shard index, key ranges and shards');
    const router = node(sc, { x: 40, y: 40, w: 150, h: 60, title: 'Router', sub: 'cached topology', kind: 'router' });
    const hashN = node(sc, { x: 230, y: 40, w: 220, h: 60, title: 'Shard index', sub: 'hash(tenant_id)' });
    const valueN = node(sc, { x: 490, y: 40, w: 200, h: 60, title: 'Routing value', sub: '—' });
    const gsiN = node(sc, { x: 750, y: 40, w: 170, h: 60, title: 'GSI lookup', sub: 'email → tenant_id', kind: 'ghost' });
    edge(sc, [router.right, [hashN.x - 4, 70]], { kind: 'muted' });
    edge(sc, [hashN.right, [valueN.x - 4, 70]], { kind: 'muted' });
    text(sc, BAR.x0, BAR.y - 12, 'Routing space 00–ff · key ranges of the tenant_data shard group', { cls: 'label' });
    for (const b of [0, 64, 128, 192]) text(sc, xOf(b), BAR.y + BAR.h + 18, hex2(b), { cls: 'text mono', anchor: 'middle' });
    text(sc, BAR.x1, BAR.y + BAR.h + 18, 'ff', { cls: 'text mono', anchor: 'middle' });
    text(sc, 80, 440, 'Authoritative shard group', { cls: 'label' });
    const shardA = node(sc, { x: 80, y: 452, w: 230, h: 64, title: 'Shard A', sub: 'catalog, sequences, unsharded tables', kind: 'shard' });
    const note = text(sc, 340, 488, '', { cls: 'text' });
    const markerG = s('g', { opacity: 0 }, sc.labels);
    s('line', { x1: 0, y1: BAR.y - 10, x2: 0, y2: BAR.y + BAR.h + 4, class: 'marker-line' }, markerG);
    s('path', { d: `M -6 ${BAR.y - 18} L 6 ${BAR.y - 18} L 0 ${BAR.y - 8} Z`, class: 'marker-head' }, markerG);
    const dynEdges = s('g', {}, sc.edges);
    const dynNodes = s('g', {}, sc.nodes);
    let shardNodes = {}, rangeEls = [], shareBars = {};

    // ---------- state ----------
    function reset() {
      ranges = [{ start: 0, end: 128, shard: 'B' }, { start: 128, end: 256, shard: 'C' }];
      rows = [];
      lastMoved = 0;
      note.textContent = '';
      draw();
    }
    const shardOf = (byte) => ranges.find((r) => byte >= r.start && byte < r.end).shard;
    const counts = () => {
      const c = Object.fromEntries(ranges.map((r) => [r.shard, 0]));
      for (const r of rows) c[shardOf(r.byte)]++;
      return c;
    };

    function draw() {
      dynEdges.textContent = '';
      dynNodes.textContent = '';
      shardNodes = {};
      rangeEls = [];
      shareBars = {};
      const names = [...new Set(ranges.map((r) => r.shard))]; // key order, so edges do not cross
      const gap = 20, w = Math.min(150, (800 - gap * (names.length - 1)) / names.length);
      const total = names.length * w + (names.length - 1) * gap;
      const left = BAR.x0 + (800 - total) / 2;
      names.forEach((name, i) => {
        shardNodes[name] = node(sc, { x: left + i * (w + gap), y: SHARD_Y, w, h: SHARD_H, title: `Shard ${name}`, sub: '0 rows', kind: 'shard', layer: dynNodes });
        const bg = s('rect', { x: left + i * (w + gap), y: SHARD_Y + SHARD_H + 12, width: w, height: 8, rx: 4, class: 'bar-bg' }, dynNodes);
        shareBars[name] = s('rect', { x: bg.getAttribute('x'), y: SHARD_Y + SHARD_H + 12, width: 0, height: 8, rx: 4, class: 'bar--query' }, dynNodes);
        if (refTable) shardNodes[name].tag('countries', 'control');
      });
      ranges.forEach((r, i) => {
        const g = s('g', { class: `range${i % 2 ? ' range--alt' : ''}` }, dynNodes);
        const x = xOf(r.start), wpx = xOf(r.end) - x;
        s('rect', { x, y: BAR.y, width: wpx, height: BAR.h, rx: 4 }, g);
        s('text', { x: x + wpx / 2, y: BAR.y + 25, 'text-anchor': 'middle', text: wpx > 70 ? `${r.shard} · ${hex2(r.start)}–${hex2(r.end - 1)}` : r.shard }, g);
        rangeEls.push(g);
        const target = shardNodes[r.shard];
        edge(sc, [[x + wpx / 2, BAR.y + BAR.h], [target.cx, SHARD_Y - 4]], { kind: 'muted', layer: dynEdges });
      });
      shardA.tag(refTable ? 'countries' : null, 'control');
      gsiN.g.setAttribute('class', `node node--${gsi ? 'control' : 'ghost'}`);
      gsiN.setSub(gsi ? 'email → tenant_id' : 'off: no GSI');
      refreshCounts();
    }

    function refreshCounts() {
      const c = counts();
      const max = Math.max(1, ...Object.values(c));
      for (const [name, n] of Object.entries(c)) {
        shardNodes[name].setSub(`${n.toLocaleString()} rows`);
        const bg = Number(shareBars[name].previousSibling.getAttribute('width'));
        shareBars[name].setAttribute('width', (bg * n) / max);
      }
      mRows.set(rows.length.toLocaleString());
      mShards.set(String(Object.keys(c).length));
      const share = rows.length ? Math.round((100 * Math.max(...Object.values(c))) / rows.length) : 0;
      mShare.set(rows.length ? `${share}%` : '—', share > 70 ? 'warn' : null);
      mMoved.set(lastMoved ? lastMoved.toLocaleString() : '—');
    }

    function flashRange(byte, state = 'hit') {
      rangeEls.forEach((g, i) => {
        const r = ranges[i];
        if (byte >= r.start && byte < r.end) { g.dataset.state = state; clock.after(900, () => { delete g.dataset.state; }); }
      });
    }
    function showMarker(byte) {
      markerG.setAttribute('transform', `translate(${xOf(byte)},0)`);
      markerG.setAttribute('opacity', 1);
    }

    // ---------- actions ----------
    function routeTenant(tenant, { animate = true, insert = false } = {}) {
      const hv = fnv1a(String(tenant));
      const byte = hv >>> 24;
      const target = shardNodes[shardOf(byte)];
      const finish = () => {
        flashRange(byte);
        target.setState('active');
        clock.after(700, () => target.setState(null));
        if (insert) { rows.push({ tenant, byte }); refreshCounts(); }
      };
      if (!animate) { packet(sc, clock, [[xOf(byte), BAR.y + BAR.h], target.top], { duration: 450, r: 4, onDone: finish }); return; }
      ctx.narrate(`<p>Routing <code>tenant_id = ${tenant}</code>. The router hashes the shard-index column…</p>`);
      packet(sc, clock, [router.right, hashN.left], { duration: 500, onDone: () => {
        hashN.setSub(`hash("${tenant}") = 0x${hex(hv)}`);
        hashN.setState('active');
        packet(sc, clock, [hashN.right, valueN.left], { duration: 500, onDone: () => {
          hashN.setState(null);
          valueN.setSub(`0x${hex2(byte)}… → range`);
          valueN.setState('active');
          packet(sc, clock, [valueN.bottom, [valueN.cx, 125], [xOf(byte), 125], [xOf(byte), BAR.y]], { duration: 600, onDone: () => {
            valueN.setState(null);
            showMarker(byte);
            flashRange(byte);
            const r = ranges.find((q) => byte >= q.start && byte < q.end);
            packet(sc, clock, [[xOf(byte), BAR.y + BAR.h], target.top], { duration: 600, onDone: () => {
              finish();
              ctx.narrate(`<p><code>tenant_id = ${tenant}</code> hashes to <code>0x${hex(hv)}</code>. Its first byte, <code>${hex2(byte)}</code>, falls in key range <code>${hex2(r.start)}–${hex2(r.end - 1)}</code>, which belongs to <b>shard ${r.shard}</b>.</p><p>The same value always lands on the same shard, so a query with <code>WHERE tenant_id = ${tenant}</code> needs only that shard.</p>`);
              log.add(`tenant_id ${tenant} → 0x${hex2(byte)} → shard ${r.shard}`, 'query');
            } });
          } });
        } });
      } });
    }

    function insertBatch(n) {
      for (let i = 0; i < n; i++) {
        const tenant = 1000 + Math.floor(rand() * 90000);
        clock.after(i * 40, () => routeTenant(tenant, { animate: false, insert: true }));
      }
      log.add(`Inserted ${n} rows with random tenant_id values`, 'query');
      ctx.narrate(`<p>${n} rows arrive with random <code>tenant_id</code> values. Hashing spreads them across the key ranges, so each shard gets a share close to its slice of the routing space.</p>`);
    }

    function setLive(on) {
      live = on;
      if (stopLive) { stopLive(); stopLive = null; }
      if (on) {
        stopLive = clock.every(250, () => routeTenant(1000 + Math.floor(rand() * 90000), { animate: false, insert: true }));
        status.set('normal', 'Normal: inserts flow to their owning shards');
        log.add('Live inserts on', 'query');
      } else log.add('Live inserts off', 'query');
    }

    function splitLargest() {
      const names = new Set(ranges.map((r) => r.shard));
      const nextName = LETTERS.find((l) => !names.has(l));
      if (!nextName) { log.add('This demo stops at six data shards', 'info'); return; }
      const c = counts();
      const victim = [...ranges].sort((a, b) => (b.end - b.start) - (a.end - a.start) || c[b.shard] - c[a.shard])[0];
      const mid = victim.start + Math.floor((victim.end - victim.start) / 2);
      const moving = rows.filter((r) => r.byte >= mid && r.byte < victim.end).length;
      const idx = ranges.indexOf(victim);
      ranges.splice(idx, 1, { start: victim.start, end: mid, shard: victim.shard }, { start: mid, end: victim.end, shard: nextName });
      lastMoved = moving;
      draw();
      rangeEls[idx + 1].dataset.state = 'new';
      clock.after(1600, () => { if (rangeEls[idx + 1]) delete rangeEls[idx + 1].dataset.state; });
      note.textContent = `Split ${hex2(mid)}–${hex2(victim.end - 1)} off shard ${victim.shard}: ${moving.toLocaleString()} of ${rows.length.toLocaleString()} rows must move to shard ${nextName}.`;
      log.add(`Key range ${hex2(mid)}–${hex2(victim.end - 1)} reassigned from ${victim.shard} to ${nextName}; ${moving} rows to move`, 'mgmt');
      ctx.narrate(`<p>Shard <b>${nextName}</b> now owns key range <code>${hex2(mid)}–${hex2(victim.end - 1)}</code>, taken from shard ${victim.shard}.</p><p>This demo reassigns the range in one go. In real Neki, adding a shard moves nothing by itself: a Reshard workflow copies the ${moving.toLocaleString()} affected rows while traffic keeps flowing, and only then switches the range. See <a href="#/replicator">Stage 6</a>.</p>`);
    }

    function findByEmail() {
      const names = Object.keys(shardNodes);
      const tenant = 1000 + Math.floor(rand() * 90000);
      if (gsi) {
        ctx.narrate('<p><code>WHERE email = \'ana@example.com\'</code> has no shard key, but a GSI maps email to <code>tenant_id</code>. The router reads the lookup first…</p>');
        gsiN.setState('active');
        const path = [router.top, [router.cx, 18], [gsiN.cx, 18], gsiN.top];
        packet(sc, clock, path, { kind: 'control', duration: 700, onDone: () => {
          gsiN.setSub(`ana@… → ${tenant}`);
          packet(sc, clock, [...path].reverse(), { kind: 'control', duration: 700, onDone: () => {
            gsiN.setState(null);
            routeTenant(tenant);
            status.set('normal', 'Normal: one lookup, then one shard');
            log.add(`GSI lookup email → tenant_id ${tenant}, then a single-shard route`, 'query');
            mFan.set('1 shard', 'good');
          } });
        } });
      } else {
        ctx.narrate(`<p>No shard-key predicate and no GSI: the router cannot tell which shard holds the row, so it asks <b>all ${names.length}</b> shards in the group (<code>Route [Scatter]</code>).</p><p>Turn on the GSI and try again.</p>`);
        for (const name of names) {
          const t = shardNodes[name];
          packet(sc, clock, [router.left, [24, router.cy], [24, 250], [t.cx, 250], t.top], { duration: 1100, onDone: () => {
            t.setState('active'); clock.after(600, () => t.setState(null));
          } });
        }
        status.set('normal', `Normal, but this query touched ${names.length} shards`);
        log.add(`Lookup by email scattered to ${names.length} shards`, 'query');
        mFan.set(`${names.length} shards`, 'warn');
      }
    }

    // ---------- controls ----------
    const tenantIn = textInput({ label: 'tenant_id', value: '4821', width: 110 });
    ctx.toolbar.append(
      group('Route a row', tenantIn, button('Route it', () => routeTenant(tenantIn.value.trim() || '0'), { variant: 'primary', icon: 'send' })),
      group('Traffic',
        toggle({ label: 'Live inserts', onChange: setLive }),
        button('Insert 50', () => insertBatch(50), { icon: 'plus' })),
      group('Topology',
        button('Add shard', splitLargest, { variant: 'control', icon: 'plus', title: 'Split the largest key range onto a new shard' }),
        button('Reset', () => { if (live) { setLive(false); liveToggle(); } reset(); log.add('Topology reset to two shards', 'mgmt'); }, { icon: 'restart' })),
      group('Lookups',
        toggle({ label: 'GSI on email', onChange: (v) => { gsi = v; draw(); log.add(`GSI ${v ? 'enabled' : 'disabled'}`, 'mgmt'); } }),
        toggle({ label: 'Reference table', onChange: (v) => { refTable = v; draw(); log.add(v ? 'countries copied into every shard group' : 'Reference table removed', 'mgmt'); ctx.narrate(v ? '<p>The <code>countries</code> reference table now has a copy in every shard group, so joins from tenant rows to countries stay local to each shard.</p>' : '<p>Reference table removed.</p>'); } }),
        button('Find by email', findByEmail)),
    );
    const liveToggle = () => { const cb = ctx.toolbar.querySelector('.toggle input'); if (cb) cb.checked = false; };

    const mRows = metric('Rows'), mShards = metric('Data shards'), mShare = metric('Largest share'), mMoved = metric('Rows to move'), mFan = metric('Last lookup');
    ctx.readout.append(mRows.el, mShards.el, mShare.el, mMoved.el, mFan.el);

    ctx.extra.append(h('p', { class: 'text', style: { margin: 0, fontSize: '13px', color: 'var(--faint)' } },
      'Neki shard indexes use xxhash. This page uses FNV-1a so the demo runs in your browser; the routing idea is the same.'));

    reset();
    status.set('na', 'Your app is not involved until it sends a query');
    ctx.narrate('<p>Two data shards split the routing space in half. Press <b>Route it</b> to follow one tenant, or <b>Insert 50</b> to watch rows spread out.</p>');
    clock.after(600, () => routeTenant('4821'));
  },
};
