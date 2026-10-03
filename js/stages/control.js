// Stage 5 · Control plane. Admins watch every Postgres instance through its Sidecar and
// repair the shard through PostgresManager. Crash the primary or run a planned switchover
// and watch routers hold queries until the new topology reaches them.
import {
  h, s, scene, node, edge, packet, text, shorten, button, toggle, slider, group, metric, createChart, rng, fmtMs,
} from '../core.js';

const XS = [50, 370, 690];
const SW = 220;
const Y = {
  app: 14, router: 96, laneApp: 80, laneSignal: 160, laneTopo: 170, laneQ: 196, laneAdmin: 222,
  band: 240, side: 280, pg: 310, pgH: 70, pm: 384, laneWal: 424,
};
const MAX_LIVE = 60;
const TRAVEL = 680; // animation time of a normal query (app → router → primary), not part of latency
const TICK = 400;
const UNPLANNED = ['Detect', 'Choose replica', 'Promote', 'Repoint', 'Topology', 'Replan'];
const PLANNED = ['Buffer signal', 'Read-only', 'Catch up', 'Promote', 'Repoint', 'Topology', 'Replan'];
const LSN0 = 0x5C01A40;

const lsnStr = (n) => `0/${n.toString(16).toUpperCase()}`;
const kb = (b) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} kB`);

export default {
  id: 'control',
  nav: 'Control plane',
  kicker: 'Control plane · Beside the query path',
  title: 'Failover and switchover',
  lede: 'Admins watch every Postgres instance through its Sidecar and repair the shard through PostgresManager, off the '
    + 'query path. Crash the primary or run a planned switchover, and watch what your app feels while routers hold its queries.',
  facts: [
    { text: 'Admins check each Postgres instance through its Sidecar and direct Postgres through its PostgresManager.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Several admins can run at once, but only the one holding recovery leadership repairs nodes.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Failover prefers a replica that has replayed all available WAL, waits briefly for one to catch up, and otherwise promotes the replica that received the most WAL. Other replicas are then pointed at the new primary.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'A planned switchover makes the old primary read-only, waits for the replica, then promotes it. If it fails before promotion, the old primary becomes writable again.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'Routers buffer queries for a bounded time, on an admin signal before a switchover or after a qualifying error during a failure, then replan them against the current topology. If recovery takes too long they return errors, so apps should retry transient failures.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'A replica that needs a WAL segment it can no longer get is fenced and restored from backup.', href: 'https://planetscale.com/docs/neki/replicas' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(5);

    // ---------- scene ----------
    const sc = scene(ctx.viz, 960, 600, 'Control plane: app, three routers, topology service, two admins, and one shard with three Postgres instances');
    node(sc, { x: 20, y: Y.band, w: 920, h: 344, kind: 'shard', rx: 14, layer: sc.bg });
    text(sc, 924, Y.band + 338, 'Shard · its own failure domain', { cls: 'label', anchor: 'end' });

    const app = node(sc, { x: 200, y: Y.app, w: 180, h: 46, title: 'App', sub: 'steady queries', kind: 'client' });
    const topo = node(sc, { x: 690, y: 14, w: 240, h: 50, title: 'Topology service', sub: 'primary: pg-1', kind: 'mgmt',
      onClick: explainTopo, label: 'Topology service: what it stores' });
    const admins = ['Admin A', 'Admin B'].map((name, i) => {
      const a = { name, up: true, leader: i === 0 };
      a.node = node(sc, { x: 690 + i * 125, y: Y.router, w: 115, h: 54, title: name, kind: 'control',
        onClick: () => explainAdmin(a), label: `${name}: show its role` });
      return a;
    });
    const routers = [0, 1, 2].map((i) => {
      const r = { i, name: `Router ${i + 1}`, primary: 0, buffering: false, buffer: [], spent: false, stop: null, tagN: null };
      r.node = node(sc, { x: 40 + i * 195, y: Y.router, w: 170, h: 54, title: r.name, kind: 'router',
        onClick: () => explainRouter(r), label: `${r.name}: show its view` });
      return r;
    });
    const inst = [0, 1, 2].map((i) => {
      const o = { i, name: `pg-${i + 1}`, az: 'abc'[i], x: XS[i], cx: XS[i] + SW / 2 };
      o.side = node(sc, { x: o.x, y: Y.side, w: SW, h: 26, rx: 6, title: 'Sidecar', kind: 'sidecar' });
      o.pg = node(sc, { x: o.x, y: Y.pg, w: SW, h: Y.pgH, title: o.name, kind: 'pg',
        onClick: () => explainInstance(o), label: `${o.name}: show its state` });
      o.pm = node(sc, { x: o.x, y: Y.pm, w: SW, h: 24, rx: 6, title: 'PostgresManager', kind: 'pm' });
      o.t1 = text(sc, o.x, 448, '', { cls: 'text mono' });
      o.t2 = text(sc, o.x, 468, '', { cls: 'text mono' });
      o.t3 = text(sc, o.x, 490, '', { cls: 'text' });
      return o;
    });

    // paths
    const appToRouter = (r) => [app.bottom, [app.cx, Y.laneApp], [r.node.cx, Y.laneApp], r.node.top];
    const routerToApp = (r) => appToRouter(r).reverse();
    const qx = (o) => o.side.at(0.3, 0)[0];
    const routerToInst = (r, o) => {
      const [rx, ry] = r.node.at(0.4, 1);
      return [[rx, ry], [rx, Y.laneQ], [qx(o), Y.laneQ], [qx(o), Y.side], [qx(o), o.pg.cy]];
    };
    const ax = (o) => o.side.at(0.75, 0)[0];
    const adminToSide = (a, o) => [a.node.bottom, [a.node.cx, Y.laneAdmin], [ax(o), Y.laneAdmin], [ax(o), Y.side]];
    const sideToPm = (o) => [o.side.right, [o.x + SW + 8, o.side.cy], [o.x + SW + 8, o.pm.cy], o.pm.right];
    const tx = (r) => r.node.at(0.85, 1)[0];
    const topoToRouter = (r) => [topo.left, [650, topo.cy], [650, Y.laneTopo], [tx(r), Y.laneTopo], [tx(r), Y.router + 54]];
    const adminToTopo = (a) => [a.node.top, [a.node.cx, topo.y + topo.h]];
    const adminToRouter = (a, r) => {
      const x = r.node.at(0.95, 1)[0];
      return [a.node.bottom, [a.node.cx, Y.laneSignal], [x, Y.laneSignal], [x, Y.router + 54]];
    };

    // static edges
    for (const r of routers) edge(sc, shorten(appToRouter(r)), { kind: 'query' });
    edge(sc, [topo.left, [650, topo.cy], [650, Y.laneTopo], [tx(routers[0]), Y.laneTopo]], { kind: 'mgmt', dashed: true, arrow: false });
    for (const r of routers) edge(sc, shorten([[tx(r), Y.laneTopo], [tx(r), Y.router + 54]]), { kind: 'mgmt', dashed: true });
    for (const a of admins) {
      edge(sc, shorten(adminToTopo(a)), { kind: 'control', dashed: true });
      edge(sc, [a.node.bottom, [a.node.cx, Y.laneAdmin]], { kind: 'control', dashed: true, arrow: false });
    }
    edge(sc, [[ax(inst[0]), Y.laneAdmin], [admins[1].node.cx, Y.laneAdmin]], { kind: 'control', dashed: true, arrow: false });
    for (const o of inst) edge(sc, shorten([[ax(o), Y.laneAdmin], [ax(o), Y.side]]), { kind: 'control', dashed: true });

    // dynamic edges: router → primary, WAL primary → replicas
    const dynE = s('g', {}, sc.edges), dynL = s('g', {}, sc.labels);
    function walRoute(a, b) {
      if (Math.abs(a.i - b.i) === 1) return a.i < b.i ? [a.pg.right, b.pg.left] : [a.pg.left, b.pg.right];
      const [L, R] = a.i < b.i ? [a, b] : [b, a];
      const route = [L.pg.left, [L.x - 16, L.pg.cy], [L.x - 16, Y.laneWal], [R.x + SW + 16, Y.laneWal], [R.x + SW + 16, R.pg.cy], R.pg.right];
      return a === L ? route : route.reverse();
    }
    function drawDyn() {
      dynE.textContent = '';
      dynL.textContent = '';
      for (const r of routers) {
        const o = inst[r.primary];
        const ok = o.up && o.role === 'primary';
        edge(sc, shorten(routerToInst(r, o).slice(0, 4)), { kind: ok ? 'query' : 'danger', dashed: !ok, layer: dynE });
      }
      const P = primary();
      if (!P) return;
      for (const o of inst) {
        if (o === P || o.role !== 'replica' || o.following !== P.i) continue;
        const pts = walRoute(P, o);
        edge(sc, shorten(pts), { kind: 'mgmt', layer: dynE }).setState(P.up && o.up ? 'flow' : 'dim');
        if (pts.length === 2) text(sc, (pts[0][0] + pts[1][0]) / 2, pts[0][1] - 10, 'WAL', { cls: 'label', anchor: 'middle', layer: dynL });
      }
    }

    // step tracker
    const stepsG = s('g', {}, sc.labels);
    const stepsLabel = text(sc, 40, 522, '', { cls: 'label' });
    let chips = {};
    function setSteps(list, label) {
      stepsG.textContent = '';
      stepsLabel.textContent = label;
      chips = {};
      const w = list.length > 6 ? 118 : 138, gap = list.length > 6 ? 8 : 10;
      list.forEach((name, k) => {
        const g = s('g', { class: 'range', opacity: 0.35 }, stepsG);
        const x = 40 + k * (w + gap);
        s('rect', { x, y: 532, width: w, height: 30, rx: 6 }, g);
        const t = s('text', { x: x + w / 2, y: 552, 'text-anchor': 'middle', text: name }, g);
        chips[name] = { g, t };
      });
    }
    function stepState(name, state, label) {
      const c = chips[name];
      if (!c) return;
      c.g.setAttribute('class', state === 'failed' ? 'chip' : 'range');
      c.g.setAttribute('opacity', state === 'pending' ? 0.35 : 1);
      if (state === 'active') c.g.dataset.state = 'hit'; else delete c.g.dataset.state;
      if (label) c.t.textContent = label;
    }

    // ---------- state ----------
    let lsn, history, incident, repairEp = 0, electing, failed, lastFailover, rr, tick, lastErrAt, errReason, lastSlowAt, lastFailLog;
    let live = 0, topoPrimary = 0;
    let W = 5, F = 3, behind = false, failSwitch = false;

    function initState() {
      lsn = LSN0;
      history = [{ t: -1e9, lsn }];
      incident = null;
      repairEp++;
      electing = false;
      failed = 0;
      lastFailover = null;
      rr = 0;
      tick = { max: 0, err: 0 };
      lastErrAt = -1e9; lastSlowAt = -1e9; lastFailLog = -1e9;
      errReason = '';
      topoPrimary = 0;
      for (const o of inst) {
        Object.assign(o, { role: o.i === 0 ? 'primary' : 'replica', up: true, readOnly: false, promoting: false, following: 0, received: lsn, replayed: lsn, lastLsn: lsn });
        o.side.setState(null);
      }
      for (const r of routers) Object.assign(r, { primary: 0, buffering: false, buffer: [], spent: false, stop: null, tagN: null });
      admins.forEach((a, i) => Object.assign(a, { up: true, leader: i === 0 }));
      topo.setState(null);
      topo.setSub('primary: pg-1');
    }

    const primary = () => inst.find((o) => o.role === 'primary');
    const leader = () => admins.find((a) => a.up && a.leader);
    const candidates = () => inst.filter((o) => o.role === 'replica' && o.up);
    const recvDelay = (o) => (behind && o.i === 1 ? 2500 : 120);
    const replayDelay = (o) => (behind && o.i === 1 ? 5000 : 350);
    function lsnAt(t) {
      for (let k = history.length - 1; k >= 0; k--) if (history[k].t <= t) return history[k].lsn;
      return history[0].lsn;
    }

    const pk = (pts, opt = {}) => {
      live++;
      const fn = opt.onDone;
      return packet(sc, clock, pts, { ...opt, onDone: () => { live--; if (fn) fn(); } });
    };
    const flash = (n, state = 'active', ms = 500) => { n.setState(state); clock.after(ms, () => n.setState(null)); };
    const shown = new Map();
    const put = (el, v) => { if (shown.get(el) !== v) { shown.set(el, v); el.textContent = v; } };
    const attr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
    const mset = (m, v, tone) => { const k = `${v}|${tone || ''}`; if (m.k !== k) { m.k = k; m.set(v, tone); } };

    // ---------- painting ----------
    function paintRouter(r) {
      const n = r.buffering ? r.buffer.length : null;
      if (n === r.tagN) return;
      r.tagN = n;
      r.node.tag(n == null ? null : `${n} held`, 'control');
    }
    function paintNodes() {
      for (const o of inst) {
        if (!o.up) {
          o.pg.setTitle(`${o.name} · down`);
          o.pg.setSub(`AZ ${o.az} · Postgres stopped`);
          o.pg.setState('down');
        } else if (o.role === 'primary') {
          o.pg.setTitle(`${o.name} · primary`);
          o.pg.setSub(`AZ ${o.az} · ${o.readOnly ? 'read-only' : 'read-write'}`);
          o.pg.setState(o.readOnly ? 'warn' : null);
        } else {
          o.pg.setTitle(`${o.name} · replica`);
          o.pg.setSub(o.promoting ? 'promoting…' : `AZ ${o.az} · ${o.following >= 0 ? `follows ${inst[o.following].name}` : 'not following'}`);
          o.pg.setState(o.promoting ? 'warn' : null);
        }
      }
      for (const a of admins) {
        a.node.setSub(!a.up ? 'down' : a.leader ? 'recovery leader' : 'standby');
        a.node.setState(a.up ? null : 'down');
        a.node.tag(a.up && a.leader ? 'leader' : null, 'control');
      }
      for (const r of routers) { r.node.setSub(`primary: ${inst[r.primary].name}`); paintRouter(r); }
    }
    function paintText() {
      const P = primary();
      const avail = P && P.up ? lsn : Math.max(0, ...candidates().map((o) => o.received));
      for (const o of inst) {
        if (!o.up) {
          put(o.t1, `last LSN ${lsnStr(o.lastLsn)}`);
          put(o.t2, o.role === 'down' ? 'rejoins as a replica soon (demo)' : 'not answering health checks');
          put(o.t3, 'Sidecar and PostgresManager still run');
          attr(o.t3, 'class', 'text text--danger');
        } else if (o.role === 'primary') {
          put(o.t1, `LSN ${lsnStr(lsn)}`);
          put(o.t2, o.readOnly ? 'read-only: no new commits' : 'accepting writes');
          put(o.t3, 'primary');
          attr(o.t3, 'class', 'text text--strong');
        } else {
          put(o.t1, `received ${lsnStr(o.received)}`);
          put(o.t2, `replayed ${lsnStr(o.replayed)}`);
          const gap = Math.max(0, avail - o.replayed);
          put(o.t3, gap ? `behind by ${kb(gap)}` : 'caught up');
          attr(o.t3, 'class', gap > 0x800 ? 'text text--control' : 'text text--query');
        }
      }
    }
    function paintMetrics() {
      const P = primary();
      mset(mPrimary, P ? (P.up ? P.name : `${P.name} (down)`) : 'none', P && P.up ? null : 'bad');
      const held = routers.reduce((n, r) => n + r.buffer.length, 0);
      mset(mBuffered, String(held), held ? 'warn' : null);
      mset(mFailed, String(failed), failed ? 'bad' : null);
      mset(mLast, lastFailover ? `${fmtMs(lastFailover.dur)}${lastFailover.kind === 'switchover' ? ' planned' : ''}` : '—',
        lastFailover && lastFailover.errors ? 'bad' : null);
      const a = leader();
      mset(mLeader, a ? a.name : 'none', a ? null : 'bad');
    }
    let stKey = '';
    function refreshStatus() {
      const now = clock.now;
      const P = primary();
      let st, txt;
      if (now - lastErrAt < 1200) { st = 'error'; txt = errReason; }
      else if (routers.some((r) => r.buffering)) { st = 'slower'; txt = 'Slower: routers are holding queries, not failing them'; }
      else if (now - lastSlowAt < 1200) { st = 'slower'; txt = 'Slower: held queries just ran after the hand-off'; }
      else { st = 'normal'; txt = `Normal: queries reach the primary, ${P ? P.name : '—'}`; }
      if (st + txt !== stKey) { stKey = st + txt; status.set(st, txt); }
    }
    function updateButtons() {
      const P = primary();
      const can = !!(P && P.up && !incident && candidates().length);
      crashBtn.disabled = !can;
      swBtn.disabled = !(can && leader());
      killBtn.disabled = !leader();
    }

    // ---------- query path ----------
    function sendQuery() {
      if (live > MAX_LIVE) return;
      const r = routers[rr++ % routers.length];
      const q = { t0: clock.now, write: rand() < 0.6 };
      pk(appToRouter(r), { duration: 300, onDone: () => atRouter(r, q) });
    }
    function atRouter(r, q) {
      if (r.buffering) { r.buffer.push(q); paintRouter(r); return; }
      const o = inst[r.primary];
      pk(routerToInst(r, o), { duration: 380, onDone: () => atInstance(r, q, o) });
    }
    function atInstance(r, q, o) {
      if (o.up && o.role === 'primary' && !(q.write && o.readOnly)) {
        if (q.write) commit();
        done(q);
        return;
      }
      pk(routerToInst(r, o).reverse(), { kind: 'danger', duration: 300, r: 5, onDone: () => {
        if (r.buffering) { r.buffer.push(q); paintRouter(r); return; }
        fail(r, q, o.up ? 'Errors: writes reached a read-only primary' : 'Errors: queries reached a primary that is down', true);
        if (!o.up && !r.spent && r.primary === o.i) startBuffering(r, 'error');
      } });
    }
    function commit() {
      lsn += 0x60 + Math.floor(rand() * 0x400);
      history.push({ t: clock.now, lsn });
      while (history.length > 2 && history[1].t < clock.now - 20000) history.shift();
    }
    function done(q) {
      const lat = Math.max(15, clock.now - q.t0 - TRAVEL + 20 + rand() * 15);
      tick.max = Math.max(tick.max, lat);
      if (lat > 400) lastSlowAt = clock.now;
    }
    function fail(r, q, reason, visual) {
      failed++;
      tick.err++;
      lastErrAt = clock.now;
      errReason = reason;
      if (incident) incident.errors++;
      if (visual && live < MAX_LIVE) pk(routerToApp(r), { kind: 'danger', duration: 300, r: 5 });
      if (clock.now - lastFailLog > 1500) { lastFailLog = clock.now; log.add(`${r.name} returned an error to the app (${reason.replace('Errors: ', '')})`, 'error'); }
    }
    function startBuffering(r, why) {
      r.buffering = true;
      if (why === 'error') r.spent = true;
      r.stop = clock.after(W * 1000, () => expire(r));
      paintRouter(r);
      log.add(`${r.name} starts buffering (${why === 'signal' ? 'admin signal' : 'query error'}, up to ${W} s)`, 'control');
    }
    function expire(r) {
      r.stop = null;
      r.buffering = false;
      const qs = r.buffer;
      r.buffer = [];
      if (incident) incident.expired = true;
      qs.forEach((q, k) => fail(r, q, 'Errors: the buffer window ran out before recovery finished', k < 3));
      paintRouter(r);
      log.add(`${r.name}: buffer window ran out; ${qs.length} held quer${qs.length === 1 ? 'y' : 'ies'} returned errors`, 'error');
    }
    function stopBuffering(r) {
      if (r.stop) { r.stop(); r.stop = null; }
      r.buffering = false;
      const qs = r.buffer;
      r.buffer = [];
      paintRouter(r);
      if (qs.length) log.add(`${r.name} replans ${qs.length} held quer${qs.length === 1 ? 'y' : 'ies'} against ${inst[r.primary].name}`, 'query');
      qs.forEach((q, k) => clock.after(k * 40, () => atRouter(r, q)));
    }

    // ---------- control plane ----------
    function healthChecks() {
      const a = leader();
      if (!a || live > MAX_LIVE) return;
      for (const o of inst) {
        pk(adminToSide(a, o), { kind: 'control', duration: 450, r: 4, onDone: () => {
          if (o.up) return;
          flash(o.side, 'warn', 300);
          pk(adminToSide(a, o).reverse(), { kind: 'danger', duration: 350, r: 4 });
        } });
      }
    }

    function newRun() {
      const ep = ++repairEp;
      const ok = () => ep === repairEp && incident && !incident.done;
      return {
        later: (ms, fn) => clock.after(ms, () => { if (ok()) fn(); }),
        guard: (fn) => () => { if (ok()) fn(); },
      };
    }

    function bestReplica(reps) {
      const avail = Math.max(...reps.map((o) => o.received));
      const full = reps.filter((o) => o.replayed >= avail);
      if (full.length) return { pick: full[0], avail, full: true };
      return { pick: [...reps].sort((x, y) => y.received - x.received)[0], avail, full: false };
    }

    function crash() {
      const P = primary();
      if (incident || !P || !P.up) return;
      P.up = false;
      P.lastLsn = lsn;
      incident = { kind: 'crash', t0: clock.now, old: P.i, chosen: -1, promoted: false, done: false, errors: 0, expired: false };
      setSteps(UNPLANNED, 'Failover steps');
      log.add(`${P.name}: Postgres crashed; its Sidecar and PostgresManager keep running`, 'error');
      ctx.narrate(`<p><b>${P.name}</b> is down. Queries already on their way to it fail, and each router that sees such an error starts <b>buffering</b> new queries for up to ${W} s.</p>`
        + '<p>Meanwhile the recovery leader’s health checks, which go through each instance’s Sidecar, notice the failure.</p>');
      paintNodes(); drawDyn(); updateButtons();
      runRepair();
    }

    function runRepair() {
      if (!incident || incident.done) return;
      const a = leader();
      if (!a) { log.add('No admin holds recovery leadership, so nobody repairs the shard yet', 'control'); return; }
      const run = newRun();
      if (incident.promoted) { run.later(300, () => repoint(a, run)); return; }
      if (incident.kind === 'switchover') { revert(a, run, `${a.name} took over recovery leadership before the promotion`); return; }
      for (const o of inst) o.promoting = false;
      paintNodes();
      stepState('Detect', 'active');
      run.later(0.4 * F * 1000, () => detect(a, run));
    }

    function detect(a, run) {
      const P = inst[incident.old];
      pk(adminToSide(a, P).reverse(), { kind: 'danger', duration: 350, r: 5 });
      log.add(`${a.name}: the health check through ${P.name}’s Sidecar fails; starting failover`, 'control');
      stepState('Detect', 'done');
      stepState('Choose replica', 'active');
      choose(a, run, false);
    }

    function choose(a, run, waited) {
      const reps = candidates();
      if (!reps.length) { log.add('No replica can be promoted yet', 'error'); run.later(1000, () => choose(a, run, waited)); return; }
      const b = bestReplica(reps);
      if (!b.full && !waited) {
        renderDecision(reps, b.avail, null, 'No replica has replayed all available WAL yet, so the admin waits briefly for one to catch up.');
        log.add('No replica has replayed all available WAL; waiting briefly', 'control');
        run.later(1200, () => choose(a, run, true));
        return;
      }
      const why = b.full ? `it has replayed all available WAL, up to ${lsnStr(b.avail)}` : `none caught up in time, and it received the most WAL (${lsnStr(b.pick.received)})`;
      incident.chosen = b.pick.i;
      renderDecision(reps, b.avail, b.pick, `${a.name} promotes ${b.pick.name}: ${why}.`);
      log.add(`${a.name} chooses ${b.pick.name}: ${why}`, 'control');
      const held = routers.some((r) => r.buffering);
      ctx.narrate(`<p>${a.name} picks <b>${b.pick.name}</b> because ${why}.</p><p>It asks ${b.pick.name}’s PostgresManager, through the Sidecar, to promote it. `
        + `${held ? 'Routers are still holding queries.' : 'The routers’ buffer windows have already run out, so queries are failing.'}</p>`);
      stepState('Choose replica', 'done');
      promoteVia(a, run, b.pick, 0.4 * F * 1000);
    }

    function promoteVia(a, run, pick, ms) {
      stepState('Promote', 'active');
      pick.promoting = true;
      paintNodes();
      pk(adminToSide(a, pick), { kind: 'control', duration: 450, onDone: run.guard(() => {
        pk(sideToPm(pick), { kind: 'control', duration: 250, r: 5, onDone: run.guard(() => {
          flash(pick.pm, 'active', Math.max(400, ms));
          run.later(Math.max(400, ms), () => promote(a, run, pick));
        }) });
      }) });
    }

    function promote(a, run, pick) {
      const old = inst[incident.old];
      pick.promoting = false;
      pick.role = 'primary';
      pick.readOnly = false;
      pick.following = pick.i;
      pick.received = pick.replayed;
      lsn = pick.replayed;
      history = [{ t: -1e9, lsn }];
      if (incident.kind === 'crash') old.role = 'down';
      else Object.assign(old, { role: 'replica', readOnly: false, following: -1, received: lsn, replayed: lsn });
      incident.promoted = true;
      stepState('Promote', 'done');
      log.add(`${pick.name} promoted through its PostgresManager${incident.kind === 'switchover' ? `, with every commit from ${old.name}` : ''}`, 'control');
      paintNodes(); drawDyn();
      run.later(300, () => repoint(a, run));
    }

    function repoint(a, run) {
      const P = inst[incident.chosen];
      const others = inst.filter((o) => o !== P && o.role === 'replica' && o.up && o.following !== P.i);
      stepState('Repoint', 'active');
      for (const o of others) {
        pk(adminToSide(a, o), { kind: 'control', duration: 450, onDone: () => pk(sideToPm(o), { kind: 'control', duration: 250, r: 5, onDone: () => {
          o.following = P.i;
          log.add(`${o.name} now replicates from ${P.name}`, 'control');
          paintNodes(); drawDyn();
        } }) });
      }
      run.later(others.length ? 800 : 150, () => publish(a, P));
    }

    function publish(a, P) {
      stepState('Repoint', 'done');
      stepState('Topology', 'active');
      pk(adminToTopo(a), { kind: 'control', duration: 300, onDone: () => {
        topoPrimary = P.i;
        topo.setSub(`primary: ${P.name}`);
        flash(topo, 'active', 700);
        log.add(`Topology service: the primary is now ${P.name}`, 'control');
        let left = routers.length;
        for (const r of routers) {
          pk(topoToRouter(r), { kind: 'mgmt', duration: 450, onDone: () => {
            r.primary = P.i;
            r.spent = false;
            stepState('Topology', 'done');
            stepState('Replan', 'active');
            if (r.buffering) stopBuffering(r);
            paintNodes(); drawDyn();
            if (--left === 0) finish(P);
          } });
        }
      } });
    }

    function finish(P) {
      const inc = incident;
      if (!inc) return;
      const dur = clock.now - inc.t0;
      stepState('Replan', 'done');
      inc.done = true;
      incident = null;
      lastFailover = { dur, kind: inc.kind, errors: inc.expired };
      log.add(`${inc.kind === 'crash' ? 'Failover' : 'Switchover'} finished in ${fmtMs(dur)}`, 'control');
      if (inc.kind === 'crash') {
        const old = inst[inc.old];
        ctx.narrate((inc.expired
          ? `<p>Failover took ${fmtMs(dur)}, longer than the ${W} s buffer window, so held queries came back as <b>errors</b>. Applications should retry transient failures like these.</p>`
          : `<p>Failover took ${fmtMs(dur)}. Routers held new queries and then replanned them against ${P.name}, so apart from the queries in flight at the crash, the app saw a <b>latency spike</b>, not errors.</p>`)
          + `<p>${old.name} rejoins as a replica a few seconds later (a fixed delay in this demo).</p>`);
        clock.after(8000, () => restore(old));
      } else {
        const old = inst[inc.old];
        ctx.narrate(`<p>Switchover done in ${fmtMs(dur)}. ${P.name} had replayed every commit before promotion, so nothing was lost. ${old.name} is now a replica, and its Sidecar and PostgresManager ran throughout.</p>`
          + '<p>Before Neki replaces a primary’s components, its orchestration layer asks the admin for exactly this kind of switchover.</p>');
      }
      updateButtons(); paintNodes();
    }

    function restore(old) {
      if (old.up) return;
      const P = primary();
      Object.assign(old, { up: true, role: 'replica', following: P ? P.i : -1, received: Math.max(LSN0, lsn - 0x1800), replayed: Math.max(LSN0, lsn - 0x1800) });
      log.add(`${old.name} is back as a replica of ${P ? P.name : '—'} (a fixed delay in this demo)`, 'mgmt');
      paintNodes(); drawDyn(); updateButtons();
    }

    function switchover() {
      const P = primary(), a = leader();
      if (incident || !P || !P.up || !a || !candidates().length) return;
      incident = { kind: 'switchover', t0: clock.now, old: P.i, chosen: -1, promoted: false, done: false, errors: 0, expired: false };
      setSteps(PLANNED, 'Switchover steps');
      updateButtons();
      log.add(`Planned switchover of ${P.name} requested`, 'control');
      ctx.narrate(`<p>A planned switchover starts with ${a.name} publishing a <b>buffering signal</b> to every router, so new queries wait instead of meeting the hand-off.</p>`);
      const run = newRun();
      stepState('Buffer signal', 'active');
      let left = routers.length;
      for (const r of routers) {
        pk(adminToRouter(a, r), { kind: 'control', duration: 450, onDone: () => {
          if (!r.buffering) startBuffering(r, 'signal');
          if (--left === 0) run.later(200, () => makeReadOnly(a, run, P));
        } });
      }
    }

    function makeReadOnly(a, run, P) {
      stepState('Buffer signal', 'done');
      stepState('Read-only', 'active');
      pk(adminToSide(a, P), { kind: 'control', duration: 450, onDone: run.guard(() => pk(sideToPm(P), { kind: 'control', duration: 250, r: 5, onDone: run.guard(() => {
        P.readOnly = true;
        paintNodes();
        log.add(`${P.name} is now read-only`, 'control');
        stepState('Read-only', 'done');
        stepState('Catch up', 'active');
        const reps = candidates();
        const b = bestReplica(reps);
        incident.chosen = b.pick.i;
        renderDecision(reps, b.avail, b.pick, `${b.pick.name} is the target. It must replay up to ${lsnStr(lsn)}, the old primary’s last commit, before promotion.`, 'target');
        log.add(`Waiting for ${b.pick.name} to replay up to ${lsnStr(lsn)}`, 'control');
        ctx.narrate(`<p>${P.name} is read-only, so its WAL stops growing at <code>${lsnStr(lsn)}</code>. ${a.name} waits for <b>${b.pick.name}</b> to replay up to that point, so no commit is lost.</p>`);
        waitCatchUp(a, run, P, b.pick);
      }) })) });
    }

    function waitCatchUp(a, run, P, pick) {
      if (pick.replayed < lsn) { run.later(200, () => waitCatchUp(a, run, P, pick)); return; }
      stepState('Catch up', 'done');
      log.add(`${pick.name} has replayed every commit (${lsnStr(lsn)})`, 'control');
      if (failSwitch) { revert(a, run, 'it failed before promotion (simulated)'); return; }
      promoteVia(a, run, pick, 600);
    }

    function revert(a, run, why) {
      const P = inst[incident.old];
      for (const o of inst) o.promoting = false;
      paintNodes();
      stepState('Promote', 'failed', 'Reverted');
      log.add(`Switchover stopped: ${why}`, 'error');
      const resume = () => {
        let left = routers.length;
        for (const r of routers) {
          pk(adminToRouter(a, r), { kind: 'control', duration: 450, onDone: () => {
            if (r.buffering) stopBuffering(r);
            if (--left === 0) finishRevert(P);
          } });
        }
      };
      if (!P.readOnly) { resume(); return; }
      pk(adminToSide(a, P), { kind: 'control', duration: 450, onDone: () => pk(sideToPm(P), { kind: 'control', duration: 250, r: 5, onDone: () => {
        P.readOnly = false;
        paintNodes();
        log.add(`${P.name} is writable again`, 'control');
        resume();
      } }) });
    }

    function finishRevert(P) {
      if (!incident) return;
      incident.done = true;
      incident = null;
      stepState('Replan', 'done');
      ctx.narrate(`<p>The switchover failed before promotion, so Neki made <b>${P.name}</b> writable again. Routers stopped buffering and ran the held queries on ${P.name}. The topology never changed.</p>`);
      updateButtons(); paintNodes();
    }

    function killLeader() {
      const a = leader();
      if (!a) return;
      a.up = false;
      a.leader = false;
      repairEp++;
      log.add(`${a.name}, the recovery leader, stopped`, 'error');
      ctx.narrate(`<p>${a.name} is gone. Its unfinished repair steps stop with it. Another admin takes recovery leadership after a short delay; until then nobody repairs the shard${incident ? ', so this recovery takes longer' : ''}.</p>`);
      paintNodes(); updateButtons();
      elect();
      clock.after(6000, () => {
        a.up = true;
        log.add(`${a.name} restarted as a standby`, 'mgmt');
        paintNodes();
        elect();
      });
    }

    function elect() {
      if (leader() || electing) return;
      if (!admins.some((x) => x.up)) return;
      electing = true;
      clock.after(2000, () => {
        electing = false;
        if (leader()) return;
        const c = admins.find((x) => x.up);
        if (!c) return;
        c.leader = true;
        log.add(`${c.name} takes recovery leadership`, 'control');
        paintNodes(); updateButtons();
        runRepair();
      });
    }

    // ---------- explanations ----------
    function explainInstance(o) {
      const role = !o.up ? 'down' : o.role === 'primary' ? `the primary${o.readOnly ? ' (read-only for now)' : ''}` : `a replica of ${o.following >= 0 ? inst[o.following].name : 'nothing yet'}`;
      ctx.narrate(`<p><b>${o.name}</b> in AZ ${o.az} is ${role}.${o.role === 'replica' && o.up ? ` It has received WAL up to <code>${lsnStr(o.received)}</code> and replayed up to <code>${lsnStr(o.replayed)}</code>.` : ''}</p>`
        + '<p>Its Sidecar is the endpoint for router queries and admin operations. Its PostgresManager starts, stops, and promotes Postgres for the admin.</p>');
    }
    function explainAdmin(a) {
      ctx.narrate(`<p><b>${a.name}</b> is ${!a.up ? 'down' : a.leader ? 'the <b>recovery leader</b>: it runs the health checks shown here and is the only admin that repairs the shard' : 'a standby. It can take recovery leadership if the leader goes away'}.</p>`);
    }
    function explainRouter(r) {
      ctx.narrate(`<p><b>${r.name}</b> sends queries to ${inst[r.primary].name}, the primary in its copy of the topology. `
        + `${r.buffering ? `It is buffering: ${r.buffer.length} held, for at most ${W} s.` : 'It is not buffering.'}</p>`);
    }
    function explainTopo() {
      ctx.narrate(`<p>The <b>topology service</b> stores the data topology and service-discovery records for routers, admins, replicators, and sidecars. Right now it lists ${inst[topoPrimary].name} as primary. After a failover the admin updates it, and routers pick up the change.</p>`);
    }

    // ---------- decision table ----------
    const decision = h('div', { style: { fontSize: '14px', color: 'var(--muted)' } }, 'No promotion yet. Crash the primary or start a switchover.');
    function renderDecision(reps, avail, pick, why, pickLabel = 'promote') {
      const rows = reps.map((o) => {
        const [tone, label] = o === pick ? ['good', pickLabel] : o.replayed >= avail ? ['', 'replayed all'] : ['warn', `behind ${kb(avail - o.replayed)}`];
        return `<tr><td>${o.name}</td><td class="mono">${lsnStr(o.received)}</td><td class="mono">${lsnStr(o.replayed)}</td>`
          + `<td><span class="pill"${tone ? ` data-tone="${tone}"` : ''}>${label}</span></td></tr>`;
      }).join('');
      decision.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Replica</th><th>Received</th><th>Replayed</th><th>Verdict</th></tr></thead>'
        + `<tbody>${rows}</tbody></table></div><p style="margin:8px 0 0;font-size:13px">${why}</p>`;
    }

    // ---------- controls ----------
    const crashBtn = button('Crash primary', crash, { variant: 'danger', icon: 'zap' });
    const killBtn = button('Kill admin leader', killLeader, { variant: 'danger', icon: 'x' });
    const swBtn = button('Planned switchover', switchover, { variant: 'control', icon: 'next' });
    function narrateTiming() {
      const total = F + 2;
      ctx.narrate(`<p>Detection and promotion take about ${F} s; repointing the other replica and publishing the topology add about 2 s more, so routers learn the new primary roughly ${total} s after a crash.</p>`
        + (total - 1 > W
          ? `<p>Routers hold queries for at most ${W} s, so after a crash held queries will likely come back as <b>errors</b>.</p>`
          : `<p>That fits inside the ${W} s buffer window, so after a crash the app should see a <b>latency spike</b>, not errors.</p>`));
    }
    ctx.toolbar.append(
      group('Unplanned', crashBtn, killBtn),
      group('Planned', swBtn, toggle({ label: 'Switchover fails before promotion', onChange: (v) => {
        failSwitch = v;
        log.add(v ? 'Next switchover will fail before promotion' : 'Switchovers succeed again', 'mgmt');
      } })),
      group('Timing · illustrative',
        slider({ label: 'Buffer window', min: 1, max: 10, value: W, unit: ' s', onInput: (v) => { W = v; narrateTiming(); } }),
        slider({ label: 'Failover time', min: 1, max: 15, value: F, unit: ' s', onInput: (v) => { F = v; narrateTiming(); } })),
      group('Shard',
        toggle({ label: 'Replica pg-2 is behind', onChange: (v) => {
          behind = v;
          log.add(v ? 'pg-2 now receives and replays WAL slowly' : 'pg-2 keeps up again', 'mgmt');
          ctx.narrate(v ? '<p>pg-2 now receives WAL late and replays it later still. If the primary fails, the admin should prefer the replica that has replayed all available WAL, so watch which one it promotes.</p>'
            : '<p>pg-2 keeps up again. Both replicas are close to the primary.</p>');
        } }),
        button('Reset', resetAll, { icon: 'restart' })),
    );

    const mPrimary = metric('Primary'), mBuffered = metric('Buffered queries'), mFailed = metric('Failed queries');
    const mLast = metric('Last failover'), mLeader = metric('Recovery leader');
    ctx.readout.append(mPrimary.el, mBuffered.el, mFailed.el, mLast.el, mLeader.el);

    const chartWrap = h('div');
    const chart = createChart(chartWrap, { label: 'What the app feels', max: 10000, unit: 'ms', bars: 60 });
    ctx.extra.append(
      chartWrap,
      h('p', { style: { margin: '6px 0 14px', fontSize: '13px', color: 'var(--faint)' } },
        'Each bar is 0.4 s of app traffic. Blue: normal. Orange: held in a router buffer. Red: an error came back. Times are illustrative.'),
      h('div', { style: { font: '500 11px var(--mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--faint)', margin: '0 0 6px' }, text: 'Last promotion choice' }),
      decision);

    // ---------- loops ----------
    function walTick() {
      for (const o of inst) {
        if (o.role !== 'replica' || !o.up) continue;
        const src = inst[o.following];
        if (src && src.role === 'primary' && src.up) { const v = lsnAt(clock.now - recvDelay(o)); if (v > o.received) o.received = v; }
        const rp = Math.min(o.received, lsnAt(clock.now - replayDelay(o)));
        if (rp > o.replayed) o.replayed = rp;
      }
      paintText();
    }
    function chartTick() {
      const now = clock.now;
      let held = 0;
      for (const r of routers) if (r.buffer.length) held = Math.max(held, now - r.buffer[0].t0 - 300);
      if (tick.err) chart.push(1, 'error');
      else if (held > 0 || tick.max > 400) chart.push(Math.max(held, tick.max), 'slow');
      else chart.push(tick.max || 20 + rand() * 15, 'ok');
      tick = { max: 0, err: 0 };
      refreshStatus();
      paintMetrics();
    }
    function arm() {
      clock.every(250, sendQuery, { immediate: true });
      clock.every(1000, healthChecks, { immediate: true });
      clock.every(100, walTick);
      clock.every(TICK, chartTick);
    }

    function resetAll() {
      clock.reset();
      sc.packets.textContent = '';
      live = 0;
      initState();
      setSteps(UNPLANNED, 'Failover steps · none running');
      chart.clear();
      decision.textContent = 'No promotion yet. Crash the primary or start a switchover.';
      paintNodes(); drawDyn(); paintText(); paintMetrics(); updateButtons();
      stKey = '';
      refreshStatus();
      log.add('Reset: pg-1 is primary, Admin A leads recovery', 'mgmt');
      ctx.narrate('<p>Back to the start: pg-1 is the primary, and Admin A holds recovery leadership.</p>');
      arm();
    }

    initState();
    setSteps(UNPLANNED, 'Failover steps · none running');
    paintNodes(); drawDyn(); paintText(); paintMetrics(); updateButtons(); refreshStatus();
    arm();
    ctx.narrate('<p>The app sends a steady stream of queries through three routers to <b>pg-1</b>, the primary. WAL streams from pg-1 to the two replicas.</p>'
      + '<p>Orange dots are the control plane: the recovery leader’s health checks reach each instance through its Sidecar. Try <b>Crash primary</b>, then compare the buffer window with the failover time.</p>');
  },
};
