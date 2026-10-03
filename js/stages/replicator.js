// Stage 6 · Replicator. A guided Reshard of public.events from one source shard onto two
// new shards while the app keeps reading and writing through the router.
import {
  h, s, scene, node, edge, packet, text, button, toggle, slider, group, metric, iconSvg, rng,
} from '../core.js';

const ROWS0 = 60000;      // illustrative table size
const SHARE_B = 0.48;     // illustrative share of rows whose routing value is in 00–7f
const STREAM_RATE = 12;   // illustrative changes applied per stream tick
const MAX_LIVE = 60;
const STEPS = ['Add shards', 'Declare', 'Create', 'Copy', 'Stream', 'Differ', 'Reads', 'Writes', 'Complete'];
const STEP_OF = { idle: 0, adding: 0, added: 1, declared: 2, stopped: 2, copying: 3, streaming: 4, differ: 5,
  differDone: 6, reads: 7, switching: 7, writes: 8, complete: 9 };
const PHASE_LABEL = { idle: 'not started', adding: 'adding shards', added: 'shards ready', declared: 'source declared',
  stopped: 'created, stopped', copying: 'copying', streaming: 'streaming', differ: 'differ running',
  differDone: 'differ done', reads: 'reads switched', switching: 'switching writes', writes: 'writes switched',
  complete: 'complete' };
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const rowsOf = (n) => `${fmt(n)} ${n === 1 ? 'row' : 'rows'}`;

const SQL = {
  addShards: 'pscale branch shard create <DATABASE_NAME> main \\\n  --config-profile default --count 2',
  declare: 'SELECT * FROM __neki.set_data_topology($${\n  "shard_indexes": {...}, "shard_groups": [...],\n'
    + '  "databases": {...}, "default_shard_group": "...",\n  "authoritative_shard_group": "..."\n}$$::text, true);\n'
    + '-- a full replacement: send the whole topology, not a diff\nSELECT __neki.wait_for_data_topology(<REVISION>);',
  create: (stopped) => "SELECT __neki.reshard_create(\n  'reshard_events', 'postgres', 'imported',\n"
    + '  \'{"default_shard_index": "xxhash_tenant_id",\n    "key_ranges": [\n'
    + '      {"shard_uid": "<SHARD_2>", "end": "80"},\n      {"shard_uid": "<SHARD_3>", "start": "80"}]}\',\n'
    + `  'events_by_tenant', '${stopped ? '{"create_stopped": true}' : '{}'}');`,
  start: "SELECT __neki.workflow_start('reshard_events');",
  status: "SELECT * FROM __neki.workflow_status('reshard_events');",
  differ: "SELECT __neki.differ_create('reshard_events', 'pre_cutover');",
  report: "SELECT * FROM __neki.differ_report('reshard_events', 'pre_cutover');",
  reads: "SELECT * FROM __neki.workflow_switch_reads('reshard_events');",
  writes: "SELECT * FROM __neki.workflow_switch_writes('reshard_events');",
  complete: (drop) => (drop
    ? 'SELECT __neki.workflow_complete(\'reshard_events\', \'{"drop_source_data": true}\');'
    : "SELECT __neki.workflow_complete('reshard_events');"),
  cancel: "SELECT __neki.workflow_cancel('reshard_events');",
};

