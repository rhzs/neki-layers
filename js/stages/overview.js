// Stage 0 · Overview. The whole cluster as layers, alive: queries flow down, the control
// plane checks health and syncs topology, the operator reconciles. Click a layer to open it.
import { h, s, scene, node, edge, packet, text, button, slider, segmented, group, metric, rng } from '../core.js';

const C1 = 250, C2 = 420, C3 = 580;            // column centres: A / B / C and apps, routers
const BAND_X = 16, BAND_W = 656;
const BANDS = [
  { id: 'client', y: 16, h: 80, eyebrow: 'Layer 1', name: 'Client',
    about: 'Apps use any Postgres driver and one connection string. They never learn about shards.' },
  { id: 'routing', y: 112, h: 84, eyebrow: 'Layer 2', name: 'Routing',
    about: 'Stateless routers parse, plan and route every statement, and combine results from several shards.' },
  { id: 'topology', y: 212, h: 64, eyebrow: 'Layer 3', name: 'Data topology',
    about: 'The routing map: a shard index turns a key into a routing value, and key ranges map it to a shard.' },
  { id: 'shards', y: 292, h: 160, eyebrow: 'Layer 4', name: 'Shards',
    about: 'Real Postgres. Each shard is a primary plus replicas, with a Sidecar and a PostgresManager beside every instance.' },
  { id: 'platform', y: 468, h: 92, eyebrow: 'Layer 5', name: 'Platform',
    about: 'PlanetScale turns the configuration you ask for into running components, outside the SQL path.' },
];
const SHARDS = [{ id: 'A', cx: C1, note: 'authoritative' }, { id: 'B', cx: C2, note: '00–7f' }, { id: 'C', cx: C3, note: '80–ff' }];

