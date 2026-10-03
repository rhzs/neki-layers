// Stage 1 · Client. App pools hold Postgres connections pinned to stateless routers.
// Fail a router, toggle app retries, add routers or a second router group, and send
// reads to replicas with __neki.target.
import {
  h, s, scene, node, edge, packet, text, button, toggle, slider, segmented, group, metric, rng,
} from '../core.js';

const ZONES = ['a', 'b', 'c'];
const ZX = [36, 240, 444], ZW = 196;            // default-group zone columns
const DEF = { x: 24, y: 146, w: 624, h: 116 };
const ANA = { x: 672, y: 146, w: 264, h: 116 };
const R_Y = 182, R_H = 52;                       // router row
const LANE = 298;                                // router → shard lane
const SLOT_Y = 88;                               // pool connection dots
const TOP_Y = 136;                               // orchestration path above the bands
const LEG = 420, SHARD_TRIP = 1000, REPLACE_MS = 5000, MAX_PKTS = 60;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ERR_STATUS = {
  drop: 'Errors: queries were lost with the failed router',
  dead: 'Errors: queries sent on dropped connections fail',
  readonly: 'Errors: writes fail on replica connections',
  noreplica: 'Errors: reads fail when no replica is eligible',
};
const ERR_LOG = {
  drop: (n) => `${plural(n, 'in-flight query', 'in-flight queries')} failed with the router`,
  dead: (n) => `${plural(n, 'query', 'queries')} failed on dropped connections (the app does not reconnect)`,
  readonly: (n) => `${plural(n, 'write')} rejected: replica connections are read-only`,
  noreplica: (n) => `${plural(n, 'read')} failed: no eligible replica, and no fallback to the primary`,
};

