// Stage 2 · Query path. Follow one statement through a router: parse, normalize,
// plan cache, plan, fan-out guard, execute on shards, and combine partial results.
import {
  h, scene, node, edge, packet, text, button, toggle, select, segmented, textInput, group, metric, fnv1a, rng,
} from '../core.js';

// tenant_data shards own thirds of the first hash byte (illustration only).
const SHARDS = [
  { name: 'B', lo: 0, hi: 86 },
  { name: 'C', lo: 86, hi: 171 },
  { name: 'D', lo: 171, hi: 256 },
];
const LEVEL = { single: 0, multi: 1, scatter: 2 };
const hex2 = (n) => n.toString(16).padStart(2, '0');
const byteOf = (v) => fnv1a(String(v)) >>> 24;
const shardOf = (v) => SHARDS.find((sh) => byteOf(v) >= sh.lo && byteOf(v) < sh.hi);
const rowsFor = (v) => 2 + (fnv1a(`rows:${v}`) % 14);
const POOL = [4821, 9374, 5590, 7310, 1207, 2044, 3388];

const PRESETS = {
  single: {
    label: 'One tenant', fanout: 'single', route: 'EqualUnique', defaults: '4821',
    sql: (v) => `SELECT event_id FROM events WHERE tenant_id = ${v[0]}`,
    norm: 'SELECT event_id FROM events WHERE tenant_id = $1',
    plan: 'Route [EqualUnique]',
    explain: ['Route [EqualUnique]', '  Query: SELECT event_id FROM public.events WHERE tenant_id = $1', '  ShardGroup: tenant_data', '  Values: $1'],
    targets: (v) => [shardOf(v[0])],
  },
  in: {
    label: 'Several tenants (IN)', fanout: 'multi', route: 'IN', defaults: '4821, 5590', combine: 'Collapse',
    sql: (v) => `SELECT event_id FROM events WHERE tenant_id IN (${v.join(', ')})`,
    norm: 'SELECT event_id FROM events WHERE tenant_id = ANY($1)',
    plan: 'Collapse → Route [IN]',
    explain: ['Collapse', '└── Route [IN]', '      Query: SELECT event_id FROM public.events WHERE tenant_id = ANY($1)', '      ShardGroup: tenant_data', '      Values: $1'],
    targets: (v) => SHARDS.filter((sh) => v.some((x) => shardOf(x) === sh)),
  },
  count: {
    label: 'Count every row', fanout: 'scatter', route: 'Scatter', defaults: '', combine: 'Aggregate [Ordered]',
    sql: () => 'SELECT count(*) FROM events',
    norm: 'SELECT count(*) FROM events',
    plan: 'Aggregate [Ordered] → Collapse → Route [Scatter]',
    explain: ['Aggregate [Ordered]', '└── Collapse', '    └── Route [Scatter]', '          Query: SELECT count(*) FROM public.events', '          ShardGroup: tenant_data'],
    targets: () => SHARDS,
  },
  update: {
    label: 'Update one tenant', fanout: 'single', route: 'EqualUnique', defaults: '4821', dml: true,
    sql: (v) => `UPDATE events SET seen_at = now() WHERE tenant_id = ${v[0]}`,
    norm: 'UPDATE events SET seen_at = now() WHERE tenant_id = $1',
    plan: 'Route [EqualUnique]',
    explain: ['Route [EqualUnique]', '  Query: UPDATE public.events SET seen_at = now() WHERE tenant_id = $1', '  ShardGroup: tenant_data', '  Values: $1'],
    targets: (v) => [shardOf(v[0])],
  },
};

const PIPE_Y = 56, PIPE_H = 60, ROW2_Y = 228, ROW2_H = 54;
const RET_LANE = 318, OUT_LANE = 332, SH_Y = 352, SH_H = 68, ERR_Y = 36;