export default {
  id: 'overview',
  nav: 'Overview',
  kicker: 'The whole cluster',
  title: 'Neki, layer by layer',
  lede: 'Neki is PlanetScale’s horizontally sharded Postgres. Your app sees one Postgres endpoint; behind it sit stateless routers, '
    + 'a routing map, real Postgres shards, a control plane and an orchestration layer. Everything below is moving. Click a layer to open its simulation.',
  facts: [
    { text: 'Neki puts a router between clients and Postgres nodes; it parses, plans and coordinates all Postgres traffic.', href: 'https://planetscale.com/docs/neki' },
    { text: 'A new database starts unsharded. You still get cluster management, zero-downtime upgrades and connection pooling.', href: 'https://planetscale.com/docs/neki' },
    { text: 'The topology service holds the data topology, the admin watches shard health, and the Replicator moves data.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Neki is in Platform Preview: a beta feature without an SLA.', href: 'https://planetscale.com/docs/neki' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(11);
    let mode = 'all', qps = 6, tracing = false, live = 0;
    let nQueries = 0, nHealth = 0, nSync = 0, nReconcile = 0;

    const sc = scene(ctx.viz, 960, 580, 'Neki cluster as layers with live traffic');
    const bandNodes = {};
    const describe = (b) => ctx.narrate(`<p><b>${b.eyebrow} · ${b.name}.</b> ${b.about}</p><p>Click to open its simulation.</p>`);

    for (const b of BANDS) {
      bandNodes[b.id] = node(sc, { x: BAND_X, y: b.y, w: BAND_W, h: b.h, kind: 'band', rx: 14, layer: sc.bg,
        onClick: () => ctx.go(b.id), label: `Open ${b.name}` });
      bandNodes[b.id].g.addEventListener('mouseenter', () => describe(b));
      bandNodes[b.id].g.addEventListener('focus', () => describe(b));
      text(sc, 32, b.y + 24, b.eyebrow, { cls: 'label', layer: sc.bg });
      text(sc, 32, b.y + 44, b.name, { cls: 'text text--strong', layer: sc.bg });
    }
    const cp = { eyebrow: 'Control plane', name: 'Admin, topology, Replicator',
      about: 'Off the query path: the topology service stores the routing map, the admin watches health and runs failover, the Replicator moves data.' };
    const cpBand = node(sc, { x: 690, y: 112, w: 254, h: 340, kind: 'band', rx: 14, layer: sc.bg,
      onClick: () => ctx.go('control'), label: 'Open the control plane' });
    cpBand.g.addEventListener('mouseenter', () => describe(cp));
    cpBand.g.addEventListener('focus', () => describe(cp));
    text(sc, 706, 134, 'Control plane', { cls: 'label', layer: sc.bg });

    const inert = (n) => { n.g.style.pointerEvents = 'none'; return n; };
    const apps = [C1, C2, C3].map((cx, i) => inert(node(sc, { x: cx - 65, y: 34, w: 130, h: 44, title: `App ${i + 1}`, kind: 'client' })));
    const routers = [C1, C2, C3].map((cx, i) => inert(node(sc, { x: cx - 65, y: 130, w: 130, h: 48, title: 'Router', sub: `zone ${'abc'[i]}`, kind: 'router' })));

    // Layer 3: key ranges above the data shards.
    const segs = {};
    text(sc, 190, 250, 'A holds catalog', { cls: 'text', layer: sc.labels });
    text(sc, 190, 266, 'and sequences', { cls: 'text', layer: sc.labels });
    for (const [id, x0, x1, label] of [['B', 340, 500, 'B · 00–7f'], ['C', 500, 660, 'C · 80–ff']]) {
      const g = s('g', { class: 'range', style: 'pointer-events:none' }, sc.nodes);
      s('rect', { x: x0, y: 228, width: x1 - x0, height: 32, rx: 4 }, g);
      s('text', { x: (x0 + x1) / 2, y: 249, 'text-anchor': 'middle', text: label }, g);
      segs[id] = g;
    }

    // Layer 4: three shards, each a primary and two replicas.
    const shardNodes = {};
    for (const sh of SHARDS) {
      shardNodes[sh.id] = inert(node(sc, { x: sh.cx - 75, y: 308, w: 150, h: 130, kind: 'shard', title: '' }));
      ['R', 'P', 'R'].forEach((role, i) => {
        inert(node(sc, { x: sh.cx - 60 + i * 42, y: 322, w: 36, h: 12, kind: 'sidecar', rx: 3 }));
        inert(node(sc, { x: sh.cx - 60 + i * 42, y: 334, w: 36, h: 46, kind: 'pg', title: role, rx: 0 }));
        inert(node(sc, { x: sh.cx - 60 + i * 42, y: 380, w: 36, h: 10, kind: 'pm', rx: 3 }));
      });
      text(sc, sh.cx, 414, `Shard ${sh.id}`, { cls: 'text text--strong', anchor: 'middle' });
      text(sc, sh.cx, 430, sh.note, { cls: 'text mono', anchor: 'middle' });
    }

    const topo = inert(node(sc, { x: 706, y: 150, w: 222, h: 50, title: 'Topology service', sub: 'routing map + discovery', kind: 'control' }));
    const admin = inert(node(sc, { x: 706, y: 250, w: 222, h: 50, title: 'Admin', sub: 'health, failover', kind: 'control' }));
    const repl = node(sc, { x: 706, y: 350, w: 222, h: 50, title: 'Replicator', sub: 'copy, then stream', kind: 'control',
      onClick: () => ctx.go('replicator'), label: 'Open the Replicator stage' });
    const ps = inert(node(sc, { x: 185, y: 488, w: 190, h: 52, title: 'PlanetScale app + API', sub: 'requested config', kind: 'client' }));
    const op = inert(node(sc, { x: 420, y: 488, w: 235, h: 52, title: 'Neki operator', sub: 'reconciles desired state', kind: 'mgmt' }));
    edge(sc, [ps.right, [op.x - 4, ps.cy]], { kind: 'mgmt', dashed: true });

    // ---------- flows ----------
    const busy = () => live > 60;
    function spawn(points, opts) {
      if (busy()) return;
      live++;
      const done = opts.onDone;
      packet(sc, clock, points, { ...opts, onDone: () => { live--; if (done) done(); } });
    }
    const flash = (n, ms = 500) => { n.setState('active'); clock.after(ms, () => n.setState(null)); };
    const flashSeg = (id) => { segs[id].dataset.state = 'hit'; clock.after(400, () => { delete segs[id].dataset.state; }); };

    function query({ app = Math.floor(rand() * 3), router = Math.floor(rand() * 3), shard = rand() < 0.5 ? 'B' : 'C', speed = 1, onStep } = {}) {
      const a = apps[app], r = routers[router], sh = SHARDS.find((q) => q.id === shard), sn = shardNodes[shard];
      const step = onStep || (() => {});
      spawn([a.bottom, [a.cx, 104], [r.cx, 104], r.top], { duration: 500 * speed, r: 5, onDone: () => {
        flash(r, 300); step(2);
        spawn([r.bottom, [r.cx, 204], [sh.cx, 204], [sh.cx, 228]], { duration: 450 * speed, r: 5, onDone: () => {
          flashSeg(shard); step(3);
          spawn([[sh.cx, 260], [sh.cx, 320]], { duration: 300 * speed, r: 5, onDone: () => {
            flash(sn, 400); step(4);
            spawn([[sh.cx, 308], [sh.cx, 204], [r.cx, 204], r.bottom], { duration: 500 * speed, r: 4, onDone: () => {
              spawn([r.top, [r.cx, 104], [a.cx, 104], a.bottom], { duration: 400 * speed, r: 4, onDone: () => {
                nQueries++; mQ.set(nQueries.toLocaleString()); step(5);
              } });
            } });
          } });
        } });
      } });
    }
    function healthCheck() {
      const sh = SHARDS[Math.floor(rand() * 3)];
      spawn([admin.left, [684, admin.cy], [684, 284], [sh.cx, 284], [sh.cx, 320]], { kind: 'control', duration: 900, r: 4, onDone: () => {
        nHealth++; mH.set(nHealth.toLocaleString());
      } });
    }
    function topoSync() {
      spawn([topo.left, [routers[2].x + routers[2].w + 4, topo.cy]], { kind: 'control', duration: 500, r: 4, onDone: () => {
        flash(routers[2], 300); nSync++; mS.set(nSync.toLocaleString());
      } });
    }
    function reconcile() {
      const sh = SHARDS[Math.floor(rand() * 3)];
      spawn([op.top, [op.cx, 460], [sh.cx, 460], [sh.cx, 440]], { kind: 'mgmt', duration: 900, r: 4, onDone: () => {
        flash(shardNodes[sh.id], 300); nReconcile++; mR.set(nReconcile.toLocaleString());
      } });
    }

    let qTimer = null;
    function armQueries() {
      if (qTimer) qTimer();
      qTimer = clock.every(1000 / qps, () => { if (!tracing && (mode === 'all' || mode === 'query')) query(); });
    }
    clock.every(1400, () => { if (!tracing && (mode === 'all' || mode === 'control')) healthCheck(); });
    clock.every(4200, () => { if (!tracing && (mode === 'all' || mode === 'control')) topoSync(); });
    clock.every(3100, () => { if (!tracing && (mode === 'all' || mode === 'mgmt')) reconcile(); });
    armQueries();

    // ---------- guided trace ----------
    const TRACE = {
      1: ['client', '<p><b>1 · Client.</b> App 2 sends <code>SELECT … WHERE tenant_id = 4821</code> to a router over the Postgres wire protocol.</p>'],
      2: ['routing', '<p><b>2 · Routing.</b> The router parses the statement and finds a cached plan for <code>tenant_id = $1</code>.</p>'],
      3: ['topology', '<p><b>3 · Data topology.</b> The shard index hashes 4821; its routing value falls in key range 80–ff, owned by shard C.</p>'],
      4: ['shards', '<p><b>4 · Shards.</b> Shard C’s primary runs the query. The router reaches Postgres only through the instance’s Sidecar.</p>'],
      5: ['client', '<p><b>5 · Back to the app.</b> One result, from one shard. The control plane and platform were never on this path.</p><p>Open any layer to see what happens when something there breaks.</p>'],
    };
    function trace() {
      tracing = true;
      const focus = (id) => { for (const [bid, n] of Object.entries(bandNodes)) n.setState(bid === id ? 'active' : 'dim'); cpBand.setState('dim'); };
      const onStep = (n) => {
        const [band, html] = TRACE[n];
        focus(band);
        ctx.narrate(html);
        log.add(['', 'App sends the query', 'Router plans it', 'Key range picks shard C', 'Shard C primary runs it', 'Result returns to the app'][n], 'query');
        if (n === 5) clock.after(1800, () => {
          tracing = false;
          for (const n2 of Object.values(bandNodes)) n2.setState(null);
          cpBand.setState(null);
        });
      };
      onStep(1);
      query({ app: 1, router: 2, shard: 'C', speed: 2.4, onStep });
    }

    // ---------- controls ----------
    const show = segmented({ label: 'Show flows', value: 'all', options: [
      { value: 'all', label: 'All' }, { value: 'query', label: 'Queries' }, { value: 'control', label: 'Control plane' }, { value: 'mgmt', label: 'Management' },
    ], onChange: (v) => { mode = v; log.add(`Showing ${v === 'all' ? 'all flows' : v === 'query' ? 'queries only' : v === 'control' ? 'control plane only' : 'management only'}`, 'info'); } });
    ctx.toolbar.append(
      group('Follow one query', button('Trace a query', trace, { variant: 'primary', icon: 'play' })),
      group('Live cluster', show, slider({ label: 'Queries per second', min: 1, max: 20, value: qps, onInput: (v) => { qps = v; armQueries(); } })),
    );

    const mQ = metric('Queries served', '0'), mH = metric('Health checks', '0'), mS = metric('Topology syncs', '0'), mR = metric('Reconciles', '0');
    ctx.readout.append(mQ.el, mH.el, mS.el, mR.el);

    const jumps = [
      ['A router fails', 'client'], ['A scatter query', 'routing'], ['Rows spread over shards', 'topology'],
      ['A stale replica read', 'shards'], ['A primary fails', 'control'], ['Reshard online', 'replicator'], ['A disk runs low', 'platform'],
    ];
    ctx.extra.append(
      h('div', { class: 'ctl-group__title', text: 'Jump to a situation', style: { marginBottom: '8px' } }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, jumps.map(([label, id]) => button(label, () => ctx.go(id)))));

    status.set('normal', 'Normal: one endpoint, queries flowing');
    ctx.narrate('<p>Blue dots are SQL traffic, orange dots are the control plane at work, and grey dots are the operator reconciling.</p>'
      + '<p>Press <b>Trace a query</b> to follow one statement down the layers, or click any layer to open its own simulation.</p>');
    log.add('Cluster running: 3 routers, 3 shards (A authoritative, B and C hold tenant data)', 'info');
  },
};