export default {
  id: 'replicator',
  nav: 'Replicator',
  kicker: 'Data movement · Online',
  title: 'Reshard without downtime',
  lede: 'Split one table across two new shards while the app keeps reading and writing. The Replicator copies rows, '
    + 'streams new changes, and the routers switch traffic only when the target has caught up.',
  facts: [
    { text: 'Data migrations move tables or reshard without taking the app offline: Neki copies existing rows, keeps the target current with new writes, and the source serves traffic until the switch.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'Reshard spreads declared tables of one source shard group over a new shard group in the same database. MoveTables copies chosen tables to another database or shard group.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'During Platform Preview you run workflows with __neki.* functions on a SQL connection to a router; changes need the neki_operator role. A workflow keeps running after that session disconnects.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'Each table needs an iteration key, preferably the primary key, which sets copy order. The shard key decides where each row lands.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'Before cutover the differ report should be complete with no mismatches, backed by your own app-level check. Cutover refuses streams that are not streaming.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'Splitting the initial authoritative group leaves cluster authority on the original shard, so a two-way split uses three shards.', href: 'https://planetscale.com/docs/neki/data-migration' },
    { text: 'The Replicator connects to Postgres directly, not through routers. Online schema changes use the same copy-and-stream process.', href: 'https://planetscale.com/docs/neki/replication' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(11);

    // ---------- scene ----------
    const sc = scene(ctx.viz, 960, 550, 'Reshard of public.events from shard A onto new shards B and C while the app keeps running');
    const explain = (html) => () => ctx.narrate(html);
    const app = node(sc, { x: 24, y: 24, w: 150, h: 56, title: 'App', sub: 'reads + writes', kind: 'client' });
    const session = node(sc, { x: 24, y: 92, w: 150, h: 48, title: 'Operator', sub: 'psql · neki_operator', kind: 'mgmt',
      onClick: explain('<p>Workflows are plain SQL during Platform Preview: you call <code>__neki.*</code> functions on a connection to a router. Functions that change things need the <code>neki_operator</code> role. The workflow keeps running if this session disconnects.</p>'),
      label: 'Operator session: explain' });
    const router = node(sc, { x: 260, y: 24, w: 180, h: 56, title: 'Router', sub: 'queries + __neki.* calls', kind: 'router',
      onClick: explain('<p>The <b>router</b> carries app queries and is where workflow functions are called. Copy and stream traffic never passes through it. During the write switch it holds queries to the moved table for a moment instead of failing them.</p>'),
      label: 'Router: explain' });
    const topo = node(sc, { x: 690, y: 24, w: 246, h: 56, title: 'Topology service', sub: 'events → shard A', kind: 'mgmt',
      onClick: explain('<p>The <b>topology service</b> holds the data topology: which shard group owns which tables and key ranges. A topology update replaces the whole document. The last step of a write switch updates routing here, and routers pick it up.</p>'),
      label: 'Topology service: explain' });
    const shardA = node(sc, { x: 24, y: 176, w: 250, h: 72, title: 'Shard A', sub: 'group imported · authoritative', kind: 'shard',
      onClick: explain('<p><b>Shard A</b> is the original single-shard group. It keeps cluster authority (catalog, system tables, sequences) and does not become one of the data shards in the split. That is why splitting <code>events</code> two ways uses three shards.</p>'),
      label: 'Shard A: explain' });
    const replicator = node(sc, { x: 330, y: 182, w: 210, h: 60, title: 'Replicator', sub: 'idle', kind: 'control',
      onClick: explain('<p>The <b>Replicator</b> copies existing rows in batches, then streams new changes until the target catches up. It connects to Postgres on the source and target shards directly, not through routers. Online schema changes reuse the same copy-and-stream process.</p>'),
      label: 'Replicator: explain' });
    const differN = node(sc, { x: 330, y: 270, w: 210, h: 44, title: 'Differ', sub: 'not running', kind: 'ghost',
      onClick: explain('<p>The <b>differ</b> compares source and target rows for a workflow. Before cutover its report should be complete, with no missing, extra or mismatched rows, and you should still run your own app-level check.</p>'),
      label: 'Differ: explain' });
    const shardB = node(sc, { x: 620, y: 160, w: 220, h: 64, title: 'Shard B · 00–7f', sub: 'not created', kind: 'ghost' });
    const shardC = node(sc, { x: 620, y: 272, w: 220, h: 64, title: 'Shard C · 80–ff', sub: 'not created', kind: 'ghost' });
    const T = { B: shardB, C: shardC };

    edge(sc, [app.right, [256, 52]], { kind: 'query' });
    edge(sc, [session.right, [214, 116], [214, 70], [256, 70]], { kind: 'mgmt', dashed: true });
    edge(sc, [router.right, [686, 52]], { kind: 'mgmt', dashed: true });
    const P = {
      A: [[350, 80], [350, 130], [240, 130], [240, 172]],
      B: [[350, 80], [350, 130], [900, 130], [900, 192], [844, 192]],
      C: [[350, 80], [350, 130], [900, 130], [900, 304], [844, 304]],
    };
    edge(sc, P.A, { kind: 'query' });
    const eB = edge(sc, P.B, { kind: 'query' });
    const eC = edge(sc, P.C, { kind: 'query' });
    const R2B = [[540, 212], [580, 212], [580, 192], [616, 192]];
    const R2C = [[540, 212], [580, 212], [580, 304], [616, 304]];
    const A2R = [[274, 212], [326, 212]];
    const eAR = edge(sc, A2R, { kind: 'control' });
    const eRB = edge(sc, R2B, { kind: 'control' });
    const eRC = edge(sc, R2C, { kind: 'control' });

    text(sc, 565, 44, 'topology updates', { cls: 'text', anchor: 'middle' });
    text(sc, 435, 174, 'direct Postgres connections', { cls: 'text', anchor: 'middle' });
    text(sc, 620, 152, 'Target group events_by_tenant', { cls: 'label' });
    const aRows = text(sc, 24, 270, '', { cls: 'text text--ink mono' });
    const aNote = text(sc, 24, 288, 'other tables, catalog, sequences stay', { cls: 'text' });
    const bars = {};
    for (const [k, y] of [['B', 232], ['C', 344]]) {
      s('rect', { x: 620, y, width: 150, height: 8, rx: 4, class: 'bar-bg' }, sc.labels);
      bars[k] = { fill: s('rect', { x: 620, y, width: 0, height: 8, rx: 4, class: 'bar--control' }, sc.labels),
        pct: text(sc, 840, y + 8, '', { cls: 'text mono', anchor: 'end' }) };
    }
    text(sc, 330, 346, 'target lag', { cls: 'text' });
    s('rect', { x: 330, y: 354, width: 210, height: 8, rx: 4, class: 'bar-bg' }, sc.labels);
    const lagBar = s('rect', { x: 330, y: 354, width: 0, height: 8, rx: 4, class: 'bar--control' }, sc.labels);
    const lagText = text(sc, 540, 346, '', { cls: 'text mono', anchor: 'end' });

    text(sc, 16, 396, 'Reshard public.events by tenant_id', { cls: 'label' });
    const steps = STEPS.map((title, i) => node(sc, { x: 16 + i * 104, y: 406, w: 96, h: 48, title, sub: `step ${i + 1}`, kind: 'band' }));
    const wfLine = text(sc, 16, 486, '', { cls: 'text mono' });

    const legend = [['query', 6, 'app write'], ['query', 4, 'app read'], ['control', 6, 'copy / stream'], ['mgmt', 5, 'workflow call']];
    let lx = 16;
    for (const [kind, r, label] of legend) {
      s('circle', { cx: lx + 6, cy: 526, r, class: `packet packet--${kind}` }, sc.labels);
      text(sc, lx + 18, 530, label, { cls: 'text' });
      lx += 30 + label.length * 7.4;
    }

    // ---------- state ----------
    let phase, rowsA, rowsB, rowsC, snapshot, expB, expC, issuedB, issuedC, copiedB, copiedC;
    let wf, lag, inflight, buffering, blocked, bufQ, bufRows, readsMoved, writesMoved, dropped;
    let differ, stopDiffer, busy, addStage, switchStep, refusal, endNote;
    let epoch = 0, live = 0, createStopped = true, batchSize = 4000, shownTag = -1;

    function init() {
      phase = 'idle'; rowsA = ROWS0; rowsB = 0; rowsC = 0;
      snapshot = expB = expC = issuedB = issuedC = copiedB = copiedC = 0;
      wf = null; lag = 0; inflight = 0; buffering = false; blocked = false; bufQ = 0; bufRows = 0;
      readsMoved = false; writesMoved = false; dropped = false;
      differ = null; stopDiffer = null; busy = false; addStage = null; switchStep = null; refusal = null; endNote = null;
    }

    const guard = () => { const e = epoch; return (fn) => (...a) => { if (e === epoch) fn(...a); }; };
    const setKind = (n, kind) => n.g.setAttribute('class', `node node--${kind}`);
    const capturing = () => !!(wf && wf.started && !wf.retired && !writesMoved);
    const allRunning = () => !!(wf && wf.streams.B === 'running' && wf.streams.C === 'running');
    const notStreaming = () => ['B', 'C'].filter((t) => wf.streams[t] !== 'running' || wf.phase !== 'streaming');
    const pickTarget = () => (rand() < SHARE_B ? 'B' : 'C');

    function pkt(points, { kind = 'query', duration = 600, r = 5, onDone } = {}, essential = false) {
      if (live >= MAX_LIVE) { if (essential && onDone) onDone(); return; }
      live++;
      packet(sc, clock, points, { kind, duration, r, onDone: () => { live--; if (onDone) onDone(); } });
    }

    // ---------- app traffic ----------
    function sendApp(q, essential = false) {
      if (live >= MAX_LIVE) { if (essential) atRouter(q, false); return; }
      pkt([app.right, [256, 52]], { duration: 380, r: q.write ? 6 : 4, onDone: () => atRouter(q, true) });
    }
    function atRouter(q, animate) {
      let dest = 'A';
      if (!q.other) {
        if (!q.write) dest = readsMoved ? pickTarget() : 'A';
        else if (writesMoved) dest = pickTarget();
        else if (buffering) { bufQ++; bufRows += q.n; return; }
      }
      if (!animate) { land(dest, q); return; }
      pkt(P[dest], { duration: 520, r: q.write ? 6 : 4, onDone: () => land(dest, q) }, q.write);
    }
    function land(dest, q) {
      if (!q.write || q.other) return;
      if (dest === 'A') { rowsA += q.n; if (capturing()) lag += q.n; }
      else if (dest === 'B') rowsB += q.n;
      else rowsC += q.n;
    }
    const appTick = () => sendApp({ write: rand() < 0.4, other: rand() < 0.15, n: 1 });

    // ---------- Replicator loops ----------
    function streamTick() {
      if (!capturing() || !allRunning() || lag <= 0) return;
      const n = Math.min(lag, STREAM_RATE);
      let b = 0;
      for (let i = 0; i < n; i++) if (rand() < SHARE_B) b++;
      const c = n - b;
      lag -= n; inflight += n;
      const g = guard();
      pkt(A2R, { kind: 'control', duration: 300, r: 4, onDone: g(() => {
        pkt(R2B, { kind: 'control', duration: 360, r: 4, onDone: g(() => { rowsB += b; inflight -= b; }) }, true);
        pkt(R2C, { kind: 'control', duration: 360, r: 4, onDone: g(() => { rowsC += c; inflight -= c; }) }, true);
      }) }, true);
    }

    function copyTick() {
      if (!wf || wf.retired || wf.phase !== 'copying' || !allRunning()) return;
      const left = snapshot - issuedB - issuedC;
      if (left <= 0) return;
      const batch = Math.min(batchSize, left);
      let b = Math.min(expB - issuedB, Math.round(batch * SHARE_B));
      let c = batch - b;
      if (c > expC - issuedC) { c = expC - issuedC; b = batch - c; }
      issuedB += b; issuedC += c;
      const g = guard();
      pkt(A2R, { kind: 'control', duration: 320, r: 7, onDone: g(() => {
        pkt(R2B, { kind: 'control', duration: 400, r: 6, onDone: g(() => { copiedB += b; rowsB += b; copyDone(); }) }, true);
        pkt(R2C, { kind: 'control', duration: 400, r: 6, onDone: g(() => { copiedC += c; rowsC += c; copyDone(); }) }, true);
      }) }, true);
    }
    function copyDone() {
      if (copiedB !== expB || copiedC !== expC || wf.phase !== 'copying') return;
      wf.phase = 'streaming';
      log.add(`Copy finished: ${fmt(snapshot)} rows in iteration-key order; streams now in the streaming phase`, 'control');
      setPhase('streaming');
    }

    // ---------- workflow calls ----------
    function call(logText, fn) {
      busy = true;
      refusal = null;
      updateControls();
      log.add(logText, 'mgmt');
      const g = guard();
      pkt([session.right, [214, 116], [214, 70], [256, 70]], { kind: 'mgmt', duration: 650, r: 5,
        onDone: g(() => { busy = false; fn(); updateControls(); }) }, true);
    }
    function viaTopology(fn, flip) {
      busy = true;
      updateControls();
      const g = guard();
      pkt([router.right, [686, 52]], { kind: 'mgmt', duration: 650, r: 5, onDone: g(() => {
        if (flip) flip();
        pkt([[686, 52], router.right], { kind: 'control', duration: 650, r: 5, onDone: g(() => { busy = false; fn(); updateControls(); }) }, true);
      }) }, true);
    }

    function addShards() {
      setPhase('adding');
      addStage = 'creating…';
      log.add('pscale branch shard create … --count 2: shards B and C requested; no rows move', 'mgmt');
      const g = guard();
      clock.after(1400, g(() => { addStage = 'starting primary…'; }));
      clock.after(2800, g(() => {
        addStage = null;
        setPhase('added');
        shardB.setState('ok'); shardC.setState('ok');
        clock.after(900, g(() => { shardB.setState(null); shardC.setState(null); }));
        log.add('Shards B and C have ready primaries and no rows', 'mgmt');
      }));
    }

    function declare() {
      call('set_data_topology: declare source group imported (full replacement)', () => {
        viaTopology(() => {
          setPhase('declared');
          log.add('Data topology revision applied; routers serve events from A as before', 'mgmt');
        }, () => topo.setSub('rev 2 · source group declared'));
      });
    }

    function create() {
      const stopped = createStopped;
      call(`reshard_create('reshard_events', …)${stopped ? ' with create_stopped' : ''}`, () => {
        wf = { started: false, retired: false, phase: 'initializing', streams: { B: 'stopped', C: 'stopped' } };
        topo.setSub('workflow reshard_events');
        if (stopped) { setPhase('stopped'); log.add('Workflow created, stopped: nothing is copied yet', 'mgmt'); } else startWorkflow();
      });
    }
    function start() { call("workflow_start('reshard_events')", startWorkflow); }
    function startWorkflow() {
      wf.started = true;
      wf.phase = 'initializing';
      wf.streams = { B: 'running', C: 'running' };
      snapshot = rowsA;
      expB = Math.round(snapshot * SHARE_B); expC = snapshot - expB;
      issuedB = issuedC = copiedB = copiedC = 0;
      lag = 0;
      setPhase('copying');
      log.add(`Workflow started: copying ${fmt(snapshot)} rows to B and C`, 'control');
      const g = guard();
      clock.after(900, g(() => { if (wf && wf.phase === 'initializing') wf.phase = 'copying'; }));
    }

    function runDiffer() {
      call("differ_create('reshard_events', 'pre_cutover')", () => {
        setPhase('differ');
        wf.streams.B = 'stopped'; wf.streams.C = 'stopped';
        differ = { compared: 0, total: rowsA, done: false };
        log.add('Differ running; it stopped the streams while it compares', 'control');
        const g = guard();
        let ticks = 0;
        stopDiffer = clock.every(320, g(() => {
          ticks++;
          differ.compared = Math.min(differ.total, Math.round((differ.total * ticks) / 12));
          const t = ticks % 2 ? 'B' : 'C';
          pkt([[274, 236], [300, 236], [300, 292], [326, 292]], { kind: 'mgmt', duration: 300, r: 4 });
          pkt([T[t].left, [600, T[t].cy], [600, 292], [544, 292]], { kind: 'mgmt', duration: 300, r: 4 });
          if (ticks >= 12) { stopDiffer(); stopDiffer = null; differFinished(); }
        }));
      });
    }
    function differFinished() {
      differ.done = true;
      setPhase('differDone');
      log.add(`Differ report: complete, no mismatches, ${fmt(differ.total)} rows compared`, 'control');
      const g = guard();
      clock.after(1600, g(() => { wf.streams.B = 'running'; log.add('Stream to B running in the streaming phase again', 'control'); narrate(); }));
      clock.after(3400, g(() => { wf.streams.C = 'running'; log.add('Stream to C running in the streaming phase again', 'control'); narrate(); }));
    }

    function refuse(fnName) {
      const bad = notStreaming();
      const what = bad.map((t) => `stream to ${t} is ${wf.streams[t]}`).join(', ');
      refusal = `-- refused by the cutover readiness check:\n-- ${what}; every stream must be running and streaming`;
      log.add(`${fnName} refused: ${what}`, 'error');
      replicator.setState('warn');
      clock.after(1200, guard()(() => replicator.setState(null)));
      ctx.narrate(`<p><b>Refused.</b> The readiness check found that the ${what}. Cutover only proceeds when every stream is running in the streaming phase.</p><p>Nothing moved and the app saw nothing. Wait for the streams to come back, then try again.</p>`);
      updateCode();
    }

    function switchReads() {
      if (notStreaming().length) { refuse('workflow_switch_reads'); return; }
      call("workflow_switch_reads('reshard_events')", () => {
        viaTopology(() => {
          readsMoved = true;
          setPhase('reads');
          log.add('Replica and read-only reads of events now go to B and C; writes stay on A', 'query');
        }, () => topo.setSub('reads → B, C · writes → A'));
      });
    }

    function switchWrites() {
      if (notStreaming().length) { refuse('workflow_switch_writes'); return; }
      call("workflow_switch_writes('reshard_events')", () => {
        setPhase('switching');
        const g = guard();
        buffering = true;
        switchStep = 0;
        router.setState('warn');
        status.set('slower', 'Slower: writes to events are held for a moment, not failed');
        log.add('Routers buffer queries to events', 'control');
        narrate();
        clock.after(900, g(() => {
          blocked = true;
          switchStep = 1;
          shardA.tag('events writes blocked', 'control');
          log.add('New source writes to events blocked on A', 'control');
          narrate();
          const stopWait = clock.every(200, g(() => {
            if (lag + inflight > 0) return;
            stopWait();
            switchStep = 2;
            log.add('Every change A accepted has reached B or C', 'control');
            narrate();
            for (const t of ['B', 'C']) {
              pkt([T[t].left, [580, T[t].cy], [580, 212], [544, 212]], { kind: 'mgmt', duration: 500, r: 4, onDone: g(() => {
                if (t === 'B') pkt([[330, 212], [278, 212]], { kind: 'mgmt', duration: 300, r: 4 });
              }) });
            }
            clock.after(1100, g(() => {
              log.add('Owned sequence on A set from the highest value found across B and C', 'control');
              switchStep = 3;
              narrate();
              viaTopology(finishWrites, () => topo.setSub('events → B, C'));
            }));
          }));
        }));
      });
    }
    function finishWrites() {
      writesMoved = true; buffering = false; blocked = false;
      router.setState(null); router.tag(null); shardA.tag(null);
      const held = bufQ, rows = bufRows;
      bufQ = 0; bufRows = 0;
      const packets = Math.min(8, held);
      let left = rows;
      for (let i = 0; i < packets; i++) {
        const n = i === packets - 1 ? left : Math.floor(rows / packets);
        left -= n;
        const dest = pickTarget();
        pkt(P[dest], { duration: 520, r: 6, onDone: () => land(dest, { write: true, n }) }, true);
      }
      endNote = held;
      status.set('normal', 'Normal: events is served by shards B and C');
      log.add(`Routing updated: events reads and writes go to B and C; ${held} held ${held === 1 ? 'query' : 'queries'} released`, 'query');
      setPhase('writes');
    }

    function complete() {
      const drop = dropTg.value;
      call(`workflow_complete('reshard_events')${drop ? ' with drop_source_data' : ''}`, () => {
        wf.retired = true;
        if (drop) { dropped = true; rowsA = 0; }
        setPhase('complete');
        log.add(drop ? 'Workflow complete; old events rows on A truncated' : 'Workflow complete; old events rows on A kept (default)', 'mgmt');
      });
    }

    function cancel() {
      if (!wf || busy) return;
      if (readsMoved) {
        const after = writesMoved
          ? 'Writes have switched too, and reversing a write switch is not a documented rollback path.'
          : 'Reads already moved to B and C.';
        log.add('Cancel is only for workflows that have not moved traffic', 'info');
        ctx.narrate(`<p><b>Cancel is not offered here.</b> Cancel is for workflows that have not moved any traffic yet. ${after}</p>`);
        return;
      }
      call("workflow_cancel('reshard_events')", () => {
        epoch++;
        if (stopDiffer) { stopDiffer(); stopDiffer = null; }
        wf = null; differ = null; lag = 0; inflight = 0;
        rowsB = 0; rowsC = 0; snapshot = expB = expC = issuedB = issuedC = copiedB = copiedC = 0;
        topo.setSub('rev 2 · source group declared');
        setPhase('declared');
        log.add('Workflow cancelled; target rows on B and C removed (default); the app never left A', 'mgmt');
        ctx.narrate('<p><b>Cancelled.</b> The workflow stopped before any traffic moved. Its resources are removed and, unless you ask to keep it, so is the disposable target data on B and C. The app kept using A the whole time.</p><p>You can create the workflow again.</p>');
      });
    }

    function burst() {
      log.add('Write burst: 300 extra inserts into events over 2 s (illustrative)', 'query');
      for (let i = 0; i < 20; i++) clock.after(i * 100, () => sendApp({ write: true, other: false, n: 15 }, true));
      if (capturing()) ctx.narrate('<p><b>Write burst.</b> 300 inserts hit shard A at once. The Replicator captures them and applies them to B and C at its own pace, so target lag climbs and then drains. The app is not slowed: it still writes to A.</p>');
      else if (writesMoved) ctx.narrate('<p><b>Write burst.</b> Writes now go straight to B and C, so there is nothing to catch up.</p>');
      else ctx.narrate('<p><b>Write burst.</b> No workflow is streaming yet, so A simply absorbs the writes. Start a workflow to see lag build and drain.</p>');
    }

    function restart() {
      clock.reset();
      sc.packets.textContent = '';
      live = 0;
      epoch++;
      init();
      router.setState(null); router.tag(null); shardA.tag(null); replicator.setState(null);
      topo.setSub('events → shard A');
      status.set('normal', 'Normal: events is served by shard A');
      setPhase('idle');
      arm();
    }

    // ---------- view ----------
    const NEXT = {
      idle: ['Add shards B and C', addShards], adding: ['Waiting for primaries…', null],
      added: ['Declare source group', declare],
      declared: [() => (createStopped ? 'Create workflow (stopped)' : 'Create and start workflow'), create],
      stopped: ['Start workflow', start], copying: ['Copying rows…', null], streaming: ['Run differ', runDiffer],
      differ: ['Differ running…', null], differDone: ['Switch reads', switchReads], reads: ['Switch writes', switchWrites],
      switching: ['Switching writes…', null], writes: ['Complete workflow', complete], complete: ['Start over', restart],
    };
    const NEXT_SQL = {
      idle: SQL.addShards, adding: SQL.addShards, added: SQL.declare, declared: () => SQL.create(createStopped),
      stopped: SQL.start, copying: SQL.status, streaming: SQL.differ, differ: SQL.report, differDone: SQL.reads,
      reads: SQL.writes, switching: SQL.writes, writes: () => SQL.complete(dropTg.value), complete: '-- nothing left to run',
    };

    function setPhase(p) {
      phase = p;
      const step = STEP_OF[p];
      steps.forEach((n, i) => n.setState(i < step ? 'ok' : i === step ? 'warn' : null));
      const created = p !== 'idle' && p !== 'adding';
      for (const n of [shardB, shardC]) {
        setKind(n, p === 'idle' ? 'ghost' : 'shard');
        n.setState(p === 'adding' ? 'warn' : null);
      }
      if (!created) topo.setSub('events → shard A');
      replicator.setState(!wf || wf.retired ? 'dim' : null);
      const differOn = p === 'differ' || p === 'differDone';
      setKind(differN, differOn ? 'control' : 'ghost');
      differN.setState(p === 'differ' ? 'active' : (p === 'complete' ? 'dim' : null));
      mPhase.set(PHASE_LABEL[p], p === 'switching' ? 'warn' : (p === 'complete' ? 'good' : null));
      if (p !== 'switching' && status.state !== 'normal') status.set('normal');
      if (p === 'idle' || p === 'added' || p === 'declared') status.set('normal', 'Normal: events is served by shard A');
      if (p === 'reads') status.set('normal', 'Normal: replica reads from B and C, writes on A');
      updateControls();
      updateCode();
      narrate();
      refresh();
    }

    function updateControls() {
      const [label, fn] = NEXT[phase];
      const text2 = typeof label === 'function' ? label() : label;
      nextBtn.replaceChildren(iconSvg(phase === 'complete' ? 'restart' : 'next'), text2);
      nextBtn.disabled = busy || !fn;
      cancelBtn.disabled = busy || !wf || wf.retired || phase === 'switching';
    }

    function updateCode() {
      const sql = NEXT_SQL[phase];
      codeCap.textContent = phase === 'idle' || phase === 'adding'
        ? 'Next step · PlanetScale CLI'
        : 'Next step · SQL on a router connection (neki_operator)';
      nextCode.replaceChildren(typeof sql === 'function' ? sql() : sql);
      if (refusal) nextCode.append('\n', h('span', { class: 'err', text: refusal }));
    }

    function narrate() {
      const N = {
        idle: '<p>The app reads and writes <code>public.events</code> on <b>shard A</b>, the only shard. A also holds cluster authority and every other table.</p><p>Goal: split <code>events</code> by <code>tenant_id</code> across two new shards without taking the app offline. Start with <b>Add shards B and C</b>.</p>',
        adding: '<p>Shards B and C are being created. Adding shards adds capacity; it does not move a single row. The workflow needs ready primaries on both.</p>',
        added: '<p>B and C are ready and empty. Next, declare the source shard group in the data topology. A topology update replaces the whole document, so it must restate everything you want to keep.</p>',
        declared: '<p>The source group is declared. Now create the Reshard workflow on a SQL connection to a router. Its definition maps <code>xxhash_tenant_id</code> routing values <code>00–7f</code> to B and <code>80–ff</code> to C.</p><p>With <b>create_stopped</b> on, the workflow exists but copies nothing until you start it.</p>',
        stopped: '<p>The workflow exists and is stopped. Nothing is copied yet and the app is untouched. Press <b>Start workflow</b>.</p>',
        copying: `<p>The Replicator copies existing rows in batches, in iteration-key order (the primary key here). The shard key decides whether each row lands on B or C, so every batch feeds both.</p><p>The app keeps writing to A, and those new changes are applied to the targets as well. Drag <b>copy_batch_size</b> to change the pace.</p>`,
        streaming: '<p>Copy finished. Both streams are in the <b>streaming</b> phase: new writes on A reach B or C shortly after. Reaching streaming does not move any traffic; reads and writes still go to A.</p><p>Try <b>Write burst</b> to watch lag grow and drain, then run the differ.</p>',
        differ: '<p>The differ compares rows on A with rows on B and C. It can stop and restart streams while it works, so changes queue up on A meanwhile. App traffic is unaffected.</p>',
        reads: '<p>Replica and read-only reads of <code>events</code> now go to B and C. Primary reads and all writes stay on A.</p><p>Traffic has moved, so Cancel is no longer offered. Next: switch writes.</p>',
        writes: `<p>Writes switched. Routers held ${endNote || 0} ${endNote === 1 ? 'query' : 'queries'} for a moment, so the app saw a short slowdown and no errors. B and C now serve <code>events</code>; A keeps cluster authority and the other tables.</p><p>Reversing a write switch is not a documented rollback path. <b>Complete</b> retires the workflow's resources.</p>`,
        complete: dropped
          ? '<p>Done. The migration resources are retired and, because you set <code>drop_source_data</code>, the old <code>events</code> rows on A were truncated.</p><p>See <a href="#/platform">Stage 7</a> for how the shards themselves are run.</p>'
          : '<p>Done. The migration resources are retired. By default the old <code>events</code> rows stay on A, no longer served; set <code>drop_source_data</code> to truncate them.</p><p>See <a href="#/platform">Stage 7</a> for how the shards themselves are run.</p>',
      };
      if (phase === 'differDone') {
        const waiting = notStreaming();
        ctx.narrate(waiting.length
          ? `<p>Differ report: <b>complete</b>, no mismatches, every table compared. Pair it with your own app-level check.</p><p>The streams are restarting (${waiting.map((t) => `${t}: ${wf.streams[t]}`).join(', ')}). Cutover refuses streams that are not streaming. Press <b>Switch reads</b> now to see the check refuse, or wait a moment.</p>`
          : '<p>Differ report: <b>complete</b>, no mismatches. Every stream is running in the streaming phase again, so cutover can proceed. Press <b>Switch reads</b>.</p>');
        return;
      }
      if (phase === 'switching') {
        const items = ['Routers buffer queries to <code>events</code>. The app waits; nothing fails.',
          'New writes to <code>events</code> on A are blocked. Neki waits for changes A already accepted to reach B and C.',
          'Owned sequences sync: each is set from the highest value found across the target shards.',
          'Routing topology updates. Once this decision is durable, retries finish the switch instead of handing traffic back to A.'];
        ctx.narrate(`<ol style="margin:0;padding-left:20px">${items.map((t, i) => `<li style="margin-bottom:6px;${i > switchStep ? 'opacity:0.45' : ''}">${i === switchStep ? `<b>${t}</b>` : t}</li>`).join('')}</ol>`);
        return;
      }
      ctx.narrate(N[phase]);
    }

    function refresh() {
      aRows.textContent = dropped ? 'events: truncated'
        : `events: ${rowsOf(rowsA)}${writesMoved ? ' (old copy, not served)' : ''}`;
      aNote.textContent = writesMoved ? 'serves other tables, catalog, sequences' : 'other tables, catalog, sequences stay';
      for (const t of ['B', 'C']) {
        const n = T[t];
        n.setSub(phase === 'idle' ? 'not created' : addStage || `events: ${rowsOf(t === 'B' ? rowsB : rowsC)}`);
        const exp = t === 'B' ? expB : expC, got = t === 'B' ? copiedB : copiedC;
        const frac = exp ? got / exp : 0;
        bars[t].fill.setAttribute('width', 150 * frac);
        bars[t].pct.textContent = wf && wf.started ? `${Math.floor(frac * 100)}%` : '';
      }
      const totalLag = lag + inflight;
      lagBar.setAttribute('width', capturing() ? Math.min(210, (210 * totalLag) / 300) : 0);
      lagText.textContent = capturing() ? `${fmt(totalLag)} ${totalLag === 1 ? 'change' : 'changes'}` : '—';
      let sub = `idle · batch ${fmt(batchSize)} rows`;
      if (wf && wf.retired) sub = 'retired';
      else if (wf && !wf.started) sub = 'workflow stopped';
      else if (wf && writesMoved) sub = 'cutover done';
      else if (wf && !allRunning()) sub = 'streams stopped';
      else if (wf && wf.phase === 'initializing') sub = 'initializing';
      else if (wf && wf.phase === 'copying') sub = `copying · batch ${fmt(batchSize)}`;
      else if (wf) sub = totalLag ? `streaming · ${fmt(totalLag)} behind` : 'streaming · caught up';
      replicator.setSub(sub);
      differN.setSub(differ ? `${differ.done ? 'report: no mismatches' : `compared ${fmt(differ.compared)}`}` : 'not running');
      const flowing = capturing() && allRunning();
      for (const e of [eAR, eRB, eRC]) e.setState(!wf || wf.retired || writesMoved ? 'dim' : (flowing ? 'flow' : null));
      for (const e of [eB, eC]) e.setState(readsMoved ? null : 'dim');
      if (buffering && shownTag !== bufQ) { shownTag = bufQ; router.tag(`holding ${bufQ}`, 'control'); }
      if (!buffering) shownTag = -1;
      wfLine.textContent = !wf ? 'workflow: none'
        : wf.retired ? 'reshard_events · completed · events served by B and C'
        : `reshard_events · phase ${wf.started ? wf.phase : '—'} · stream B ${wf.streams.B} · stream C ${wf.streams.C}`
          + ` · reads → ${readsMoved ? 'target' : 'source'} · writes → ${writesMoved ? 'target' : 'source'}`;
      const statusText = !wf ? '-- no workflow yet'
        : wf.retired ? '-- workflow completed; migration resources retired'
          : [SQL.status,
            `phase          ${wf.started ? wf.phase : '(not started)'}`,
            `stream → B     ${wf.streams.B}`,
            `stream → C     ${wf.streams.C}`,
            `traffic_state  reads: ${readsMoved ? 'target' : 'source'} · writes: ${writesMoved ? 'target' : 'source'}`].join('\n');
      if (statusCode.textContent !== statusText) statusCode.textContent = statusText;
      mCopied.set(snapshot ? `${fmt(copiedB + copiedC)} / ${fmt(snapshot)}` : '—');
      mLag.set(capturing() ? fmt(totalLag) : '—', totalLag > 100 && capturing() ? 'warn' : null);
      mBuf.set(String(bufQ), bufQ ? 'warn' : null);
    }

    // ---------- controls ----------
    const nextBtn = button('', () => { const fn = NEXT[phase][1]; if (fn && !busy) fn(); }, { variant: 'primary' });
    const cancelBtn = button('Cancel workflow', cancel, { variant: 'danger', icon: 'x' });
    const stoppedTg = toggle({ label: 'create_stopped', checked: true, onChange: (v) => {
      createStopped = v;
      updateControls(); updateCode();
      log.add(`create_stopped ${v ? 'on: create, then start separately' : 'off: create starts copying at once'}`, 'info');
    } });
    const batchSl = slider({ label: 'copy_batch_size', min: 1000, max: 8000, step: 1000, value: batchSize,
      format: (v) => `${fmt(v)} rows`, onInput: (v) => { batchSize = v; refresh(); } });
    const dropTg = toggle({ label: 'drop_source_data on complete', onChange: (v) => {
      updateCode();
      log.add(`drop_source_data ${v ? 'on: Complete will truncate old rows on A' : 'off: Complete keeps old rows on A'}`, 'info');
    } });
    ctx.toolbar.append(
      group('Workflow', nextBtn, cancelBtn),
      group('Options', stoppedTg, batchSl, dropTg),
      group('App traffic', button('Write burst', burst, { variant: 'control', icon: 'zap' }),
        button('Reset', () => { restart(); log.add('Reset: one shard, no workflow', 'mgmt'); }, { icon: 'restart' })),
    );

    const mPhase = metric('Phase'), mCopied = metric('Rows copied'), mLag = metric('Target lag'),
      mErr = metric('App errors', '0', 'good'), mBuf = metric('Held queries', '0');
    ctx.readout.append(mPhase.el, mCopied.el, mLag.el, mErr.el, mBuf.el);

    const cap = (t) => h('div', { text: t, style: { font: '500 11px var(--mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--faint)', margin: '0 0 6px' } });
    const codeCap = cap('');
    const nextCode = h('pre', { class: 'codeblock' });
    const statusCode = h('pre', { class: 'codeblock' });
    ctx.extra.append(
      h('div', { style: { display: 'grid', gap: '16px' } },
        h('div', {}, codeCap, nextCode),
        h('div', {}, cap('Workflow status · simplified'), statusCode)),
      h('p', { style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--faint)' },
        text: 'Row counts, batch sizes, rates and timings are illustrative, and status output is simplified. Placeholders like <SHARD_2> stand for real shard ids.' }));

    function arm() {
      clock.every(260, appTick);
      clock.every(300, streamTick);
      clock.every(450, copyTick);
      clock.every(200, refresh, { immediate: true });
    }

    init();
    status.set('normal', 'Normal: events is served by shard A');
    setPhase('idle');
    arm();
    log.add('App traffic on: reads and writes to events on shard A', 'query');
  },
};
