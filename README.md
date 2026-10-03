# Neki, layer by layer

An interactive, unofficial explainer of [PlanetScale Neki](https://planetscale.com/docs/neki), PlanetScale's horizontally sharded Postgres. Every layer of the architecture has its own live simulation.

**Live site:** https://rhzs.github.io/neki-layers/

> Status: stages 0–3 (overview, client, routing, data topology) are live. Stages 4–7 are being built.

| Stage | Layer | What you can do |
|---|---|---|
| 0 · Overview | All layers | Watch queries, health checks and reconciles flow; trace one query down the layers |
| 1 · Client | One endpoint | Kill a router, toggle app retries, add a router group, send reads to replicas |
| 2 · Routing | Query path | Run single-shard, `IN` and scatter queries; watch the plan cache; trip `__neki.fanout` |
| 3 · Data topology | Logical placement | Hash a `tenant_id` into a key range, pour in rows, split a range, compare GSI and scatter lookups |
| 4 · Shards | Physical storage | Stream WAL to replicas, change durability and lag, see which replica serves a read and why, catch a stale read |
| 5 · Control plane | Failover | Crash a primary or run a planned switchover, tune the buffer window, watch the app's latency |
| 6 · Replicator | Data movement | Reshard one shard into two while the app keeps writing, from copy to cutover |
| 7 · Platform | Orchestration | Change the desired state and watch the operator roll it out; fill a disk and resize it |

## Run locally

No build step and no dependencies. Serve the folder over HTTP (ES modules do not load from `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How it is built

- `index.html`, `css/styles.css`: the shell and design tokens (light and dark).
- `js/core.js`: DOM and SVG builders, a pausable simulated clock, packet animation, controls and widgets.
- `js/app.js`: stage navigation and the scaffold each simulation mounts into.
- `js/stages/*.js`: one module per stage, each exporting `{ id, nav, kicker, title, lede, facts, mount(ctx) }`.

The header's Pause and speed controls drive every stage, because all timing runs through the shared simulated clock.

## Accuracy

The behaviour shown follows PlanetScale's public Neki documentation (overview, terminology, query planning, data topology, replicas, data migration, best practices). The simulations simplify it, and their timings and numbers are illustrative. Neki shard indexes use xxhash; this site uses FNV-1a so it can run in the browser.

Not affiliated with or endorsed by PlanetScale. Neki is in PlanetScale's Platform Preview, so details may change.

## License

MIT
