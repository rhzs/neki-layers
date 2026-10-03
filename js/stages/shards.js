// Stage 4 · Shards. One shard across three availability zones: a primary and two replicas.
// Writes commit on the primary and stream to the replicas as WAL. Reads on a replica
// connection go where the recency, locality and affinity policies point, and can miss a
// write that has only just committed.
import {
  h, s, scene, node, edge, packet, text, shorten, viaY, button, toggle, slider, segmented, select, group, metric,
  createChart, rng, fmtMs,
} from '../core.js';

const COL = { a: 164, b: 480, c: 796 };
const BAND = { y: 76, h: 438, w: 296 };
const SW = 220;
const Y = { router: 96, lane: 178, side: 206, pg: 238, pgH: 76, pm: 318 };
const APPLY_MS = 150;
const FRESH_S = 30, MAX_S = 900;
const LAG_STOPS = [0, 0.5, 1, 2, 5, 10, 20, 30, 40, 60, 120, 300, 600, 900, 1020, 1200];
const WAIT_MAX = 3000;
const MAX_LIVE = 60;

const lsnStr = (n) => `0/${n.toString(16).toUpperCase()}`;
const fmtLag = (sec) => (sec < 10 ? `${sec.toFixed(1)} s` : sec < 60 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);
const fmtStop = (sec) => (sec < 60 ? `${sec} s` : `${sec / 60} min`);
const lagFrac = (sec) => (sec <= FRESH_S ? 0.35 * Math.sqrt(sec / FRESH_S)
  : sec <= MAX_S ? 0.35 + 0.5 * Math.sqrt((sec - FRESH_S) / (MAX_S - FRESH_S))
    : Math.min(1, 0.85 + (0.15 * (sec - MAX_S)) / 300));
const names = (list) => (list.length ? list.map((r) => r.name).join(', ') : 'none');
const heading = (t) => h('div', { text: t, style: {
  font: '500 11px var(--mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--faint)', margin: '0 0 6px',
} });

