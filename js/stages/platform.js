// Stage 7 · Platform. Desired configuration goes in through PlanetScale; the Neki operator
// diffs it against what is running and rolls changes one instance at a time.
import {
  h, s, scene, node, edge, packet, text, button, slider, select, group, metric, createChart, rng,
} from '../core.js';

const SH = ['A', 'B', 'C'];
const AZ = ['az-1', 'az-2', 'az-3'];
const SIZES = [{ value: 'S', label: 'Small (illustrative)' }, { value: 'M', label: 'Medium (illustrative)' },
  { value: 'L', label: 'Large (illustrative)' }];
const MAX_LIVE = 60;
const BAND = (i) => ({ x: 262 + i * 226, y: 190, w: 218, h: 230 });
const COL = (i) => 262 + i * 224;
const OP_OUT = [[216, 372], [240, 372]];
const OP2ADMIN = [[216, 396], [236, 396], [236, 476], [267, 476]];
const CHIP_STATE = { restoring: 'warn', joining: 'warn', replacing: 'warn', resizing: 'warn', removing: 'dim', switching: 'active' };

export default {
  id: 'platform',
  nav: 'Platform',
  kicker: 'Layer 5 · Orchestration',
  title: 'Desired state in, running cluster out',
  lede: 'You ask PlanetScale for a configuration. The Neki operator compares it with what is running and rolls the '
    + 'difference out one instance at a time, handing primaries over before it replaces them, while the app keeps working.',
  facts: [
    { text: 'The orchestration layer, the Neki operator, reconciles the configuration you request through PlanetScale into running routers, admin services, shards and Postgres instances.', href: 'https://planetscale.com/docs/neki/terminology' },
    { text: 'It coordinates rolling changes, resizing, backups, restores and replacement instances and reports readiness. It is not in the SQL query path and does not decide data placement.', href: 'https://planetscale.com/docs/neki/terminology' },
    { text: 'The operator creates, restarts and replaces each instance’s Sidecar and PostgresManager; the admin owns replication and failover. Before replacing a primary’s components the operator asks the admin for a planned switchover.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'A configuration profile sets cluster size, replica count, Postgres version, parameters and extensions for every shard assigned to it. Profile, router and admin changes are asynchronous: let one finish before a dependent change.', href: 'https://planetscale.com/docs/neki/cluster-configuration' },
    { text: 'A new production profile starts with two replicas. Each new replica is restored from the shard’s last backup, then joined to the primary.', href: 'https://planetscale.com/docs/neki/replicas' },
    { text: 'A shard that reports low disk space is treated as read-only by routers, which reject its writes until a disk or node resize. Shards do not need to be the same size.', href: 'https://planetscale.com/docs/neki/best-practices' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(5);
    const explain = (html) => () => ctx.narrate(html);

    // ---------- scene: static parts ----------
    const sc = scene(ctx.viz, 960, 580, 'The Neki operator reconciles a desired configuration into running routers, admin and shards');
    const ps = node(sc, { x: 16, y: 16, w: 200, h: 56, title: 'PlanetScale app + API', sub: 'where you ask for changes', kind: 'client',
      onClick: explain('<p>You change the configuration in the PlanetScale app or API: profiles, routers, admin. PlanetScale records it as the desired state and the operator does the rest.</p>'),
      label: 'PlanetScale app and API: explain' });
    const panel = node(sc, { x: 16, y: 100, w: 200, h: 218, title: '', kind: 'band',
      onClick: explain('<p>A <b>configuration profile</b> sets cluster size, replica count, Postgres version, parameters and extensions for every shard assigned to it. Changes apply asynchronously, so let one finish before you submit a dependent one.</p>'),
      label: 'Desired configuration: explain' });
    const op = node(sc, { x: 16, y: 346, w: 200, h: 64, title: 'Neki operator', sub: 'reconcile loop', kind: 'mgmt',
      onClick: explain('<p>The <b>Neki operator</b> keeps comparing what you asked for with what is running and closes the gap. It creates, restarts and replaces each instance’s Sidecar and PostgresManager, and runs backups, restores and resizes.</p><p>It sits outside the query path: queries never pass through it, and it does not decide where rows live.</p>'),
      label: 'Neki operator: explain' });
    node(sc, { x: 250, y: 72, w: 694, h: 474, title: '', kind: 'band' });
    text(sc, 932, 88, 'Running cluster', { cls: 'label', anchor: 'end' });
    const app = node(sc, { x: 600, y: 12, w: 140, h: 48, title: 'App', sub: 'reads + writes', kind: 'client' });
    node(sc, { x: 262, y: 104, w: 670, h: 68, title: '', kind: 'shard' });
    AZ.forEach((z, i) => text(sc, COL(i) + 14, 122, `routers · ${z}`, { cls: 'label' }));
    const bandNodes = {}, bandText = {};
    SH.forEach((k, i) => {
      const b = BAND(i);
      bandNodes[k] = node(sc, { ...b, title: '', kind: 'shard' });
      text(sc, b.x + 12, b.y + 24, `Shard ${k}`, { cls: 'text text--strong' });
      bandText[k] = {
        backup: text(sc, b.x + b.w - 10, b.y + 24, '', { cls: 'text', anchor: 'end' }),
        disk: text(sc, b.x + 10, b.y + 221, '', { cls: 'text' }),
      };
      s('rect', { x: b.x + 140, y: b.y + 213, width: 68, height: 8, rx: 4, class: 'bar-bg' }, sc.labels);
      bandText[k].bar = s('rect', { x: b.x + 140, y: b.y + 213, width: 0, height: 8, rx: 4, class: 'bar--query' }, sc.labels);
    });
    const admin = node(sc, { x: 271, y: 450, w: 200, h: 52, title: 'Admin', sub: 'replication · failover', kind: 'control',
      onClick: explain('<p>The <b>admin</b> watches Postgres instances and owns replication and failover. When the operator needs to replace a primary’s components, it first asks the admin for a planned switchover to a healthy replica and waits for the new primary.</p>'),
      label: 'Admin: explain' });
    const routerLayer = s('g', {}, sc.nodes);
    const chipLayer = Object.fromEntries(SH.map((k) => [k, s('g', {}, sc.nodes)]));

    edge(sc, [ps.bottom, [116, 96]], { kind: 'mgmt' });
    edge(sc, [panel.bottom, [116, 342]], { kind: 'mgmt' });
    edge(sc, [[216, 372], [246, 372]], { kind: 'mgmt' });
    edge(sc, OP2ADMIN, { kind: 'mgmt', dashed: true });
    edge(sc, [app.bottom, [670, 100]], { kind: 'query' });
    const adminEdge = {};
    SH.forEach((k, i) => {
      const cx = BAND(i).x + 109;
      edge(sc, [[cx, 172], [cx, 186]], { kind: 'query' });
      adminEdge[k] = i === 0 ? [[371, 450], [371, 424]] : [[371, 436], [cx, 436], [cx, 424]];
      edge(sc, adminEdge[k], { kind: 'control' });
    });

    text(sc, 28, 122, 'Desired configuration', { cls: 'label' });
    const ROWS = [['replicas', 'replicas / shard'], ['routers', 'routers / AZ'], ['size', 'cluster size'], ['ver', 'Postgres'], ['disk', 'disk A/B/C']];
    const rowVal = {};
    ROWS.forEach(([key, label], i) => {
      text(sc, 28, 150 + i * 26, label, { cls: 'text' });
      rowVal[key] = text(sc, 204, 150 + i * 26, '', { cls: 'text text--strong mono', anchor: 'end' });
    });
    const panelNote1 = text(sc, 28, 288, '', { cls: 'text' });
    const panelNote2 = text(sc, 28, 306, '', { cls: 'text' });

    text(sc, 16, 434, 'Operator now', { cls: 'label' });
    const opL1 = text(sc, 16, 454, '', { cls: 'text text--ink' });
    const opL2 = text(sc, 16, 472, '', { cls: 'text' });
    s('rect', { x: 16, y: 482, width: 200, height: 8, rx: 4, class: 'bar-bg' }, sc.labels);
    const opBar = s('rect', { x: 16, y: 482, width: 0, height: 8, rx: 4, class: 'bar--control' }, sc.labels);

    text(sc, 500, 458, 'Changes', { cls: 'label' });
    const changeRows = [0, 1, 2, 3].map((i) => ({
      label: text(sc, 500, 478 + i * 19, '', { cls: 'text text--ink' }),
      state: text(sc, 932, 478 + i * 19, '', { cls: 'text', anchor: 'end' }),
    }));

    const legend = [['query', 6, 'app write'], ['query', 4, 'app read'], ['danger', 6, 'rejected write'], ['mgmt', 5, 'operator'], ['control', 5, 'admin / replication']];
    let lx = 16;
    for (const [kind, r, label] of legend) {
      s('circle', { cx: lx + 6, cy: 566, r, class: `packet packet--${kind}` }, sc.labels);
      text(sc, lx + 18, 570, label, { cls: 'text' });
      lx += 32 + label.length * 7.4;
    }

    // ---------- state ----------
    let draft, desired, shards, routers, changes, seq, iid, rid, busy, held, holdShard, writeErrs, bucket;
    let lastBeat, backupTurn, epoch = 0, live = 0, lastStatus = '', filling = null;

    const mk = (role, spec, disk) => ({ id: ++iid, role, ver: spec.ver, size: spec.size, disk, state: null, pct: 0, next: null, chip: null });
    function initState() {
      iid = 0; rid = 0; seq = 0;
      draft = { replicas: 2, routers: 1, size: 'M', ver: '17.4' };
      desired = { ...draft };
      shards = {};
      SH.forEach((k, i) => {
        shards[k] = { k, i, used: [44, 41, 47][i], diskGB: 100, readOnly: false, backupAt: clock.now - (i + 1) * 3000, backingUp: false,
          insts: [mk('primary', desired, 100), mk('replica', desired, 100), mk('replica', desired, 100)] };
      });
      routers = Object.fromEntries(AZ.map((z) => [z, [{ id: ++rid, state: null }]]));
      changes = []; busy = false; held = []; holdShard = null; writeErrs = 0;
      bucket = { err: false, slow: false };
      lastBeat = clock.now; backupTurn = 0; filling = null;
    }

    const guard = () => { const e = epoch; return (fn) => (...a) => { if (e === epoch) fn(...a); }; };
    const primaryOf = (sh) => sh.insts.find((i) => i.role === 'primary');
    const replicasOf = (sh) => sh.insts.filter((i) => i.role === 'replica');
    const matches = (i, t) => i.ver === t.ver && i.size === t.size;
    const pending = () => changes.filter((c) => c.status !== 'done');

    function pkt(points, { kind = 'query', duration = 600, r = 5, onDone } = {}, essential = false) {
      if (live >= MAX_LIVE) { if (essential && onDone) onDone(); return; }
      live++;
      packet(sc, clock, points, { kind, duration, r, onDone: () => { live--; if (onDone) onDone(); } });
    }

    // ---------- drawing ----------
    function chipTitle(i) {
      if (i.state === 'restoring') return `new replica · restore ${Math.round(i.pct * 100)}%`;
      if (i.state === 'joining') return 'new replica · joining';
      if (i.state === 'replacing') return `replacing → ${i.next.ver} · ${i.next.size}`;
      if (i.state === 'removing') return 'replica · removing';
      if (i.state === 'resizing') return `${i.role} · resizing disk`;
      if (i.state === 'switching') return 'primary · handing over';
      return `${i.role} · ${i.ver} · ${i.size}`;
    }
    function layoutShard(k) {
      const sh = shards[k], b = BAND(sh.i);
      chipLayer[k].textContent = '';
      sh.insts.forEach((inst, j) => {
        inst.chip = node(sc, { x: b.x + 10, y: b.y + 33 + j * 34, w: 198, h: 28, rx: 6, title: chipTitle(inst),
          kind: inst.role === 'primary' ? 'pg' : 'pm', layer: chipLayer[k] });
        inst.chip.setState(CHIP_STATE[inst.state] || null);
      });
    }
    function updateChip(inst) {
      inst.chip.g.setAttribute('class', `node node--${inst.role === 'primary' ? 'pg' : 'pm'}`);
      inst.chip.setTitle(chipTitle(inst));
      inst.chip.setState(CHIP_STATE[inst.state] || null);
    }
    function layoutRouters() {
      routerLayer.textContent = '';
      AZ.forEach((z, i) => routers[z].forEach((r, j) => {
        r.chip = node(sc, { x: COL(i) + 14 + j * 68, y: 130, w: 62, h: 32, rx: 6, title: 'router', kind: 'router', layer: routerLayer });
        r.chip.setState(r.state === 'starting' ? 'warn' : (r.state === 'draining' ? 'dim' : null));
      }));
    }

    // ---------- paths ----------
    const appToRouter = (r) => [app.bottom, [670, 98], [r.chip.cx, 98], r.chip.top];
    function routerToChip(r, sh, inst) {
      const b = BAND(sh.i), gx = b.x + 213, c = inst.chip;
      return [r.chip.bottom, [r.chip.cx, 180], [gx, 180], [gx, c.cy], [c.x + c.w + 2, c.cy]];
    }
    const opToShard = (sh) => { const b = BAND(sh.i); return [...OP_OUT, [240, 184], [b.x + 30, 184], [b.x + 30, b.y]]; };
    const opToRouters = () => [...OP_OUT, [240, 138], [262, 138]];
    function backupToChip(sh, inst) {
      const b = BAND(sh.i), gx = b.x + 213;
      return [[b.x + 150, b.y + 26], [gx, b.y + 26], [gx, inst.chip.cy], [inst.chip.x + 200, inst.chip.cy]];
    }
    function replicate(sh, from, to) {
      const b = BAND(sh.i);
      return [[from.chip.x + 2, from.chip.cy], [b.x + 4, from.chip.cy], [b.x + 4, to.chip.cy], [to.chip.x - 2, to.chip.cy]];
    }

    // ---------- app traffic ----------
    function pickRouter() {
      const ok = AZ.flatMap((z) => routers[z].filter((r) => !r.state));
      return ok.length ? ok[Math.floor(rand() * ok.length)] : null;
    }
    function appTick() {
      if (live >= MAX_LIVE) return;
      const r = pickRouter();
      if (!r) return;
      const sh = shards[SH[Math.floor(rand() * 3)]];
      const write = rand() < 0.35;
      pkt(appToRouter(r), { duration: 420, r: write ? 6 : 4, onDone: () => atRouter(r, sh, write) });
    }
    function atRouter(r, sh, write) {
      if (write && sh.readOnly) {
        writeErrs++;
        bucket.err = true;
        pkt([...appToRouter(r)].reverse(), { kind: 'danger', duration: 420, r: 6 });
        return;
      }
      if (write && holdShard === sh.k) { held.push(r); bucket.slow = true; return; }
      const reps = replicasOf(sh).filter((i) => !i.state);
      const inst = write || !reps.length ? primaryOf(sh) : reps[Math.floor(rand() * reps.length)];
      pkt(routerToChip(r, sh, inst), { duration: 520, r: write ? 6 : 4 });
    }

    // ---------- operator steps ----------
    function opSay(l1, l2 = '', pct = null) {
      opL1.textContent = l1;
      opL2.textContent = l2;
      opBar.setAttribute('width', pct == null ? 0 : 200 * Math.min(1, pct));
    }
    function toShard(sh, then) { pkt(opToShard(sh), { kind: 'mgmt', duration: 600, r: 5, onDone: guard()(then) }, true); }

    function addReplica(ch, sh, t, done) {
      const g = guard();
      const inst = mk('replica', t, sh.diskGB);
      inst.state = 'restoring';
      sh.insts.push(inst);
      layoutShard(sh.k);
      opSay(`#${ch.id} · shard ${sh.k}: new replica`, 'restore from last backup', 0);
      log.add(`Shard ${sh.k}: new replica restoring from the shard's last backup`, 'mgmt');
      toShard(sh, () => {
        pkt(backupToChip(sh, inst), { kind: 'mgmt', duration: 600, r: 5 });
        const stop = clock.every(220, g(() => {
          inst.pct = Math.min(1, inst.pct + 0.1);
          updateChip(inst);
          opSay(`#${ch.id} · shard ${sh.k}: new replica`, 'restore from last backup', inst.pct);
          if (inst.pct < 1) return;
          stop();
          inst.state = 'joining';
          updateChip(inst);
          opSay(`#${ch.id} · shard ${sh.k}: new replica`, 'join the primary', 1);
          pkt(replicate(sh, primaryOf(sh), inst), { kind: 'control', duration: 800, r: 5, onDone: g(() => {
            inst.state = null;
            updateChip(inst);
            log.add(`Shard ${sh.k}: replica joined the primary and is replicating`, 'control');
            done();
          }) }, true);
        }));
      });
    }
    function removeReplica(ch, sh, inst, done) {
      inst.state = 'removing';
      updateChip(inst);
      opSay(`#${ch.id} · shard ${sh.k}: remove replica`, 'drain and delete');
      toShard(sh, () => clock.after(700, guard()(() => {
        sh.insts = sh.insts.filter((i) => i !== inst);
        layoutShard(sh.k);
        log.add(`Shard ${sh.k}: replica removed`, 'mgmt');
        done();
      })));
    }
    function replaceReplica(ch, sh, inst, t, done) {
      inst.state = 'replacing';
      inst.next = { ver: t.ver, size: t.size };
      updateChip(inst);
      opSay(`#${ch.id} · shard ${sh.k}: replace replica`, `new instance: ${t.ver} · ${t.size}`, 0.5);
      toShard(sh, () => clock.after(1000, guard()(() => {
        Object.assign(inst, { id: ++iid, ver: t.ver, size: t.size, state: null, next: null });
        updateChip(inst);
        log.add(`Shard ${sh.k}: replica replaced (${t.ver} · ${t.size})`, 'mgmt');
        done();
      })));
    }
    function switchover(ch, sh, t, done) {
      const g = guard();
      const target = replicasOf(sh).find((i) => matches(i, t) && !i.state);
      const old = primaryOf(sh);
      if (!target) { done(); return; }
      opSay(`#${ch.id} · shard ${sh.k}: primary is next`, 'ask admin: planned switchover');
      log.add(`Operator asks the admin for a planned switchover on shard ${sh.k}`, 'mgmt');
      ctx.narrate(`<p>Every replica on shard ${sh.k} is done; only the primary is left. The operator does not replace it directly: it asks the <b>admin</b> for a planned switchover to a healthy, updated replica and waits.</p><p>While the primary hands over, routers hold writes to shard ${sh.k} for a moment. The app sees a short slowdown, not errors.</p>`);
      pkt(OP2ADMIN, { kind: 'mgmt', duration: 600, r: 5, onDone: g(() => {
        admin.setState('active');
        pkt([...adminEdge[sh.k]], { kind: 'control', duration: 500, r: 5, onDone: g(() => {
          holdShard = sh.k;
          old.state = 'switching';
          updateChip(old);
          bandNodes[sh.k].tag('writes held', 'control');
          clock.after(1100, g(() => {
            old.role = 'replica'; old.state = null;
            target.role = 'primary';
            sh.insts = [target, ...sh.insts.filter((i) => i !== target)];
            layoutShard(sh.k);
            holdShard = null;
            bandNodes[sh.k].tag(null);
            const release = held.splice(0);
            release.slice(0, 8).forEach((r) => pkt(routerToChip(r, sh, target), { duration: 520, r: 6 }));
            log.add(`Admin promoted an updated replica on shard ${sh.k}; ${release.length} held ${release.length === 1 ? 'write' : 'writes'} resumed`, 'control');
            pkt([...OP2ADMIN].reverse(), { kind: 'mgmt', duration: 600, r: 5, onDone: g(() => {
              admin.setState(null);
              log.add(`Admin confirmed the new primary on ${sh.k}; the old one can now be replaced`, 'mgmt');
              done();
            }) }, true);
          }));
        }) }, true);
      }) }, true);
    }
    function addRouter(ch, z, done) {
      const r = { id: ++rid, state: 'starting' };
      routers[z].push(r);
      layoutRouters();
      opSay(`#${ch.id} · ${z}: add router`, 'start and wait for ready', 0.5);
      pkt(opToRouters(), { kind: 'mgmt', duration: 600, r: 5, onDone: guard()(() => clock.after(800, guard()(() => {
        r.state = null;
        layoutRouters();
        log.add(`Router added in ${z}`, 'mgmt');
        done();
      }))) }, true);
    }
    function removeRouter(ch, z, done) {
      const r = routers[z][routers[z].length - 1];
      r.state = 'draining';
      layoutRouters();
      opSay(`#${ch.id} · ${z}: remove router`, 'drain, then delete', 0.5);
      pkt(opToRouters(), { kind: 'mgmt', duration: 600, r: 5, onDone: guard()(() => clock.after(700, guard()(() => {
        routers[z] = routers[z].filter((x) => x !== r);
        layoutRouters();
        log.add(`Router removed from ${z}`, 'mgmt');
        done();
      }))) }, true);
    }
    function resizeDisk(ch, sh, inst, gb, done) {
      inst.state = 'resizing';
      updateChip(inst);
      const left = sh.insts.filter((i) => i.disk < gb).length;
      opSay(`#${ch.id} · shard ${sh.k}: resize disk`, `${left} of ${sh.insts.length} instances left`, 1 - left / sh.insts.length);
      toShard(sh, () => clock.after(800, guard()(() => {
        inst.disk = gb; inst.state = null;
        updateChip(inst);
        done();
      })));
    }

    function planNext(ch) {
      const t = ch.target;
      if (ch.kind === 'routers') {
        for (const z of AZ) {
          if (routers[z].length < t.routers) return (done) => addRouter(ch, z, done);
          if (routers[z].length > t.routers) return (done) => removeRouter(ch, z, done);
        }
        return null;
      }
      if (ch.kind === 'disk') {
        const sh = shards[ch.shard];
        const inst = [...replicasOf(sh), primaryOf(sh)].find((i) => i.disk < t.diskGB);
        return inst ? (done) => resizeDisk(ch, sh, inst, t.diskGB, done) : null;
      }
      for (const k of SH) {
        const sh = shards[k], reps = replicasOf(sh);
        if (reps.length < t.replicas) return (done) => addReplica(ch, sh, t, done);
        if (reps.length > t.replicas) {
          const victim = reps.find((i) => !matches(i, t)) || reps[reps.length - 1];
          return (done) => removeReplica(ch, sh, victim, done);
        }
        const stale = reps.find((i) => !matches(i, t));
        if (stale) return (done) => replaceReplica(ch, sh, stale, t, done);
        if (!matches(primaryOf(sh), t)) return (done) => switchover(ch, sh, t, done);
      }
      return null;
    }

    function reconcileTick() {
      if (busy) return;
      const ch = changes.find((c) => c.status !== 'done');
      if (!ch || clock.now < ch.readyAt) {
        if (!ch && clock.now - lastBeat > 3000) {
          lastBeat = clock.now;
          pkt([[216, 372], [246, 372]], { kind: 'mgmt', duration: 400, r: 4 });
          opSay('Idle', 'desired state matches what runs');
        }
        return;
      }
      if (ch.status === 'queued') {
        ch.status = 'in progress';
        log.add(`Change #${ch.id} started: ${ch.label}`, 'mgmt');
        drawChanges();
      }
      const step = planNext(ch);
      if (!step) { finishChange(ch); return; }
      busy = true;
      step(guard()(() => { busy = false; }));
    }
    function finishChange(ch) {
      ch.status = 'done';
      log.add(`Change #${ch.id} done: ${ch.label}`, 'mgmt');
      drawChanges();
      lastBeat = clock.now;
      if (ch.kind === 'disk') {
        const sh = shards[ch.shard];
        sh.diskGB = ch.target.diskGB;
        sh.readOnly = false;
        bandNodes[sh.k].setState(null);
        bandNodes[sh.k].tag(null);
        updateControls();
        log.add(`Shard ${sh.k} has room again; routers accept its writes`, 'query');
        opSay('Idle', 'desired state matches what runs');
        ctx.narrate(`<p>Every instance on shard ${sh.k} now has a ${sh.diskGB} GB disk, so the shard no longer reports low space. Routers accept writes to its rows again and the errors stop.</p><p>Shards A and B were never affected, and shards do not need to be the same size.</p>`);
        return;
      }
      const next = pending()[0];
      ctx.narrate(next
        ? `<p>Change #${ch.id} is done. The queued change #${next.id} starts now.</p>`
        : `<p>Change #${ch.id} is done and the cluster matches the desired configuration. The app never saw an error; at most a short slowdown while a primary handed over.</p>`);
      opSay('Idle', 'desired state matches what runs');
    }

    // ---------- user actions ----------
    function apply() {
      const edits = [];
      if (draft.replicas !== desired.replicas) edits.push(`replicas ${desired.replicas} → ${draft.replicas}`);
      if (draft.size !== desired.size) edits.push(`size ${desired.size} → ${draft.size}`);
      if (draft.ver !== desired.ver) edits.push(`Postgres ${desired.ver} → ${draft.ver}`);
      const routerEdit = draft.routers !== desired.routers;
      if (!edits.length && !routerEdit) {
        ctx.narrate('<p>Nothing to apply: the draft matches the desired configuration. Move a slider, pick a size or bump the Postgres version first.</p>');
        return;
      }
      const wasBusy = pending().length > 0;
      const readyAt = clock.now + 1300;
      const added = [];
      if (edits.length) added.push({ kind: 'profile', label: `Profile: ${edits.join(', ')}`, target: { replicas: draft.replicas, size: draft.size, ver: draft.ver } });
      if (routerEdit) added.push({ kind: 'routers', label: `Routers: ${desired.routers} → ${draft.routers} per AZ`, target: { routers: draft.routers } });
      for (const c of added) changes.push({ ...c, id: ++seq, status: 'queued', readyAt });
      Object.assign(desired, draft);
      const g = guard();
      pkt([ps.bottom, [116, 100]], { kind: 'mgmt', duration: 400, r: 5, onDone: g(() =>
        pkt([panel.bottom, op.top], { kind: 'mgmt', duration: 400, r: 5 })) });
      for (const c of added) log.add(`Submitted change #${c.id}: ${c.label}`, 'mgmt');
      drawChanges();
      const queued = wasBusy || added.length > 1;
      ctx.narrate(`<p>PlanetScale records the new desired state; the operator sees the difference and plans the work.</p>${edits.some((e) => e.startsWith('replicas') && draft.replicas > 2) ? '<p>Each new replica is restored from its shard’s last backup, then joined to the primary.</p>' : ''}${edits.some((e) => !e.startsWith('replicas')) ? '<p>Replicas are replaced first. For each primary the operator asks the admin for a planned switchover before replacing it.</p>' : ''}${queued ? '<p>Changes apply asynchronously, and a dependent change should wait for the previous one to finish. Here the operator queues them and runs one at a time.</p>' : ''}`);
    }

    function bump() {
      const [maj, min] = draft.ver.split('.').map(Number);
      if (min >= 9) return;
      draft.ver = `${maj}.${min + 1}`;
      bumpLabel();
      log.add(`Draft: Postgres ${draft.ver} (not applied yet)`, 'info');
      refresh();
    }
    function bumpLabel() {
      const [maj, min] = draft.ver.split('.').map(Number);
      bumpBtn.replaceChildren(min >= 9 ? 'Postgres at 17.9' : `Bump Postgres to ${maj}.${min + 1}`);
      bumpBtn.disabled = min >= 9;
    }

    function fillDisk() {
      const sh = shards.C;
      if (sh.readOnly || filling) return;
      log.add('Shard C fills up: a large import lands on its rows (illustrative)', 'query');
      ctx.narrate('<p>A burst of data fills shard C’s disk. Watch its disk bar.</p>');
      const g = guard();
      filling = clock.every(100, g(() => {
        sh.used = Math.min(sh.diskGB * 0.97, sh.used + sh.diskGB * 0.04);
        if (sh.used < sh.diskGB * 0.97) return;
        filling(); filling = null;
        sh.readOnly = true;
        bandNodes.C.setState('warn');
        bandNodes.C.tag('read-only', 'danger');
        log.add('Shard C reports low disk space; routers treat it as read-only', 'error');
        ctx.narrate('<p>Shard C reports low disk space, so routers treat it as <b>read-only</b>: they reject writes to its rows. Reads from C keep working, and shards A and B are not affected at all.</p><p>Press <b>Resize disk</b> to have the operator grow it.</p>');
        updateControls();
      }));
      updateControls();
    }
    function resize() {
      const sh = shards.C;
      if (!sh.readOnly || changes.some((c) => c.kind === 'disk' && c.status !== 'done')) return;
      const gb = sh.diskGB * 2;
      changes.push({ id: ++seq, kind: 'disk', shard: 'C', label: `Disk: shard C ${sh.diskGB} → ${gb} GB`, target: { diskGB: gb }, status: 'queued', readyAt: clock.now + 600 });
      log.add(`Submitted change #${seq}: resize shard C disk to ${gb} GB`, 'mgmt');
      ctx.narrate(`<p>The operator rolls the resize through shard C one instance at a time, replicas first. Writes to C stay rejected until the shard has room again.</p>${pending().length > 1 ? '<p>Another change is still running, so this one waits its turn.</p>' : ''}`);
      drawChanges();
      updateControls();
    }

    function backupTick() {
      const sh = shards[SH[backupTurn++ % 3]];
      sh.backingUp = true;
      pkt(opToShard(sh), { kind: 'mgmt', duration: 600, r: 4 });
      clock.after(1800, guard()(() => { sh.backingUp = false; sh.backupAt = clock.now; }));
    }

    function chartTick() {
      if (bucket.err) chart.push(400, 'error');
      else if (holdShard || bucket.slow) chart.push(160 + rand() * 160, 'slow');
      else chart.push(6 + rand() * 9, 'ok');
      bucket = { err: false, slow: false };
      const ro = SH.filter((k) => shards[k].readOnly);
      let st = 'normal', txt = 'Normal: queries run as usual';
      if (ro.length) { st = 'error'; txt = `Errors: writes to shard ${ro.join(', ')} are rejected; reads and other shards work`; }
      else if (holdShard) { st = 'slower'; txt = `Slower: writes to shard ${holdShard} are held during a planned switchover`; }
      if (txt !== lastStatus) { status.set(st, txt); lastStatus = txt; }
      refresh();
    }

    // ---------- readouts ----------
    function diffCount() {
      let n = 0;
      for (const k of SH) {
        const sh = shards[k];
        n += Math.abs(replicasOf(sh).length - desired.replicas);
        n += sh.insts.filter((i) => !matches(i, desired)).length;
      }
      for (const z of AZ) n += Math.abs(routers[z].length - desired.routers);
      for (const c of pending()) if (c.kind === 'disk') n += shards[c.shard].insts.filter((i) => i.disk < c.target.diskGB).length;
      return n;
    }
    function refresh() {
      const diff = diffCount();
      const showRow = (key, want, edit) => {
        rowVal[key].textContent = edit !== want ? `${want} › ${edit}` : String(want);
        rowVal[key].setAttribute('class', `text text--strong mono${edit !== want ? ' text--control' : ''}`);
      };
      showRow('replicas', desired.replicas, draft.replicas);
      showRow('routers', desired.routers, draft.routers);
      showRow('size', desired.size, draft.size);
      showRow('ver', desired.ver, draft.ver);
      const diskWant = SH.map((k) => { const c = pending().find((x) => x.kind === 'disk' && x.shard === k); return c ? c.target.diskGB : shards[k].diskGB; });
      rowVal.disk.textContent = `${diskWant.join('/')} GB`;
      const edits = ['replicas', 'routers', 'size', 'ver'].filter((k) => draft[k] !== desired[k]).length;
      panelNote1.textContent = diff ? `rolling out: ${diff} to change` : 'running = desired';
      panelNote1.setAttribute('class', diff ? 'text text--control' : 'text text--query');
      panelNote2.textContent = edits ? `${edits} draft ${edits === 1 ? 'edit' : 'edits'}: press Apply` : '';
      panelNote2.setAttribute('class', edits ? 'text text--control' : 'text');
      for (const k of SH) {
        const sh = shards[k], t = bandText[k];
        const pct = sh.used / sh.diskGB;
        const backup = sh.backingUp ? 'backup running…' : `backup ${Math.round((clock.now - sh.backupAt) / 1000)}s ago`;
        if (t.backup.textContent !== backup) t.backup.textContent = backup;
        t.disk.textContent = `disk ${Math.round(pct * 100)}% of ${sh.diskGB} GB`;
        t.disk.setAttribute('class', pct > 0.9 ? 'text text--danger' : 'text');
        t.bar.setAttribute('width', 68 * pct);
        t.bar.setAttribute('class', pct > 0.9 ? 'bar--danger' : 'bar--query');
      }
      const vers = {};
      for (const k of SH) for (const i of shards[k].insts) vers[i.ver] = (vers[i.ver] || 0) + 1;
      mDiff.set(String(diff), diff ? 'warn' : 'good');
      const p = pending();
      mChanges.set(p.length ? `${p.filter((c) => c.status === 'in progress').length} running · ${p.filter((c) => c.status === 'queued').length} queued` : 'none');
      mErr.set(String(writeErrs), shards.C.readOnly ? 'bad' : null);
      mVer.set(Object.entries(vers).sort().map(([v, n]) => `${v} ×${n}`).join(' · '));
      mRouters.set(String(AZ.reduce((a, z) => a + routers[z].length, 0)));
      applyBtn.replaceChildren(edits ? `Apply (${edits} ${edits === 1 ? 'edit' : 'edits'})` : 'Apply');
    }
    function drawChanges() {
      const order = [...changes.filter((c) => c.status === 'in progress'), ...changes.filter((c) => c.status === 'queued'),
        ...changes.filter((c) => c.status === 'done').reverse()];
      changeRows.forEach((row, i) => {
        const c = order[i];
        row.label.textContent = c ? `#${c.id} ${c.label.length > 44 ? `${c.label.slice(0, 43)}…` : c.label}` : (i === 0 ? 'No changes yet' : '');
        row.label.setAttribute('class', c ? 'text text--ink' : 'text');
        row.state.textContent = c ? c.status : '';
        row.state.setAttribute('class', `text${c && c.status === 'in progress' ? ' text--control' : (c && c.status === 'done' ? ' text--query' : '')}`);
      });
      refresh();
    }
    function updateControls() {
      const C = shards.C;
      fillBtn.disabled = C.readOnly || !!filling;
      resizeBtn.disabled = !C.readOnly || changes.some((c) => c.kind === 'disk' && c.status !== 'done');
    }

    function restart() {
      clock.reset();
      sc.packets.textContent = '';
      live = 0;
      epoch++;
      initState();
      SH.forEach((k) => { layoutShard(k); bandNodes[k].setState(null); bandNodes[k].tag(null); });
      layoutRouters();
      admin.setState(null);
      repSl.set(2); rtSl.set(1); sizeSel.set('M');
      bumpLabel();
      chart.clear();
      opSay('Idle', 'desired state matches what runs');
      drawChanges();
      updateControls();
      arm();
    }

    // ---------- controls ----------
    const repSl = slider({ label: 'Replicas per shard', min: 2, max: 4, value: 2, onInput: (v) => { draft.replicas = v; refresh(); } });
    const rtSl = slider({ label: 'Routers per AZ', min: 1, max: 3, value: 1, onInput: (v) => { draft.routers = v; refresh(); } });
    const sizeSel = select({ label: 'Cluster size', options: SIZES, value: 'M', onChange: (v) => { draft.size = v; refresh(); log.add(`Draft: cluster size ${v} (not applied yet)`, 'info'); } });
    const bumpBtn = button('', bump);
    const applyBtn = button('Apply', apply, { variant: 'primary', icon: 'send' });
    const fillBtn = button('Fill shard C’s disk', fillDisk, { variant: 'danger', icon: 'zap' });
    const resizeBtn = button('Resize disk', resize, { variant: 'control', icon: 'plus' });
    ctx.toolbar.append(
      group('Desired configuration', repSl, rtSl, sizeSel, bumpBtn, applyBtn),
      group('Disk pressure', fillBtn, resizeBtn),
      group('Scene', button('Reset', () => { restart(); log.add('Reset to two replicas per shard, one router per AZ', 'mgmt'); ctx.narrate(intro); }, { icon: 'restart' })),
    );

    const mDiff = metric('Desired ≠ running'), mChanges = metric('Changes'), mErr = metric('Write errors', '0'),
      mVer = metric('Postgres'), mRouters = metric('Routers');
    ctx.readout.append(mDiff.el, mChanges.el, mErr.el, mVer.el, mRouters.el);
    const chartBox = h('div', { style: { maxWidth: '720px' } });
    ctx.extra.append(chartBox);
    const chart = createChart(chartBox, { label: 'App latency (illustrative)', max: 400, unit: 'ms' });
    ctx.extra.append(h('p', { style: { margin: '10px 0 0', fontSize: '13px', color: 'var(--faint)' },
      text: 'Sizes, versions, disk numbers and timings are illustrative. The operator here runs one change at a time; in the product, wait for a change to finish before you submit a dependent one.' }));

    function arm() {
      clock.every(200, appTick);
      clock.every(400, reconcileTick);
      clock.every(250, chartTick, { immediate: true });
      clock.every(9000, backupTick);
    }

    const intro = '<p>Three shards, each with a primary and two replicas, behind one router per availability zone. App traffic flows the whole time.</p>'
      + '<p>Change the <b>desired configuration</b> and press <b>Apply</b>. The <b>Neki operator</b> diffs it against what runs and rolls the change out one instance at a time. Try a Postgres bump to see a planned switchover, or fill shard C’s disk.</p>';
    initState();
    SH.forEach((k) => layoutShard(k));
    layoutRouters();
    bumpLabel();
    opSay('Idle', 'desired state matches what runs');
    drawChanges();
    updateControls();
    status.set('normal', 'Normal: queries run as usual');
    lastStatus = 'Normal: queries run as usual';
    ctx.narrate(intro);
    log.add('App traffic on: reads go to replicas, writes to primaries', 'query');
    arm();
  },
};