export default {
  id: 'routing',
  nav: 'Routing',
  kicker: 'Layer 2 · Query path',
  title: 'Parse, plan, route, combine',
  lede: 'Every statement goes through the same steps inside a router. It is parsed, its literals become parameters, '
    + 'a plan is found or built, the fan-out guard checks it, and the shards’ answers are merged. Change the query, the fan-out limit, or the topology.',
  facts: [
    { text: 'The router parses each statement, then plans it against the current data topology.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: 'With the simple query protocol, eligible literals become parameters, so tenant_id = 12 and tenant_id = 13 share one plan.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: 'Preparing a statement does not pin its plan. The router can rebuild it after eviction or a schema or topology change.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: 'EXPLAIN (NEKI_PLAN) shows Neki’s plan: FORMAT TEXT prints a tree, COSTS OFF hides estimates. Plain EXPLAIN works only when the plan is a single route.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: '__neki.fanout (single, multi or scatter; default scatter) rejects SELECT and DML that would reach more shards than allowed. It does not apply to DDL.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: 'Route [Scatter] contacts every shard in the group and costs more as the group grows. For frequent queries, add a shard-key predicate or use a GSI.', href: 'https://planetscale.com/docs/neki/best-practices' },
    { text: 'Transactions that touch several shards do not commit atomically across them.', href: 'https://planetscale.com/docs/neki/best-practices' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(23);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const cache = new Map();      // normalized SQL → { plan, uses, firstVals }
    let fanout = 'scatter', autoOn = true, hits = 0, misses = 0;
    let runId = 0, timers = [], last = null, busy = false;
    const live = new Set();

    // ---------- scene ----------
    const sc = scene(ctx.viz, 960, 466, 'A statement passing through a Neki router: parse, normalize, plan cache, plan, fan-out guard, shards, combine');
    const appN = node(sc, { x: 24, y: PIPE_Y, w: 120, h: PIPE_H, title: 'App', sub: 'sends SQL', kind: 'client' });
    node(sc, { x: 166, y: 18, w: 774, h: 286, kind: 'band' });
    text(sc, 182, 296, 'one router · every router runs this pipeline', { cls: 'label' });
    const step = (x, w, title, sub) => node(sc, { x, y: PIPE_Y, w, h: PIPE_H, title, sub, kind: 'router' });
    const parseN = step(182, 128, 'Parse', 'syntax tree');
    const normN = step(328, 128, 'Normalize', 'literals → $n');
    const cacheN = step(474, 128, 'Plan cache', '0 cached');
    const planN = step(620, 128, 'Plan', 'route type');
    const guardN = step(766, 158, 'Fan-out guard', 'limit: scatter');
    const combN = node(sc, { x: 474, y: ROW2_Y, w: 274, h: ROW2_H, title: 'Combine', sub: '—', kind: 'router' });
    const execN = node(sc, { x: 766, y: ROW2_Y, w: 158, h: ROW2_H, title: 'Execute', sub: '—', kind: 'router' });
    const pipe = [appN, parseN, normN, cacheN, planN, guardN];
    for (let i = 0; i < pipe.length - 1; i++) edge(sc, [pipe[i].right, [pipe[i + 1].x - 3, PIPE_Y + PIPE_H / 2]], { kind: 'muted' });
    edge(sc, [guardN.bottom, [execN.cx, ROW2_Y - 3]], { kind: 'muted' });
    edge(sc, [combN.left, [appN.cx, combN.cy], [appN.cx, PIPE_Y + PIPE_H + 3]], { kind: 'muted' });

    const rowLabel = (y, str) => text(sc, 182, y, str, { cls: 'label' });
    const rowText = (y) => text(sc, 272, y, '', { cls: 'text mono text--ink' });
    rowLabel(146, 'statement'); rowLabel(168, 'normalized'); rowLabel(190, 'plan'); rowLabel(212, 'result');
    const sqlT = rowText(146), normT = rowText(168), planT = rowText(190), resT = rowText(212);

    text(sc, 24, SH_Y + 22, 'shard group', { cls: 'label' });
    text(sc, 24, SH_Y + 42, 'tenant_data', { cls: 'text mono' });
    const shardN = {};
    SHARDS.forEach((sh, i) => {
      const n = node(sc, { x: 208 + i * 240, y: SH_Y, w: 210, h: SH_H, title: `Shard ${sh.name}`, sub: `hash byte ${hex2(sh.lo)}–${hex2(sh.hi - 1)}`, kind: 'shard' });
      shardN[sh.name] = n;
      sh.out = [execN.bottom, [execN.cx, OUT_LANE], [n.cx + 30, OUT_LANE], [n.cx + 30, SH_Y]];
      sh.back = [[n.cx - 30, SH_Y], [n.cx - 30, RET_LANE], [combN.cx, RET_LANE], combN.bottom];
      edge(sc, [...sh.out.slice(0, -1), [n.cx + 30, SH_Y - 3]], { kind: 'muted' });
      edge(sc, [...sh.back.slice(0, -1), [combN.cx, ROW2_Y + ROW2_H + 3]], { kind: 'muted' });
    });
    text(sc, 24, 456, 'The hash here is FNV-1a, first byte split into thirds; Neki uses xxhash. Row counts and latency are illustrative.', { cls: 'text' });

    // ---------- run plumbing: everything a run schedules dies with it ----------
    function go(pts, duration, fn, kind = 'query') {
      const id = runId;
      const p = packet(sc, clock, pts, { kind, duration, onDone: () => { live.delete(p); if (id === runId && fn) fn(); } });
      live.add(p);
    }
    function wait(ms, fn) {
      const id = runId;
      timers.push(clock.after(ms, () => { if (id === runId) fn(); }));
    }
    function seq(steps) {
      const id = runId;
      let i = 0;
      const next = () => { if (id === runId && i < steps.length) steps[i++](next); };
      next();
    }
    function abort() {
      runId++;
      for (const p of live) p.cancel();
      live.clear();
      for (const cancel of timers) cancel();
      timers = [];
    }

    function resetNodes() {
      for (const n of [appN, parseN, normN, cacheN, planN, guardN, execN, combN]) n.setState(null);
      for (const n of Object.values(shardN)) { n.setState(null); n.tag(null); }
      parseN.setSub('syntax tree');
      normN.setSub('literals → $n');
      cacheN.setSub(`${cache.size} cached`);
      planN.setSub('route type');
      guardN.setSub(`limit: ${fanout}`);
      execN.setSub('—');
      combN.setTitle('Combine');
      combN.setSub('—');
      planT.setAttribute('class', 'text mono text--ink');
      resT.setAttribute('class', 'text mono text--ink');
      normT.textContent = planT.textContent = resT.textContent = '';
    }

    // ---------- one run ----------
    function run(key, vals) {
      abort();
      resetNodes();
      const P = PRESETS[key];
      const sql = P.sql(vals);
      const entry = cache.get(P.norm);
      const hit = !!entry;
      const targets = P.targets(vals);
      const names = targets.map((t) => t.name);
      last = { key, vals };
      busy = true;
      sqlT.textContent = sql;
      renderTranscript(P, sql, null);
      appN.setState('active');

      seq([
        (next) => go([appN.right, parseN.left], 300, next),
        (next) => {
          appN.setState(null);
          parseN.setState('active');
          parseN.setSub(P.dml ? 'UPDATE, parsed' : 'SELECT, parsed');
          wait(110, next);
        },
        (next) => go([parseN.right, normN.left], 170, next),
        (next) => {
          parseN.setState(null);
          normN.setState('active');
          normN.setSub(literalText(key, vals));
          normT.textContent = P.norm;
          wait(130, next);
        },
        (next) => go([normN.right, cacheN.left], 170, next),
        (next) => {
          normN.setState(null);
          cacheN.setState(hit ? 'ok' : 'warn');
          cacheN.setSub(`${hit ? 'hit' : 'miss'} · ${cache.size} cached`);
          wait(130, next);
        },
        (next) => go([cacheN.right, planN.left], 170, next),
        (next) => {
          planN.setState('active');
          if (hit) { entry.uses++; hits++; planN.setSub(`reused: ${P.route}`); } else {
            cache.set(P.norm, { plan: P.plan, uses: 1, firstVals: vals.join(', ') });
            misses++;
            planN.setSub(`built: ${P.route}`);
          }
          cacheN.setSub(`${hit ? 'hit' : 'miss'} · ${cache.size} cached`);
          planT.textContent = `${P.plan} · fan-out ${P.fanout}`;
          renderTranscript(P, sql, null, true);
          renderCache(P.norm);
          renderPills(P, hit);
          mHits.set(String(hits), hit ? 'good' : null);
          mMiss.set(String(misses), hit ? null : 'warn');
          mFan.set(P.fanout, P.fanout === 'scatter' ? 'warn' : null);
          wait(hit ? 110 : 380, next);
        },
        (next) => go([planN.right, guardN.left], 170, next),
        (next) => {
          cacheN.setState(null);
          planN.setState(null);
          if (LEVEL[P.fanout] > LEVEL[fanout]) { reject(P, sql); return; }
          guardN.setState('ok');
          guardN.setSub(`${P.fanout} ≤ ${fanout}`);
          wait(110, next);
        },
        (next) => go([guardN.bottom, execN.top], 200, next),
        (next) => {
          guardN.setState(null);
          execN.setState('active');
          execN.setSub(`${targets.length} of ${SHARDS.length} shards`);
          for (const sh of SHARDS) if (!targets.includes(sh)) shardN[sh.name].setState('dim');
          let left = targets.length;
          for (const t of targets) go(t.out, 420, () => { if (--left === 0) next(); });
        },
        (next) => {
          execN.setState(null);
          for (const t of targets) {
            shardN[t.name].setState('active');
            shardN[t.name].tag(partialText(key, vals, t), 'query');
          }
          wait(170, next);
        },
        (next) => {
          let left = targets.length;
          for (const t of targets) go(t.back, 440, () => { shardN[t.name].setState(null); if (--left === 0) next(); });
        },
        (next) => {
          combN.setState('active');
          const c = combineText(key, vals, targets);
          combN.setTitle(c.title);
          combN.setSub(c.sub);
          wait(170, next);
        },
        (next) => go([combN.left, [appN.cx, combN.cy], appN.bottom], 420, next),
        () => {
          combN.setState(null);
          appN.setState('ok');
          const res = resultLines(key, vals, targets);
          resT.textContent = res.short;
          renderTranscript(P, sql, res.lines, true);
          const ms = (hit ? 0.1 : 1.5) + Math.max(...targets.map(() => 0.8 + rand() * 1.4)) + (targets.length > 1 ? 0.3 : 0);
          mShards.set(`${targets.length} of ${SHARDS.length}`, targets.length === SHARDS.length ? 'warn' : 'good');
          mLat.set(`${ms.toFixed(1)} ms`);
          status.set('normal', `Normal: answered by ${targets.length === 1 ? 'one shard' : `${targets.length} shards`}`);
          log.add(`${sql} → ${P.route}, shard${names.length > 1 ? 's' : ''} ${names.join(', ')} · cache ${hit ? 'hit' : 'miss'}`, 'query');
          narrateRun(key, vals, hit, entry, targets);
          busy = false;
          wait(700, () => appN.setState(null));
          scheduleAuto();
        },
      ]);
    }

    function reject(P, sql) {
      const msg = `ERROR: statement's fan-out (${P.fanout}) exceeds __neki.fanout (${fanout})`;
      guardN.setState('down');
      guardN.setSub(`${P.fanout} > ${fanout}`);
      resT.textContent = msg;
      resT.setAttribute('class', 'text mono text--danger');
      renderTranscript(P, sql, [msg], true, true);
      mShards.set('0', null);
      mLat.set('—');
      status.set('error', 'Errors: the fan-out guard rejected the statement');
      log.add(msg, 'error');
      ctx.narrate(`<p>The plan needs <b>${P.fanout}</b> fan-out, but this session set <code>__neki.fanout = '${fanout}'</code>. The guard rejects the statement before any shard is contacted.</p>`
        + '<p>This is useful in development or CI: an accidental scatter fails loudly instead of quietly touching every shard. The setting covers SELECT and DML, not DDL.</p>');
      go([guardN.top, [guardN.cx, ERR_Y], [appN.cx, ERR_Y], appN.top], 700, () => {
        busy = false;
        appN.setState('down');
        wait(900, () => appN.setState(null));
        scheduleAuto();
      }, 'danger');
    }

    // ---------- text helpers ----------
    function literalText(key, vals) {
      if (key === 'count') return 'no literals';
      if (key === 'in') { const list = `(${vals.join(', ')})`; return list.length > 14 ? `${vals.length} values → $1` : `${list} → $1`; }
      return `${vals[0]} → $1`;
    }
    function partialText(key, vals, t) {
      if (key === 'count') return `count ${partialCount(t).toLocaleString()}`;
      const n = vals.filter((v) => shardOf(v) === t).reduce((a, v) => a + rowsFor(v), 0);
      return key === 'update' ? `UPDATE ${n}` : `${n} rows`;
    }
    const partialCount = (t) => 1800 + (fnv1a(`count:${t.name}`) % 2400);
    function combineText(key, vals, targets) {
      if (key === 'count') {
        const parts = targets.map(partialCount);
        return { title: 'Aggregate [Ordered]', sub: `${parts.map((p) => p.toLocaleString()).join(' + ')} = ${parts.reduce((a, b) => a + b, 0).toLocaleString()}` };
      }
      const total = vals.reduce((a, v) => a + rowsFor(v), 0);
      if (key === 'in') return { title: 'Collapse', sub: `${total} rows from ${targets.length === 1 ? 'one shard' : `${targets.length} shards`}` };
      return { title: 'Combine', sub: 'one route: nothing to merge' };
    }
    function resultLines(key, vals, targets) {
      if (key === 'count') {
        const sum = targets.map(partialCount).reduce((a, b) => a + b, 0);
        return { short: `count = ${sum.toLocaleString()}`, lines: [' count', '-------', ` ${sum}`, '(1 row)'] };
      }
      const total = vals.reduce((a, v) => a + rowsFor(v), 0);
      if (key === 'update') return { short: `UPDATE ${total}`, lines: [`UPDATE ${total}`] };
      return { short: `${total} rows`, lines: [`(${total} rows)`] };
    }

    function narrateRun(key, vals, hit, entry, targets) {
      const P = PRESETS[key];
      const names = targets.map((t) => `<b>${t.name}</b>`).join(' and ');
      let cachePart;
      if (!hit) cachePart = `<p><b>Plan cache miss.</b> No plan exists for <code>${P.norm}</code>, so the router builds one against the current data topology and caches it under that normalized text.</p>`;
      else if (entry.firstVals !== vals.join(', ') && key !== 'count') cachePart = `<p><b>Plan cache hit.</b> The plan was built for <code>${entry.firstVals}</code>. This run uses <code>${vals.join(', ')}</code>, but both normalize to the same text, so the plan is reused and only the bound value changes.</p>`;
      else cachePart = `<p><b>Plan cache hit.</b> <code>${P.norm}</code> was planned before, so the router reuses that plan.</p>`;
      const routePart = {
        single: `<p><code>Route [EqualUnique]</code>: <code>tenant_id = ${vals[0]}</code> hashes into shard ${names}’s range, so one shard answers and nothing needs merging. Plain <code>EXPLAIN</code> would work too: the plan is a single route.</p>`,
        in: `<p><code>Route [IN]</code> goes only to the shards that own the listed values, here ${names}. <code>Collapse</code> merges their rows. The shard that holds none of them is not contacted.</p>`,
        count: '<p>There is no shard-key predicate, so the plan is <code>Route [Scatter]</code>. Every shard counts its own rows, and <code>Aggregate</code> adds the partial counts. Scatter cost grows with the shard group: for frequent queries, add a shard-key predicate or use a GSI.</p>',
        update: `<p>DML is planned the same way. The shard key is in the WHERE clause, so the update goes to shard ${names} only. A transaction that wrote on several shards would not commit atomically across them.</p>`,
      }[key];
      ctx.narrate(cachePart + routePart);
    }

    // ---------- extra panel: EXPLAIN transcript, pills, plan cache ----------
    const transcript = h('pre', { class: 'codeblock' });
    const pills = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0 14px' } });
    const cacheBody = h('tbody');
    ctx.extra.append(
      transcript, pills,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Plan cache key (normalized)' }), h('th', { text: 'Plan' }), h('th', { text: 'Uses' }))),
        cacheBody)));

    function renderTranscript(P, sql, result, showPlan = false, isErr = false) {
      transcript.textContent = '';
      const line = (str, cls) => transcript.append(h('div', { class: cls, text: str || ' ' }));
      line(`=> SET __neki.fanout = '${fanout}';`);
      line(`=> EXPLAIN (NEKI_PLAN, COSTS OFF, FORMAT TEXT) ${sql};`);
      if (showPlan) for (const l of P.explain) line(l); else line('…');
      line('');
      line(`=> ${sql};`);
      if (!result) line('…');
      else for (const l of result) line(l, isErr ? 'err' : null);
    }

    function renderPills(P, hit) {
      const single = !P.combine;
      pills.replaceChildren(
        h('span', { class: 'pill', 'data-tone': hit ? 'good' : 'warn', text: hit ? 'Plan cache hit' : 'Plan cache miss: plan built' }),
        h('span', { class: 'pill', 'data-tone': P.fanout === 'scatter' ? 'warn' : 'good', text: `Fan-out: ${P.fanout}` }),
        h('span', { class: 'pill', text: single ? 'Plain EXPLAIN works: one route' : 'Plain EXPLAIN is not enough: use NEKI_PLAN' }));
    }

    function renderCache(current) {
      cacheBody.replaceChildren();
      if (!cache.size) {
        cacheBody.append(h('tr', {}, h('td', { colspan: 3, style: { color: 'var(--faint)' }, text: 'Empty: the next statement builds a fresh plan.' })));
        return;
      }
      for (const [k, e] of cache) {
        const style = k === current ? { fontWeight: '600' } : null;
        cacheBody.append(h('tr', { style },
          h('td', {}, h('code', { text: k })), h('td', {}, h('code', { text: e.plan })), h('td', { text: String(e.uses) })));
      }
    }

    // ---------- controls ----------
    const presetSel = select({
      label: 'Query',
      options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
      value: 'single',
      onChange: (v) => {
        valsIn.set(PRESETS[v].defaults);
        valsIn.input.disabled = v === 'count';
        runManual();
      },
    });
    const valsIn = textInput({ label: 'tenant_id value(s)', value: '4821', width: 130 });
    valsIn.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runManual(); });

    function parseVals() {
      const vals = [...new Set((valsIn.value.match(/\d{1,6}/g) || []).map(Number))].slice(0, 4);
      return presetSel.value === 'in' ? vals : vals.slice(0, 1);
    }
    // A query the reader runs stays on screen: pause auto-run instead of overwriting it.
    function pauseAuto() {
      if (!autoOn) return;
      autoOn = false;
      autoToggle.set(false);
      log.add('Auto-run paused so your result stays on screen', 'info');
    }
    function runManual() {
      pauseAuto();
      const key = presetSel.value;
      const vals = parseVals();
      if (key !== 'count' && !vals.length) {
        log.add('Enter a numeric tenant_id (up to six digits)', 'error');
        return;
      }
      run(key, vals);
    }

    function scheduleAuto() { if (autoOn) wait(900, autoTick); }
    function autoTick() {
      if (!autoOn) return;
      const r = rand();
      const key = r < 0.35 ? 'single' : r < 0.6 ? 'in' : r < 0.8 ? 'count' : 'update';
      const a = pick(POOL);
      let b = pick(POOL);
      while (b === a) b = pick(POOL);
      run(key, key === 'in' ? [a, b] : [a]);
    }

    function setFanout(v) {
      pauseAuto();
      fanout = v;
      log.add(`SET __neki.fanout = '${v}'`, 'query');
      if (last) run(last.key, last.vals); else guardN.setSub(`limit: ${v}`);
    }

    function topologyChanged() {
      const n = cache.size;
      cache.clear();
      renderCache(null);
      cacheN.setSub('0 cached');
      cacheN.setState('warn');
      clock.after(900, () => cacheN.setState(null));
      log.add(`Data topology changed: ${n} cached plan${n === 1 ? '' : 's'} invalidated`, 'mgmt');
      ctx.narrate('<p>The data topology changed, so every cached plan is invalid. The next statement misses the cache and is planned again against the new topology.</p>'
        + '<p>Prepared statements are no exception: preparing a statement does not pin its plan.</p>');
    }

    const autoToggle = toggle({ label: 'Auto-run', checked: true, onChange: (v) => { autoOn = v; log.add(`Auto-run ${v ? 'on' : 'off'}`, 'info'); if (v && !busy) autoTick(); } });
    ctx.toolbar.append(
      group('Query', presetSel, valsIn, button('Run', runManual, { variant: 'primary', icon: 'send' })),
      group('Session', segmented({
        label: '__neki.fanout',
        options: [{ value: 'single', label: 'single' }, { value: 'multi', label: 'multi' }, { value: 'scatter', label: 'scatter' }],
        value: 'scatter',
        onChange: setFanout,
      })),
      group('Planner',
        button('Topology changed', topologyChanged, { variant: 'control', icon: 'restart', title: 'Invalidate every cached plan' }),
        autoToggle),
    );

    const mHits = metric('Cache hits', '0'), mMiss = metric('Cache misses', '0'), mShards = metric('Shards touched'),
      mFan = metric('Fan-out'), mLat = metric('Latency (illustrative)');
    ctx.readout.append(mHits.el, mMiss.el, mShards.el, mFan.el, mLat.el);

    renderCache(null);
    status.set('na', 'Your app is waiting for its first result');
    ctx.narrate('<p>One router, one statement at a time. The app sends SQL; the router parses it, replaces literals with parameters, and looks for a cached plan under that normalized text.</p>'
      + '<p>Auto-run sends a random query every few seconds. Pick a query yourself, or tighten <code>__neki.fanout</code>.</p>');
    wait(400, () => run('single', [4821]));
  },
};