export default {
  id: 'shards',
  nav: 'Shards',
  kicker: 'Layer 4 · Physical storage',
  title: 'A primary, its replicas, and the WAL between them',
  lede: 'Each shard is one Postgres primary with replicas in other availability zones. Writes land on the primary and '
    + 'stream to the replicas as WAL. Change the durability policy, slow a replica down, and see which replica serves '
    + 'each read and why.',
  facts: [
    { text: 'A production shard has one primary and at least two replicas. Replicas get the primary’s WAL through Postgres physical replication, serve reads, and can be promoted.', href: 'https://planetscale.com/docs/neki/replicas' },
    { text: 'New shards start with the sync durability policy: the primary normally waits until one replica has received a write.', href: 'https://planetscale.com/docs/neki/overview' },
    { text: 'A replica can hold WAL durably before it replays it, so replica reads are not read-your-writes or monotonic. Keep read-after-write paths on the primary.', href: 'https://planetscale.com/docs/neki/replicas' },
    { text: 'Replica choice skips unknown lag and lag over 15 minutes, prefers 30 seconds or less, then the router’s zone. The __neki.replica_* settings cannot change inside a transaction.', href: 'https://planetscale.com/docs/neki/query-planning' },
    { text: 'A multi-shard read picks a replica separately for each shard, so its rows can reflect slightly different points in time.', href: 'https://planetscale.com/docs/neki/replicas' },
    { text: 'Every Postgres instance runs a Sidecar, which carries all router traffic, and a PostgresManager, which handles startup, teardown, and the data directory.', href: 'https://planetscale.com/docs/neki/overview' },
  ],

  mount(ctx) {
    const { clock, log, status } = ctx;
    const rand = rng(11);

    // ---------- state ----------
    let lsn = 0x3A2F1C0, durability = 'sync', target = 'replica', routerAZ = 'a';
    const policy = { recency: 'prefer', locality: 'prefer', affinity: 'none' };
    let sessionPick = null, writes = 0, stale = 0, failed = 0, lastWait = null, value = 41;
    let errUntil = -1, errText = '', lastFailLog = -1e9, staleFlag = null, live = 0;

    const P = { id: 'P', name: 'Primary', az: 'b', primary: true, reads: 0 };
    const R1 = { id: 'R1', name: 'Replica 1', az: 'a', lagIdx: 4, net: 300, unknown: false, reads: 0, pending: [] };
    const R2 = { id: 'R2', name: 'Replica 2', az: 'c', lagIdx: 3, net: 450, unknown: false, reads: 0, pending: [] };
    const replicas = [R1, R2], all = [R1, P, R2];
    for (const r of replicas) { r.received = lsn; r.replayed = lsn; }

    // ---------- scene ----------
    const sc = scene(ctx.viz, 960, 520, 'One shard: a primary and two replicas in three availability zones, with a router above');
    for (const az of ['a', 'b', 'c']) {
      node(sc, { x: COL[az] - BAND.w / 2, y: BAND.y, w: BAND.w, h: BAND.h, kind: 'band', rx: 14, layer: sc.bg });
      text(sc, COL[az] - BAND.w / 2 + 14, BAND.y + 22, `AZ ${az}`, { cls: 'label' });
    }
    const app = node(sc, { x: 390, y: 12, w: 180, h: 46, title: 'App', sub: 'writes and reads', kind: 'client' });

    for (const o of all) {
      o.cx = COL[o.az];
      o.x = o.cx - SW / 2;
      o.side = node(sc, { x: o.x, y: Y.side, w: SW, h: 28, rx: 6, title: 'Sidecar', kind: 'sidecar',
        onClick: explainSidecar, label: `${o.name} Sidecar: what it does` });
      o.pg = node(sc, { x: o.x, y: Y.pg, w: SW, h: Y.pgH, title: o.name, kind: 'pg',
        sub: `AZ ${o.az} · ${o.primary ? 'read-write' : 'read-only'}`, onClick: () => explainInstance(o), label: `${o.name}: show its state` });
      o.pm = node(sc, { x: o.x, y: Y.pm, w: SW, h: 26, rx: 6, title: 'PostgresManager', kind: 'pm',
        onClick: explainPm, label: `${o.name} PostgresManager: what it does` });
    }

    const walPath = (r) => (r.cx < P.cx ? [P.pg.left, r.pg.right] : [P.pg.right, r.pg.left]);
    for (const r of replicas) {
      edge(sc, shorten(walPath(r)), { kind: 'mgmt' }).setState('flow');
      const [a, b] = walPath(r);
      text(sc, (a[0] + b[0]) / 2, a[1] - 10, 'WAL', { cls: 'label', anchor: 'middle' });
    }

    const bar = (x, y) => {
      s('rect', { x, y, width: SW, height: 8, rx: 4, class: 'bar-bg' }, sc.labels);
      return s('rect', { x, y, width: 0, height: 8, rx: 4, class: 'bar--query' }, sc.labels);
    };
    P.tLsn = text(sc, P.x, 372, '', { cls: 'text mono text--strong' });
    P.tMode = text(sc, P.x, 392, '', { cls: 'text' });
    P.bar = bar(P.x, 404);
    text(sc, P.x, 430, 'Commit wait · 0 to 3 s', { cls: 'label' });
    P.tWait = text(sc, P.x, 452, '', { cls: 'text text--ink' });
    P.tReads = text(sc, P.x, 474, '', { cls: 'text' });
    for (const r of replicas) {
      r.tRecv = text(sc, r.x, 372, '', { cls: 'text mono' });
      r.tReplay = text(sc, r.x, 392, '', { cls: 'text mono' });
      r.bar = bar(r.x, 404);
      for (const [v, lbl] of [[FRESH_S, '30 s'], [MAX_S, '15 min']]) {
        const tx = r.x + SW * lagFrac(v);
        s('rect', { x: tx - 1, y: 399, width: 2, height: 18, class: 'bar--muted' }, sc.labels);
        text(sc, tx, 430, lbl, { cls: 'label', anchor: 'middle' });
      }
      r.tLag = text(sc, r.x, 452, '', { cls: 'text text--ink' });
      r.tReads = text(sc, r.x, 474, '', { cls: 'text' });
      r.tFlag = text(sc, r.x, 496, '', { cls: 'text text--query' });
    }

    // The router can move between zones, so it and its edges live in their own layers.
    const rN = s('g', {}, sc.nodes), rE = s('g', {}, sc.edges);
    let router = null;
    const rEdges = {};
    const appToRouter = () => (router.cx === app.cx ? [app.bottom, router.top]
      : [router.cx < app.cx ? app.left : app.right, [router.cx, app.cy], router.top]);
    const toSidecar = (o) => viaY(router.bottom, o.side.top, Y.lane);
    const toInstance = (o) => [...toSidecar(o), [o.cx, o.pg.cy]];
    const ackPath = () => [[P.cx, P.pg.cy], P.side.top, [P.cx, Y.lane], [router.cx, Y.lane], router.bottom, ...appToRouter().reverse()];
    function drawRouter() {
      rN.textContent = '';
      rE.textContent = '';
      router = node(sc, { x: COL[routerAZ] - 90, y: Y.router, w: 180, h: 54, title: 'Router', sub: `AZ ${routerAZ}`, kind: 'router',
        layer: rN, onClick: explainRouter, label: 'Router: explain read placement' });
      edge(sc, shorten(appToRouter()), { kind: 'query', layer: rE });
      for (const o of all) rEdges[o.id] = edge(sc, shorten(toSidecar(o)), { kind: 'query', layer: rE });
      refreshEdges();
    }

    // ---------- helpers ----------
    const pk = (pts, opt = {}) => {
      live++;
      const fn = opt.onDone;
      return packet(sc, clock, pts, { ...opt, onDone: () => { live--; if (fn) fn(); } });
    };
    const flash = (n, state = 'active', ms = 450) => { n.setState(state); clock.after(ms, () => n.setState(null)); };
    const shown = new Map();
    const put = (el, v) => { if (shown.get(el) !== v) { shown.set(el, v); el.textContent = v; } };
    const attr = (el, k, v) => { const sv = String(v); if (el.getAttribute(k) !== sv) el.setAttribute(k, sv); };
    const mset = (m, v, tone) => { const k = `${v}|${tone || ''}`; if (m.k !== k) { m.k = k; m.set(v, tone); } };

    const lagOf = (r) => (r.unknown ? null : Math.max(LAG_STOPS[r.lagIdx], (r.net + APPLY_MS) / 1000));
    function tier(r) {
      const l = lagOf(r);
      if (l == null) return { key: 'unknown', text: 'lag unknown · excluded', bar: 'bar--muted', frac: 1, tone: 'bad' };
      if (l > MAX_S) return { key: 'over', text: `lag ${fmtLag(l)} · over 15 min, excluded`, bar: 'bar--danger', frac: lagFrac(l), tone: 'bad' };
      if (l > FRESH_S) return { key: 'stale', text: `lag ${fmtLag(l)} · 30 s to 15 min tier`, bar: 'bar--control', frac: lagFrac(l), tone: 'warn' };
      return { key: 'fresh', text: `lag ${fmtLag(l)} · 30 s or less tier`, bar: 'bar--query', frac: lagFrac(l), tone: null };
    }

    // ---------- replica selection (as documented) ----------
    function filter() {
      const note = new Map(), steps = [];
      const drop = (from, keep, why) => { for (const r of from) if (!keep.includes(r)) note.set(r, why); return keep; };
      let c = replicas.filter((r) => lagOf(r) != null && lagOf(r) <= MAX_S);
      for (const r of replicas) if (!c.includes(r)) note.set(r, lagOf(r) == null ? 'excluded: lag unknown' : 'excluded: lag over 15 min');
      steps.push(`Serving replicas with known lag of 15 min or less: ${names(c)}.`);
      if (policy.recency === 'off') steps.push('Recency off: lag does not rank them.');
      else {
        const fresh = c.filter((r) => lagOf(r) <= FRESH_S);
        if (policy.recency === 'require') {
          c = drop(c, fresh, 'excluded: lag over 30 s');
          steps.push(`Recency require: 30 s or less only → ${names(c)}.`);
        } else if (fresh.length) {
          c = drop(c, fresh, 'passed over: a fresher replica exists');
          steps.push(`Recency prefer: the 30 s or less tier → ${names(c)}.`);
        } else if (c.length) steps.push('Recency prefer: nothing at 30 s or less, so the 30 s to 15 min tier serves.');
      }
      const local = c.filter((r) => r.az === routerAZ);
      if (policy.locality === 'off') steps.push('Locality off: the zone does not rank them.');
      else if (policy.locality === 'require') {
        c = drop(c, local, `excluded: not in AZ ${routerAZ}`);
        steps.push(`Locality require: AZ ${routerAZ} only → ${names(c)}.`);
      } else if (local.length) {
        c = drop(c, local, 'passed over: not in the router’s AZ');
        steps.push(`Locality prefer: the router is in AZ ${routerAZ} → ${names(c)}.`);
      } else if (c.length) steps.push(`Locality prefer: no candidate in AZ ${routerAZ}, so any zone.`);
      return { c, note, steps };
    }

    function choose() {
      const { c, note, steps } = filter();
      if (!c.length) {
        steps.push('No candidate is left, so the read fails. It is not sent to the primary.');
        return { chosen: null, note, steps };
      }
      let chosen;
      if (policy.affinity === 'session' && sessionPick && c.includes(sessionPick)) {
        chosen = sessionPick;
        steps.push(`Affinity session: stays on ${chosen.name}.`);
      } else {
        chosen = c[Math.floor(rand() * c.length)];
        if (policy.affinity === 'session') {
          steps.push(sessionPick ? `Affinity session: ${sessionPick.name} is no longer a best candidate, so the session moves to ${chosen.name}.`
            : `Affinity session: ${chosen.name} becomes the session’s replica.`);
          sessionPick = chosen;
        } else {
          steps.push(c.length > 1 ? `Affinity none: ${chosen.name}, picked from ${c.length} for this statement.`
            : `Affinity none: ${chosen.name} is the only candidate.`);
        }
      }
      for (const r of c) note.set(r, r === chosen ? 'chosen' : 'candidate');
      return { chosen, note, steps };
    }

    // ---------- traffic ----------
    function write({ onAck } = {}) {
      const sync = durability === 'sync';
      pk(appToRouter(), { duration: 350, onDone: () => pk(toInstance(P), { duration: 380, onDone: () => {
        lsn += 0x90 + Math.floor(rand() * 0x380);
        const mine = lsn, t0 = clock.now;
        writes++;
        flash(P.pg);
        let acked = false;
        const ack = () => {
          if (acked) return;
          acked = true;
          lastWait = clock.now - t0;
          chart.push(Math.max(lastWait, 20), lastWait > 1000 ? 'slow' : 'ok');
          pk(ackPath(), { duration: 700, r: 4, onDone: () => { if (onAck) onAck(mine); } });
        };
        for (const r of replicas) {
          pk(walPath(r), { kind: 'mgmt', r: 5, duration: r.net, onDone: () => {
            if (mine > r.received) r.received = mine;
            const e = { tw: t0, tr: clock.now, lsn: mine };
            let k = r.pending.length;
            while (k > 0 && r.pending[k - 1].lsn > mine) k--;
            r.pending.splice(k, 0, e);
            if (sync) ack();
          } });
        }
        if (!sync) ack();
      } }) });
    }

    function read({ explain = false, ryw = null } = {}) {
      pk(appToRouter(), { duration: 350, onDone: () => {
        if (target === 'primary') {
          renderDecision(null);
          if (explain) ctx.narrate('<p>Target <code>primary</code>: the read goes to the primary, which has every commit.</p>');
          go(P, (o) => served(o, explain, ryw));
          return;
        }
        const d = choose();
        renderDecision(d);
        if (explain) ctx.narrate(`<p>The router picks a replica for this statement:</p><ol>${d.steps.map((x) => `<li>${x}</li>`).join('')}</ol>`);
        if (!d.chosen) {
          failed++;
          flash(router, 'warn', 600);
          pk(appToRouter().reverse(), { kind: 'danger', duration: 350 });
          setErr('Errors: no replica qualifies, and the read does not fall back to the primary');
          if (explain || ryw || clock.now - lastFailLog > 4000) {
            log.add('Replica read failed: no eligible replica, and no fallback to the primary', 'error');
            lastFailLog = clock.now;
          }
          if (ryw) rywShow('bad', 'failed', 'No replica qualified, so the read failed instead of going to the primary.');
          return;
        }
        go(d.chosen, (o) => served(o, explain, ryw));
      } });
    }

    function go(o, cb) {
      pk(toInstance(o), { duration: 380, onDone: () => { o.reads++; flash(o.pg, 'ok', 350); cb(o); } });
    }

    function served(o, explain, ryw) {
      if (!ryw) { if (explain) log.add(`SELECT served by ${o.name}`, 'query'); return; }
      if (o.primary || o.replayed >= ryw.lsn) {
        rywShow('good', 'saw the write', `${o.name} returned v${ryw.v}${o.primary ? '. The primary always has the latest commit.'
          : `. It had replayed up to ${lsnStr(o.replayed)}.`}`);
        log.add(`Read-your-writes test: ${o.name} returned v${ryw.v}`, 'query');
        ctx.narrate(o.primary
          ? '<p>The read went to the primary, which has every commit. This is the safe path for reading right after a write.</p>'
          : `<p>This time ${o.name} had already replayed the write. That was timing, not a guarantee: with more lag, or another replica, the same read can come back stale.</p>`);
        return;
      }
      stale++;
      staleFlag = { r: o, until: clock.now + 4000 };
      rywShow('bad', 'stale read', `${o.name} returned an older value, not v${ryw.v}. The write is at ${lsnStr(ryw.lsn)}; the replica had replayed only up to ${lsnStr(o.replayed)}.`);
      setErr('Errors: a replica read missed your own write', 3500);
      log.add(`Stale read: ${o.name} had not replayed v${ryw.v} yet`, 'error');
      ctx.narrate(`<p><b>Stale read.</b> ${ryw.sync ? 'The commit returned once a replica had <i>received</i> the WAL'
        : 'With no wait, the commit returned before any replica had the WAL'}, but ${o.name} had not <i>replayed</i> it when the SELECT arrived.</p>`
        + '<p>Replica reads are not read-your-writes. Send read-after-write paths to the primary.</p>');
    }

    function rywTest() {
      const v = ++value, sync = durability === 'sync';
      log.add(`Read-your-writes test: write v${v}, then read it on the ${target} connection`, 'query');
      ctx.narrate(`<p>Writing <code>v${v}</code> through the primary, then reading it back as soon as the commit returns, on the <b>${target}</b> connection…</p>`);
      rywShow(null, 'running', `Writing v${v}…`);
      write({ onAck: (mine) => read({ ryw: { v, lsn: mine, sync } }) });
    }

    function dmlOnReplica() {
      log.add('UPDATE sent on a replica connection', 'query');
      ctx.narrate('<p>Replica connections are read-only. An INSERT, UPDATE, or DELETE on one fails; the router does not forward it to the primary.</p>');
      pk(appToRouter(), { duration: 350, onDone: () => {
        flash(router, 'warn', 600);
        pk(appToRouter().reverse(), { kind: 'danger', duration: 350, onDone: () => {
          failed++;
          setErr('Errors: replica connections are read-only', 2500);
          log.add('UPDATE rejected: replica connections are read-only', 'error');
        } });
      } });
    }

    // ---------- painting ----------
    function setErr(txt, ms = 2500) { errText = txt; errUntil = clock.now + ms; refreshStatus(); }
    let stKey = '';
    function refreshStatus() {
      let st, txt;
      if (clock.now < errUntil) { st = 'error'; txt = errText; }
      else if (durability === 'sync' && lastWait != null && lastWait > 1200) { st = 'slower'; txt = 'Slower: each commit waits for a replica to receive its WAL'; }
      else {
        st = 'normal';
        txt = target === 'replica' ? 'Normal: writes on the primary, reads on a replica' : 'Normal: reads and writes on the primary';
      }
      if (st + txt !== stKey) { stKey = st + txt; status.set(st, txt); }
    }

    function refreshEdges() {
      const c = target === 'replica' ? filter().c : [];
      for (const r of replicas) {
        const e = rEdges[r.id];
        if (!e) continue;
        const on = c.includes(r);
        e.setKind(on ? 'query' : 'muted');
        e.setState(on ? null : 'dim');
      }
    }

    function flagOf(r) {
      if (staleFlag && staleFlag.r === r && clock.now < staleFlag.until) return ['stale read: write not replayed yet', 'text text--danger'];
      if (target === 'replica' && policy.affinity === 'session' && sessionPick === r && filter().c.includes(r)) return ['the session’s replica (affinity)', 'text text--query'];
      return ['', 'text'];
    }

    function paint() {
      put(P.tLsn, `LSN ${lsnStr(lsn)}`);
      put(P.tMode, durability === 'sync' ? 'sync: commit waits for 1 replica' : 'no wait: commit returns at once');
      attr(P.bar, 'width', lastWait == null ? 0 : (SW * Math.min(lastWait, WAIT_MAX)) / WAIT_MAX);
      attr(P.bar, 'class', lastWait > 1000 ? 'bar--control' : 'bar--query');
      put(P.tWait, lastWait == null ? 'no commit yet' : `last commit waited ${fmtMs(lastWait)}`);
      put(P.tReads, `${writes} writes · ${P.reads} reads served`);
      for (const r of replicas) {
        const t = tier(r);
        put(r.tRecv, `received ${lsnStr(r.received)}`);
        put(r.tReplay, `replayed ${lsnStr(r.replayed)}`);
        attr(r.bar, 'width', SW * t.frac);
        attr(r.bar, 'class', t.bar);
        put(r.tLag, t.text);
        put(r.tReads, `${r.reads} reads served`);
        const [f, cls] = flagOf(r);
        put(r.tFlag, f);
        attr(r.tFlag, 'class', cls);
      }
      mset(mWait, lastWait == null ? '—' : fmtMs(lastWait), lastWait > 1000 ? 'warn' : null);
      mset(mLsn, lsnStr(lsn));
      for (const [m, r] of [[mL1, R1], [mL2, R2]]) { const l = lagOf(r); mset(m, l == null ? 'unknown' : fmtLag(l), tier(r).tone); }
      mset(mReads, `${P.reads} / ${R1.reads} / ${R2.reads}`);
      mset(mStale, String(stale), stale ? 'bad' : null);
      mset(mFail, String(failed), failed ? 'bad' : null);
    }

    const code = h('pre', { class: 'codeblock' });
    function paintCode() {
      code.textContent = [
        `SET __neki.target = '${target}';${target === 'primary' ? ' -- default' : ''}`,
        `SET __neki.replica_recency = '${policy.recency}';`,
        `SET __neki.replica_locality = '${policy.locality}';`,
        `SET __neki.replica_affinity = '${policy.affinity}';`,
        '-- set these before BEGIN: they cannot',
        '-- change inside a transaction',
      ].join('\n');
    }

    const decision = h('div', { style: { fontSize: '14px', color: 'var(--muted)' } }, 'Waiting for the first read…');
    let decisionHtml = '';
    function renderDecision(d) {
      let html;
      if (!d) html = '<p style="margin:0">Target <code>primary</code>: reads go to the primary. No replica is chosen.</p>';
      else {
        const rows = replicas.map((r) => {
          const n = d.note.get(r) || '';
          const tone = n === 'chosen' ? 'good' : n.startsWith('excluded') ? 'bad' : n.startsWith('passed') ? 'warn' : '';
          const l = lagOf(r);
          return `<tr><td style="white-space:nowrap">${r.name}</td><td>${r.az}</td><td style="white-space:nowrap">${l == null ? 'unknown' : fmtLag(l)}</td>`
            + `<td><span class="pill"${tone ? ` data-tone="${tone}"` : ''}>${n}</span></td></tr>`;
        }).join('');
        html = `<div class="table-wrap"><table class="table"><thead><tr><th>Replica</th><th>AZ</th><th>Lag</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`
          + `<ol style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.5">${d.steps.map((x) => `<li>${x}</li>`).join('')}</ol>`;
      }
      if (html !== decisionHtml) { decisionHtml = html; decision.innerHTML = html; }
    }

    const rywOut = h('p', { style: { margin: '10px 0 0', fontSize: '13px', color: 'var(--muted)' } },
      'Read-your-writes test: not run yet.');
    function rywShow(tone, label, detail) {
      rywOut.replaceChildren('Read-your-writes test: ', h('span', { class: 'pill', 'data-tone': tone, text: label }), ' ', detail);
    }

    // ---------- explanations ----------
    function explainInstance(o) {
      if (o.primary) {
        ctx.narrate(`<p><b>Primary</b>, AZ ${o.az}. Every write lands here first, at LSN <code>${lsnStr(lsn)}</code>. `
          + `${durability === 'sync' ? 'With sync durability it holds each commit until one replica has received the WAL.' : 'With no wait it acknowledges each commit at once.'}</p>`
          + `<p>Reads with <code>__neki.target = 'primary'</code> run here too: ${P.reads} so far.</p>`);
        return;
      }
      const t = tier(o), ok = filter().c.includes(o);
      ctx.narrate(`<p><b>${o.name}</b>, AZ ${o.az}. It has received WAL up to <code>${lsnStr(o.received)}</code> and replayed up to <code>${lsnStr(o.replayed)}</code>. `
        + 'Only replayed changes are visible to reads.</p>'
        + `<p>Reported ${t.text}. Under the current policies it is ${ok ? 'a <b>candidate</b>' : '<b>not a candidate</b>'} for replica reads.</p>`);
    }
    function explainSidecar() {
      ctx.narrate('<p>Every Postgres instance runs a <b>Sidecar</b>. All router traffic for that instance passes through it, and admins reach the instance through it as well.</p>');
    }
    function explainPm() {
      ctx.narrate('<p><b>PostgresManager</b> starts and stops its Postgres instance and manages its data directory. Admins use it to promote replicas: see <a href="#/control">Control plane</a>.</p>');
    }
    function explainRouter() {
      ctx.narrate(`<p>The router runs in AZ ${routerAZ}. Writes always go to the primary. Reads follow <code>__neki.target</code>; on a replica connection the router ranks replicas like this:</p>`
        + `<ol>${filter().steps.map((x) => `<li>${x}</li>`).join('')}</ol>`);
    }

    // ---------- controls ----------
    function setDurability(v) {
      durability = v;
      log.add(`Durability: ${v === 'sync' ? 'sync' : 'no wait (illustrative)'}`, 'mgmt');
      ctx.narrate(v === 'sync'
        ? '<p><b>sync</b> is the default for new shards. The primary holds each commit until one replica has received its WAL, so the commit wait follows the <i>faster</i> replica. Raise both WAL delays to see it grow.</p>'
        : '<p><b>No wait</b> is here only for contrast. The commit returns as soon as the primary has it, so for a moment the newest commits exist on the primary alone.</p>');
      paint();
    }
    function setTarget(v) {
      target = v;
      log.add(`__neki.target = '${v}'`, 'mgmt');
      ctx.narrate(v === 'primary'
        ? '<p><code>__neki.target = \'primary\'</code> is the default. Reads and writes both go to the primary, so a read right after a write always sees it.</p>'
        : '<p><code>__neki.target = \'replica\'</code>: reads go to a replica the router picks. Replica connections are read-only; try <b>UPDATE on replica</b>.</p>');
      refreshEdges(); paintCode(); paint();
    }
    function setPolicy(k, v) {
      policy[k] = v;
      if (k === 'affinity') sessionPick = null;
      log.add(`__neki.replica_${k} = '${v}'`, 'mgmt');
      ctx.narrate(`<p>With these settings the router ranks replicas like this:</p><ol>${filter().steps.map((x) => `<li>${x}</li>`).join('')}</ol>`
        + (k === 'affinity' && v === 'session' ? '<p>Session affinity reduces switching, but it cannot make reads read-your-writes or monotonic if that replica stops qualifying.</p>' : ''));
      refreshEdges(); paintCode(); paint();
    }
    function setRouterAZ(v) {
      routerAZ = v;
      drawRouter();
      log.add(`Router moved to AZ ${v}`, 'mgmt');
      ctx.narrate(`<p>The router now runs in AZ ${v}. Within a lag tier, locality prefers a replica in that zone${v === 'b' ? '. No replica runs in AZ b, so <b>locality require</b> would leave nothing.' : '.'}</p>`
        + `<ol>${filter().steps.map((x) => `<li>${x}</li>`).join('')}</ol>`);
      paint();
    }
    function onLag(r, idx) {
      const before = tier(r).key;
      r.lagIdx = idx;
      const t = tier(r);
      if (t.key !== before) {
        log.add(`${r.name}: ${t.text}`, 'mgmt');
        const why = {
          fresh: 'It is back in the preferred tier.',
          stale: 'Above 30 s it drops to the second tier: with recency prefer it serves only when no replica at 30 s or less is available, and recency require excludes it.',
          over: 'Above the 15 min maximum it is not eligible at all, whatever the recency setting.',
        }[t.key] || '';
        ctx.narrate(`<p>${r.name} now reports ${fmtLag(lagOf(r))} of lag. ${why}</p>`);
      }
      refreshEdges(); paint();
    }
    function onNet(r, v) {
      r.net = v;
      ctx.narrate(`<p>WAL now takes ${fmtMs(v)} to reach ${r.name} (slowed down so you can see it). `
        + `${durability === 'sync' ? `With sync, each commit waits for the faster replica: about ${fmtMs(Math.min(R1.net, R2.net))}.` : 'With no wait, commits do not wait for it.'}</p>`);
    }
    function onUnknown(r, v) {
      r.unknown = v;
      log.add(`${r.name}: lag ${v ? 'unknown' : 'reported again'}`, 'mgmt');
      ctx.narrate(v ? `<p>The router has no lag figure for ${r.name}, so it leaves it out of replica reads. WAL still streams to it.</p>`
        : `<p>${r.name} reports its lag again and can serve reads.</p>`);
      refreshEdges(); paint();
    }

    const opt = (...vals) => vals.map((v) => ({ value: v, label: v }));
    ctx.toolbar.append(
      group('Writes',
        segmented({ label: 'Durability', options: [{ value: 'sync', label: 'sync (default)' }, { value: 'nowait', label: 'no wait (illustrative)' }], value: 'sync', onChange: setDurability }),
        button('Read-your-writes test', rywTest, { variant: 'primary', icon: 'zap' })),
      group('Reads',
        segmented({ label: 'Target', options: opt('primary', 'replica'), value: target, onChange: setTarget }),
        select({ label: 'Recency', options: opt('prefer', 'require', 'off'), value: 'prefer', onChange: (v) => setPolicy('recency', v) }),
        select({ label: 'Locality', options: opt('prefer', 'require', 'off'), value: 'prefer', onChange: (v) => setPolicy('locality', v) }),
        select({ label: 'Affinity', options: opt('none', 'session'), value: 'none', onChange: (v) => setPolicy('affinity', v) }),
        select({ label: 'Router AZ', options: ['a', 'b', 'c'].map((v) => ({ value: v, label: `AZ ${v}` })), value: routerAZ, onChange: setRouterAZ }),
        button('Read', () => read({ explain: true }), { icon: 'send' }),
        button('UPDATE on replica', dmlOnReplica, { variant: 'danger' })),
      ...replicas.map((r) => group(`${r.name} · AZ ${r.az}`,
        slider({ label: 'Replication lag', min: 0, max: LAG_STOPS.length - 1, value: r.lagIdx, format: (i) => fmtStop(LAG_STOPS[i]), onInput: (i) => onLag(r, i) }),
        slider({ label: 'WAL delay (slowed)', min: 100, max: 3000, step: 50, value: r.net, format: fmtMs, onInput: (v) => onNet(r, v) }),
        toggle({ label: 'Lag unknown', onChange: (v) => onUnknown(r, v) }))),
    );

    const mWait = metric('Commit wait'), mLsn = metric('Primary LSN'), mL1 = metric('Replica 1 lag'), mL2 = metric('Replica 2 lag');
    const mReads = metric('Reads P / R1 / R2'), mStale = metric('Stale reads'), mFail = metric('Failed statements');
    ctx.readout.append(mWait.el, mLsn.el, mL1.el, mL2.el, mReads.el, mStale.el, mFail.el);

    const chartWrap = h('div');
    const chart = createChart(chartWrap, { label: 'Commit wait at the primary', max: WAIT_MAX, unit: 'ms', bars: 40 });
    ctx.extra.append(
      chartWrap,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginTop: '14px' } },
        h('div', {}, heading('Session settings'), code),
        h('div', {}, heading('Last replica choice'), decision, rywOut)),
      h('p', { style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--faint)' } },
        'Packets are slowed down so you can follow them. Delays, lag, and LSNs are illustrative.'));

    // ---------- loops ----------
    clock.every(100, () => {
      for (const r of replicas) {
        const lagMs = LAG_STOPS[r.lagIdx] * 1000;
        while (r.pending.length && clock.now >= r.pending[0].tw + lagMs && clock.now >= r.pending[0].tr + APPLY_MS) {
          const e = r.pending.shift();
          if (e.lsn > r.replayed) r.replayed = e.lsn;
        }
      }
      paint();
      refreshStatus();
    });
    clock.every(450, () => {
      if (live > MAX_LIVE) return;
      if (rand() < 0.35) write(); else read();
    }, { immediate: true });

    drawRouter();
    paintCode();
    paint();
    refreshStatus();
    ctx.narrate('<p>One shard spans three zones: the <b>primary</b> in AZ b and a replica in AZ a and AZ c. Every write lands on the primary, and its WAL streams to both replicas (gray dots).</p>'
      + '<p>With <b>sync</b> durability the commit returns once one replica has received the WAL. Reads on a replica connection go where the policies point; the table below says why. Click any instance for details.</p>');
  },
};