export default {
  id: 'client',
  nav: 'Client',
  kicker: 'Layer 1 · One endpoint',
  title: 'One connection string, many routers',
  lede: 'Your app talks to a Neki router with an ordinary Postgres driver, never to a shard. Routers are interchangeable. '
    + 'Fail one and watch the app reconnect, add routers or a second router group, and send reads to replicas.',
  facts: [
    { text: 'Neki speaks the Postgres wire protocol, so psql and standard Postgres drivers work. Apps connect to a router, not to shard primaries or replicas.', href: 'https://planetscale.com/docs/neki/connecting' },
    { text: 'Connections use port 5432 and require TLS. verify-full, the recommended mode, also checks the server host name.', href: 'https://planetscale.com/docs/neki/connecting' },
    { text: 'A Neki cluster on PlanetScale has at least three routers spread over three availability zones.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Routers are stateless. There is no primary router and no leader election. If one fails, its connections drop and the client reconnects to another router.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Each router group has its own size, routers per zone and autoscaling. Clients choose a group when they connect. The default group cannot be deleted.', href: 'https://planetscale.com/docs/neki/cluster-configuration' },
    { text: 'Reads go to primaries unless the session sets __neki.target to replica. Replica connections are read-only: writes fail, and reads never fall back to a primary.', href: 'https://planetscale.com/docs/neki/replicas' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(11);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    let retries = true, target = 'primary', writeRatio = 0.2, analytics = false;
    let okCount = 0, okRate = 0, errors = 0, retried = 0, reconnects = 0;
    let lastErrAt = -1e9, lastErrText = '', retryBuf = 0, statusKey = '';
    const errBuf = { drop: 0, dead: 0, readonly: 0, noreplica: 0 };
    const routers = [], conns = [], inflight = new Set();
    const counter = { default: { a: 1, b: 1, c: 1 }, analytics: { a: 1, b: 1, c: 1 } };

    // ---------- scene: static parts ----------
    const sc = scene(ctx.viz, 960, 476, 'App connection pools pinned to Neki routers, which forward queries to shard primaries and replicas');
    node(sc, { x: DEF.x, y: DEF.y, w: DEF.w, h: DEF.h, kind: 'band' });
    for (const x of [236, 440]) edge(sc, [[x, DEF.y + 10], [x, DEF.y + DEF.h - 10]], { kind: 'muted', dashed: true, arrow: false });
    text(sc, DEF.x + 12, 164, 'default group', { cls: 'label' });
    ZONES.forEach((z, i) => text(sc, ZX[i] + ZW - 8, 164, `zone ${z}`, { cls: 'label', anchor: 'end' }));
    const anaBand = node(sc, { x: ANA.x, y: ANA.y, w: ANA.w, h: ANA.h, kind: 'ghost' });
    text(sc, ANA.x + 12, 164, 'analytics group', { cls: 'label' });
    const anaOff = text(sc, ANA.x + ANA.w / 2, R_Y + 32, 'off', { cls: 'text', anchor: 'middle' });

    const shards = ['B', 'C'].map((name, i) => {
      const x = 196 + i * 380;
      node(sc, { x, y: 330, w: 360, h: 108, kind: 'shard' });
      text(sc, x + 14, 348, `shard ${name}`, { cls: 'label' });
      const sh = { name, replicaDown: false, cnt: { pr: 0, pw: 0, rr: 0 }, rate: { pr: 0, pw: 0, rr: 0 } };
      sh.primary = node(sc, { x: x + 14, y: 358, w: 160, h: 62, title: 'Primary', sub: '', kind: 'pg' });
      sh.replica = node(sc, { x: x + 186, y: 358, w: 160, h: 62, title: 'Replica', sub: '', kind: 'pg',
        onClick: () => toggleReplica(sh), label: `Take the shard ${name} replica offline or bring it back` });
      for (const pg of [sh.primary, sh.replica]) edge(sc, [[pg.cx, LANE], [pg.cx, pg.y - 4]], { kind: 'muted' });
      return sh;
    });
    const orch = node(sc, { x: 24, y: 358, w: 150, h: 62, title: 'Orchestration', sub: 'replaces routers', kind: 'mgmt' });
    text(sc, 24, 466, 'Rates are illustrative. Click a router to fail it, or a replica to take it offline.', { cls: 'text' });

    const stubLayer = s('g', {}, sc.edges);
    const connLayer = s('g', {}, sc.edges);
    const defLayer = s('g', {}, sc.nodes);
    const anaLayer = s('g', {}, sc.nodes);
    const dotLayer = s('g', {}, sc.nodes);

    const clients = [0, 1, 2].map((i) => {
      const n = node(sc, { x: ZX[i] + 23, y: 20, w: 150, h: 52, title: `App ${i + 1}`, sub: '', kind: 'client' });
      return { name: `App ${i + 1}`, node: n, idx: i, group: 'default', conns: [], slots: [-30, 0, 30].map((dx) => [n.cx + dx, SLOT_Y]) };
    });
    const biNode = node(sc, { x: ANA.x + 57, y: 20, w: 150, h: 52, title: 'BI client', sub: 'not connected', kind: 'ghost' });
    const bi = { name: 'BI client', node: biNode, idx: 3, group: 'analytics', conns: [], slots: [-20, 20].map((dx) => [biNode.cx + dx, SLOT_Y]) };

    // ---------- routers & connections ----------
    function addRouterObj(grp, zone) {
      const r = { group: grp, zone, name: `${zone}${counter[grp][zone]++}`, up: true, starting: false, conns: new Set(), node: null };
      routers.push(r);
      return r;
    }
    const titleOf = (r) => (r.group === 'default' ? `Router ${r.name}` : r.name);

    function place(r, x, w, layer) {
      r.node = node(sc, { x, y: R_Y, w, h: R_H, title: titleOf(r), sub: '', kind: 'router', layer,
        onClick: () => kill(r), label: `Fail router ${r.name}` });
      refreshRouter(r);
    }

    function layout() {
      defLayer.textContent = '';
      anaLayer.textContent = '';
      ZONES.forEach((z, zi) => {
        const rs = routers.filter((r) => r.group === 'default' && r.zone === z);
        const w = rs.length > 1 ? 88 : 120;
        rs.forEach((r, i) => place(r, rs.length > 1 ? ZX[zi] + 6 + i * 96 : ZX[zi] + (ZW - w) / 2, w, defLayer));
      });
      routers.filter((r) => r.group === 'analytics').forEach((r, i) => place(r, ANA.x + 8 + i * 86, 76, anaLayer));
      stubLayer.textContent = '';
      const xs = [...routers.map((r) => r.node.cx), ...shards.flatMap((sh) => [sh.primary.cx, sh.replica.cx])];
      edge(sc, [[Math.min(...xs), LANE], [Math.max(...xs), LANE]], { kind: 'muted', arrow: false, layer: stubLayer });
      for (const r of routers) edge(sc, [r.node.bottom, [r.node.cx, LANE]], { kind: 'muted', arrow: false, layer: stubLayer });
      for (const c of conns) drawConn(c);
    }

    function refreshRouter(r) {
      const n = r.node;
      if (!n) return;
      n.setTitle(titleOf(r));
      n.g.setAttribute('aria-label', `Fail router ${r.name}`);
      if (r.up) { n.setState(null); n.setSub(plural(r.conns.size, 'conn')); } else { n.setState(r.starting ? 'warn' : 'down'); n.setSub(r.starting ? 'starting' : 'down'); }
    }

    function openConn(cl, slotIdx, r) {
      const c = { client: cl, slotIdx, slot: cl.slots[slotIdx], router: r, last: r, state: 'up', edge: null, ep: null, stubEnd: null };
      c.dot = s('circle', { cx: c.slot[0], cy: c.slot[1], r: 5, class: 'packet packet--query' }, dotLayer);
      r.conns.add(c);
      cl.conns.push(c);
      conns.push(c);
      return c;
    }

    // Spread connection end points along the router's top edge.
    function epFor(c, r) {
      const k = (c.client.idx * 3 + c.slotIdx) % 9;
      return [r.node.x + r.node.w * (0.18 + (0.64 * k) / 8), R_Y - 2];
    }

    function drawConn(c, flash = false) {
      if (c.edge) { c.edge.remove(); c.edge = null; }
      const r = c.router || c.last;
      if (r && r.node && routers.includes(r)) {
        const ep = epFor(c, r);
        const a = [c.slot[0], c.slot[1] + 6];
        if (c.state === 'up') {
          c.ep = ep;
          const e = edge(sc, [a, ep], { kind: flash ? 'query' : 'muted', arrow: false, layer: connLayer });
          c.edge = e;
          if (flash) clock.after(800, () => { if (c.edge === e) e.setKind('muted'); });
        } else {
          c.stubEnd = [a[0] + (ep[0] - a[0]) * 0.4, a[1] + (ep[1] - a[1]) * 0.4];
          c.edge = edge(sc, [a, c.stubEnd], { kind: 'danger', dashed: true, arrow: false, layer: connLayer });
        }
      }
      const tone = c.state === 'up' ? 'query' : c.state === 'connecting' ? 'mgmt' : 'danger';
      c.dot.setAttribute('class', `packet packet--${tone}`);
    }

    function leastLoaded(grp, except) {
      const live = routers.filter((r) => r.group === grp && r.up && r !== except);
      if (!live.length) return null;
      const min = Math.min(...live.map((r) => r.conns.size));
      return pick(live.filter((r) => r.conns.size === min));
    }

    function refreshClients() {
      for (const cl of [...clients, bi]) {
        if (cl === bi && !analytics) continue;
        const up = cl.conns.filter((c) => c.state === 'up').length;
        const broken = cl.conns.length - up;
        cl.node.setSub(`pool: ${up}/${cl.conns.length} open`);
        cl.node.setState(broken ? (retries ? 'warn' : 'down') : null);
      }
      for (const r of routers) refreshRouter(r);
    }

    // ---------- traffic ----------
    function send(cl) {
      if (sc.packets.childElementCount > MAX_PKTS || !cl.conns.length) return;
      let c = pick(cl.conns);
      if (c.state !== 'up') {
        if (!retries) { failDead(c); return; }
        const ok = cl.conns.filter((x) => x.state === 'up');
        if (!ok.length) return;
        c = pick(ok);
      }
      const q = { c, r: c.router, ep: c.ep, write: cl !== bi && rand() < writeRatio, shard: pick(shards), pkt: null };
      inflight.add(q);
      q.pkt = packet(sc, clock, [c.slot, q.ep], { duration: LEG, r: q.write ? 6 : 5, onDone: () => atRouter(q) });
    }

    function done(q) { inflight.delete(q); }

    function atRouter(q) {
      let fail = null;
      if (target === 'replica' && q.write) fail = 'readonly';
      else if (target === 'replica' && q.shard.replicaDown) fail = 'noreplica';
      if (fail) {
        done(q);
        q.r.node.setState('warn');
        clock.after(250, () => refreshRouter(q.r));
        packet(sc, clock, [q.ep, q.c.slot], { kind: 'danger', duration: LEG, onDone: () => noteError(fail) });
        return;
      }
      const n = q.r.node;
      const dest = target === 'replica' ? q.shard.replica : q.shard.primary;
      const out = [n.bottom, [n.cx, LANE], [dest.cx, LANE], dest.top];
      q.pkt = packet(sc, clock, [...out, ...out.slice(0, -1).reverse()], { duration: SHARD_TRIP, r: q.write ? 6 : 5, onDone: () => {
        if (dest === q.shard.replica) q.shard.cnt.rr++; else if (q.write) q.shard.cnt.pw++; else q.shard.cnt.pr++;
        q.pkt = packet(sc, clock, [q.ep, q.c.slot], { duration: LEG, r: q.write ? 6 : 5, onDone: () => { done(q); okCount++; } });
      } });
    }

    function failInflight(q) {
      done(q);
      let from = q.c.slot;
      if (q.pkt) {
        from = [Number(q.pkt.el.getAttribute('cx')), Number(q.pkt.el.getAttribute('cy'))];
        q.pkt.cancel();
      }
      packet(sc, clock, [from, q.ep, q.c.slot], { kind: 'danger', duration: 500, onDone: () => {
        if (retries) {
          retried++;
          retryBuf++;
          clock.after(500 + rand() * 500, () => send(q.c.client));
        } else noteError('drop');
      } });
    }

    function failDead(c) {
      const end = c.stubEnd || [c.slot[0], c.slot[1] + 30];
      packet(sc, clock, [c.slot, end], { kind: 'danger', duration: 260, r: 4, onDone: () => noteError('dead') });
    }

    function noteError(kind) {
      errors++;
      errBuf[kind]++;
      lastErrAt = clock.now;
      lastErrText = ERR_STATUS[kind];
    }

    // ---------- failures & recovery ----------
    function kill(r) {
      if (!r.up) { log.add(`Router ${r.name} is already being replaced`, 'info'); return; }
      const peers = routers.filter((q) => q.group === r.group && q.up && q !== r);
      if (!peers.length) { log.add(`This demo keeps one router of the ${r.group} group up`, 'info'); return; }
      r.up = false;
      for (const q of [...inflight]) if (q.r === r) failInflight(q);
      const dropped = [...r.conns];
      r.conns.clear();
      for (const c of dropped) {
        c.router = null;
        c.last = r;
        c.state = 'broken';
        drawConn(c);
        if (retries) scheduleReconnect(c);
      }
      refreshClients();
      log.add(`Router ${r.name} (${r.group} group, zone ${r.zone}) failed: ${plural(dropped.length, 'connection')} dropped`, 'error');
      ctx.narrate(`<p>Router <b>${r.name}</b> is gone. The ${plural(dropped.length, 'connection')} it held dropped, just like any lost Postgres connection, and its in-flight queries failed.</p>`
        + (retries
          ? '<p>The app reconnects after a short backoff and retries the failed queries. There is no primary router and no leader election, so any surviving router can take the new connection.</p>'
          : '<p><b>App retries</b> is off, so those pool slots stay dead and every query sent on them fails. Turn retries on: handling dropped connections is the client’s job.</p>'));
      const oldName = r.name;
      clock.after(REPLACE_MS, () => replace(r, oldName));
      updateStatus();
    }

    function replace(r, oldName) {
      if (!routers.includes(r) || r.up) return;
      r.starting = true;
      refreshRouter(r);
      orch.setState('active');
      const n = r.node;
      packet(sc, clock, [orch.left, [12, orch.cy], [12, TOP_Y], [n.cx, TOP_Y], n.top], { kind: 'mgmt', duration: 1100, onDone: () => {
        orch.setState(null);
        if (!routers.includes(r)) return;
        r.name = `${r.zone}${counter[r.group][r.zone]++}`;
        r.up = true;
        r.starting = false;
        refreshRouter(r);
        const tagged = r.node;
        tagged.tag('new', 'ink');
        clock.after(2500, () => tagged.tag(null));
        log.add(`Orchestration replaced router ${oldName} with ${r.name} in zone ${r.zone}`, 'mgmt');
      } });
    }

    function scheduleReconnect(c) {
      if (c.state === 'connecting') return;
      c.state = 'connecting';
      drawConn(c);
      clock.after(700 + rand() * 700, () => {
        if (!conns.includes(c) || c.state !== 'connecting') return;
        const r = retries ? leastLoaded(c.client.group) : null;
        if (!r) { c.state = 'broken'; drawConn(c); refreshClients(); return; }
        c.router = r;
        c.last = r;
        c.state = 'up';
        r.conns.add(c);
        reconnects++;
        drawConn(c, true);
        refreshClients();
        log.add(`${c.client.name} reconnected to router ${r.name}`, 'info');
      });
    }

    // Pools recycle connections now and then; new ones go to the live router with the fewest connections.
    function recycle() {
      const healthy = conns.filter((c) => c.state === 'up');
      if (!healthy.length) return;
      const c = pick(healthy);
      const to = leastLoaded(c.client.group, c.router);
      if (!to || to.conns.size + 1 >= c.router.conns.size) return;
      const from = c.router;
      from.conns.delete(c);
      to.conns.add(c);
      c.router = to;
      c.last = to;
      drawConn(c, true);
      refreshClients();
      log.add(`${c.client.name} recycled a connection: ${from.name} → ${to.name}`, 'info');
    }

    function toggleReplica(sh) {
      sh.replicaDown = !sh.replicaDown;
      refreshShards();
      log.add(`Shard ${sh.name} replica ${sh.replicaDown ? 'is unavailable' : 'is back'}`, 'mgmt');
      if (!sh.replicaDown) ctx.narrate(`<p>The shard ${sh.name} replica is back. Replica reads for that shard succeed again.</p>`);
      else if (target === 'replica') ctx.narrate(`<p>The shard ${sh.name} replica is unavailable. Replica reads for that shard now <b>fail</b>. Neki does not quietly send them to the primary, because the session asked for a replica.</p>`);
      else ctx.narrate(`<p>The shard ${sh.name} replica is unavailable. Nothing changes yet: reads target primaries. Switch <code>__neki.target</code> to <b>replica</b> to see those reads fail rather than fall back.</p>`);
    }

    // ---------- controls ----------
    function addRouter() {
      const counts = ZONES.map((z) => routers.filter((r) => r.group === 'default' && r.zone === z).length);
      const min = Math.min(...counts);
      if (min >= 2) { log.add('This demo stops at two routers per zone', 'info'); return; }
      const r = addRouterObj('default', ZONES[counts.indexOf(min)]);
      layout();
      const tagged = r.node;
      tagged.tag('new', 'ink');
      clock.after(2500, () => tagged.tag(null));
      const total = routers.filter((q) => q.group === 'default').length;
      addBtn.disabled = total >= 6;
      log.add(`Default group: router ${r.name} added in zone ${r.zone} (${total} routers)`, 'mgmt');
      ctx.narrate(`<p>The default group now runs ${total} routers. Each group is sized on its own: routers per zone, or autoscaling between a minimum and a maximum.</p>`
        + '<p>Existing connections stay pinned where they are. In this demo the pools recycle a connection every few seconds, and the new ones land on the router with the fewest connections.</p>');
    }

    function setAnalytics(on) {
      analytics = on;
      if (on) {
        for (const z of ZONES) addRouterObj('analytics', z);
        anaBand.g.setAttribute('class', 'node node--band');
        biNode.g.setAttribute('class', 'node node--client');
        anaOff.textContent = '';
        layout();
        const ar = routers.filter((r) => r.group === 'analytics');
        bi.slots.forEach((_, i) => drawConn(openConn(bi, i, ar[i]), true));
        refreshClients();
        log.add('BI client connected to the analytics router group', 'mgmt');
        ctx.narrate('<p>A second router group, <b>analytics</b>, serves the BI client. The client picks the group when it connects; for a non-default group the username carries a group suffix.</p>'
          + '<p>The group has its own routers and sizing, so report traffic does not share routers with the app. Both groups reach the same shards. Add routers to the default group: this one is unaffected.</p>');
      } else {
        for (const q of [...inflight]) if (q.c.client === bi || q.r.group === 'analytics') { if (q.pkt) q.pkt.cancel(); done(q); }
        for (const c of bi.conns) { if (c.edge) c.edge.remove(); c.dot.remove(); conns.splice(conns.indexOf(c), 1); }
        bi.conns.length = 0;
        for (let i = routers.length - 1; i >= 0; i--) if (routers[i].group === 'analytics') routers.splice(i, 1);
        counter.analytics = { a: 1, b: 1, c: 1 };
        anaBand.g.setAttribute('class', 'node node--ghost');
        biNode.g.setAttribute('class', 'node node--ghost');
        biNode.setState(null);
        biNode.setSub('not connected');
        anaOff.textContent = 'off';
        layout();
        log.add('Analytics router group removed; the default group cannot be removed', 'mgmt');
        ctx.narrate('<p>The analytics group is gone. The default group stays: it cannot be deleted.</p>');
      }
      updateCode();
    }

    function setTarget(v) {
      target = v;
      log.add(`SET __neki.target = '${v}' on every pooled connection`, 'query');
      updateCode();
      ctx.narrate(v === 'replica'
        ? '<p>Every session now runs <code>SET __neki.target = \'replica\'</code>. Reads go to the replicas. Writes on these connections <b>fail</b>: a replica connection is read-only and never sends DML to a primary. Raise <b>Writes</b> to see more failures.</p><p>Click a replica to take it offline: reads for that shard fail rather than fall back to the primary.</p>'
        : '<p>Back to the default: reads and writes go to shard primaries.</p>');
    }

    const addBtn = button('Add router', addRouter, { variant: 'control', icon: 'plus', title: 'Add a router to the default group' });
    ctx.toolbar.append(
      group('Routers',
        button('Fail a router', () => {
          const live = routers.filter((r) => r.group === 'default' && r.up);
          if (live.length < 2) { log.add('This demo keeps one router of the default group up', 'info'); return; }
          kill(pick(live));
        }, { variant: 'danger', icon: 'x' }),
        addBtn,
        toggle({ label: 'Analytics group', onChange: setAnalytics })),
      group('App',
        toggle({ label: 'App retries', checked: true, onChange: (v) => {
          retries = v;
          log.add(v ? 'App retries on: dropped connections reconnect' : 'App retries off', 'info');
          if (v) for (const c of conns) if (c.state === 'broken') scheduleReconnect(c);
          refreshClients();
        } }),
        slider({ label: 'Writes', min: 0, max: 100, step: 5, value: 20, unit: '%', onInput: (v) => { writeRatio = v / 100; } })),
      group('Session',
        segmented({ label: '__neki.target', options: [{ value: 'primary', label: 'primary' }, { value: 'replica', label: 'replica' }], value: 'primary', onChange: setTarget })),
    );

    const mOk = metric('OK queries/s'), mErr = metric('Errors', '0'), mRetry = metric('Retried', '0'), mConn = metric('Open connections'), mRe = metric('Reconnects', '0');
    ctx.readout.append(mOk.el, mErr.el, mRetry.el, mConn.el, mRe.el);

    const setLine = h('div');
    const biLine = h('div', { style: { color: 'var(--muted)' } });
    ctx.extra.append(
      h('pre', { class: 'codeblock' },
        h('div', { text: 'postgresql://<user>:<password>@<host>:5432/<database>?sslmode=verify-full' }), setLine, biLine),
      h('p', { style: { margin: '10px 0 0', fontSize: '13px', color: 'var(--faint)' } },
        'Any Postgres driver or ORM works. Port 5432, TLS required. The host is a router endpoint, not a shard. '
        + 'The pools, rates and timings on this page are illustrative.'));
    function updateCode() {
      setLine.textContent = `SET __neki.target = '${target}';${target === 'replica' ? '   -- read-only from here on' : ''}`;
      biLine.textContent = analytics ? '-- BI client: same host and port, analytics router group chosen at connect time' : '';
    }

    // ---------- periodic work ----------
    function refreshShards() {
      for (const sh of shards) {
        sh.primary.setSub(`${Math.round(sh.rate.pr)} reads/s · ${Math.round(sh.rate.pw)} writes/s`);
        sh.replica.setState(sh.replicaDown ? 'down' : null);
        sh.replica.setSub(sh.replicaDown ? 'unavailable' : `${Math.round(sh.rate.rr)} reads/s`);
      }
    }

    function refreshMetrics() {
      const up = conns.filter((c) => c.state === 'up').length;
      mOk.set(String(Math.round(okRate)), okRate > 0 ? 'good' : null);
      mErr.set(errors.toLocaleString(), clock.now - lastErrAt < 2000 ? 'bad' : null);
      mRetry.set(retried.toLocaleString(), retried ? 'warn' : null);
      mConn.set(`${up}/${conns.length}`, up < conns.length ? 'bad' : null);
      mRe.set(reconnects.toLocaleString());
    }

    function updateStatus() {
      const broken = conns.filter((c) => c.state !== 'up').length;
      const live = routers.filter((r) => r.up).length;
      let st, msg;
      if (broken && !retries) { st = 'down'; msg = `Disconnected: ${plural(broken, 'pooled connection')} dropped and not reopened`; }
      else if (broken) { st = 'slower'; msg = `Slower: reconnecting ${plural(broken, 'connection')}, retrying failed queries`; }
      else if (clock.now - lastErrAt < 1500) { st = 'error'; msg = lastErrText; }
      else { st = 'normal'; msg = `Normal: queries run through ${plural(live, 'router')}`; }
      if (st + msg !== statusKey) { statusKey = st + msg; status.set(st, msg); }
    }

    function flushLog() {
      for (const [k, n] of Object.entries(errBuf)) if (n) { log.add(ERR_LOG[k](n), 'error'); errBuf[k] = 0; }
      if (retryBuf) { log.add(`${plural(retryBuf, 'failed query', 'failed queries')} retried on other connections`, 'info'); retryBuf = 0; }
    }

    // ---------- start ----------
    for (const z of ZONES) addRouterObj('default', z);
    layout();
    const def = routers.filter((r) => r.group === 'default');
    clients.forEach((cl) => cl.slots.forEach((_, j) => drawConn(openConn(cl, j, def[(cl.idx + j) % 3]))));
    refreshClients();
    refreshShards();
    updateCode();
    refreshMetrics();

    clock.every(200, () => {
      for (const cl of clients) if (rand() < 0.75) send(cl);
      if (analytics && rand() < 0.4) send(bi);
    }, { immediate: true });
    clock.every(1000, () => {
      okRate = okRate * 0.4 + okCount * 0.6;
      okCount = 0;
      for (const sh of shards) for (const k of ['pr', 'pw', 'rr']) { sh.rate[k] = sh.rate[k] * 0.4 + sh.cnt[k] * 0.6; sh.cnt[k] = 0; }
      refreshShards();
      refreshMetrics();
    });
    clock.every(400, updateStatus, { immediate: true });
    clock.every(2000, flushLog);
    clock.every(2600, recycle);

    log.add('3 apps opened 9 pooled connections to the default router group', 'query');
    ctx.narrate('<p>Three app instances each keep a pool of three connections. Every connection is pinned to one router in the <b>default</b> group, which has one router per availability zone. The router sends each query to the right shard and relays the answer.</p>'
      + '<p>Click a router, or press <b>Fail a router</b>, to see what the app goes through.</p>');
  },
};
