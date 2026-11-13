// Run with:  node --test supabase/functions/ingest/core.test.ts      (Node 22.18+/24 strips types)
import test from "node:test";
import assert from "node:assert/strict";
import { computeSince, type Db, pickBatch, runIngest } from "./core.ts";
import { cToF, fetchObservations, type Observation, parseObservations } from "./nws.ts";

const NOW = new Date("2026-11-12T20:00:00Z");

/**
 * In-memory stand-in for the database. Enforces the (station_id, observed_at) primary key, and answers
 * latestObservedAt() from whatever has actually been stored (plus optional presets).
 */
function fakeDb(stationIds: string[], preset: Record<string, string> = {}) {
  const store = new Map<string, Observation>();
  const polls: any[] = [];
  const inserts: number[] = [];
  const db: Db = {
    listStationIds: async () => stationIds,
    latestObservedAt: async () => {
      const m = new Map<string, Date>(Object.entries(preset).map(([id, iso]) => [id, new Date(iso)]));
      for (const o of store.values()) {
        const t = new Date(o.observed_at);
        if (!m.has(o.station_id) || t > m.get(o.station_id)!) m.set(o.station_id, t);
      }
      return m;
    },
    startPoll: async (p) => (polls.push({ ...p, status: "running" }), polls.length),
    insertObservations: async (rows) => {
      inserts.push(rows.length);
      let n = 0;
      for (const r of rows) {
        const k = `${r.station_id}|${r.observed_at}`;
        if (!store.has(k)) (store.set(k, r), n++);
      }
      return n;
    },
    finishPoll: async (id, p) => void Object.assign(polls[id - 1], p),
  };
  return { db, store, polls, inserts };
}

const obs = (id: string, iso: string, t = 50): Observation => ({ station_id: id, observed_at: iso, temp_f: t });

test("cToF", () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(10), 50);
  assert.equal(cToF(-40), -40);
  assert.equal(cToF(21.7), 71.1);
});

test("parseObservations keeps temps, skips nulls, collapses duplicate times", () => {
  const body = {
    features: [
      { properties: { timestamp: "2026-11-12T19:53:00+00:00", temperature: { value: 10 } } },
      { properties: { timestamp: "2026-11-12T19:53:00Z", temperature: { value: 10 } } }, // same instant
      { properties: { timestamp: "2026-11-12T18:53:00+00:00", temperature: { value: null } } },
      { properties: { timestamp: "2026-11-12T17:53:00+00:00" } },
      { properties: { temperature: { value: 5 } } },
    ],
  };
  const out = parseObservations("KSLC", body);
  assert.deepEqual(out, [{ station_id: "KSLC", observed_at: "2026-11-12T19:53:00.000Z", temp_f: 50 }]);
  assert.deepEqual(parseObservations("X", {}), []);
  assert.deepEqual(parseObservations("X", null), []);
});

test("fetchObservations: 404 => [], retries 5xx then succeeds, throws after 3 failures", async () => {
  const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await fetchObservations("A", "2026-01-01T00:00:00Z", async () => res(404)), []);

  let calls = 0;
  const flaky: typeof fetch = async () => {
    calls++;
    return calls < 2 ? res(503) : res(200, { features: [{ properties: { timestamp: "2026-11-12T19:00:00Z", temperature: { value: 0 } } }] });
  };
  assert.equal((await fetchObservations("A", "2026-01-01T00:00:00Z", flaky)).length, 1);
  assert.equal(calls, 2);

  let n = 0;
  await assert.rejects(fetchObservations("A", "2026-01-01T00:00:00Z", async () => (n++, res(500))));
  assert.equal(n, 3);
});

test("pickBatch partitions the list: every station in exactly one batch", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const parts = [0, 1, 2, 3].map((b) => pickBatch(ids, b, 4));
  assert.deepEqual(parts[0], ["S0", "S4", "S8"]);
  assert.deepEqual(parts.flat().sort(), [...ids].sort());
});

test("computeSince: 6h with no readings, 30 min overlap before the newest reading, capped at 24h", () => {
  assert.equal(computeSince(null, NOW).toISOString(), "2026-11-12T14:00:00.000Z");
  assert.equal(computeSince(new Date("2026-11-12T19:00:00Z"), NOW).toISOString(), "2026-11-12T18:30:00.000Z");
  assert.equal(computeSince(new Date("2026-11-01T00:00:00Z"), NOW).toISOString(), "2026-11-11T20:00:00.000Z");
});

test("runIngest: only this batch's stations are fetched, each from ITS OWN newest reading", async () => {
  const ids = ["A", "B", "C", "D", "E"];
  const { db } = fakeDb(ids, { B: "2026-11-12T19:00:00Z", D: "2026-11-12T19:20:00Z" }); // D newer; A, C, E never seen
  const seen = new Map<string, string>();
  const r = await runIngest({
    db, now: () => NOW,
    fetchObs: async (id, since) => (seen.set(id, since), [obs(id, "2026-11-12T19:50:00.000Z")]),
  }, 1, 2); // batch 1 of 2 => B, D
  assert.deepEqual([...seen.keys()].sort(), ["B", "D"]);
  assert.equal(seen.get("B"), "2026-11-12T18:30:00.000Z");
  assert.equal(seen.get("D"), "2026-11-12T18:50:00.000Z");
  assert.equal(r.since, "2026-11-12T18:30:00.000Z"); // reported "since" = the earliest of the batch
  assert.equal(r.stations_total, 2);
  assert.equal(r.new_rows, 2);
  assert.equal(r.status, "ok");
});

test("runIngest: a station with no readings looks back 6 h", async () => {
  const { db } = fakeDb(["A"]);
  let since = "";
  await runIngest({ db, now: () => NOW, fetchObs: async (_id, s) => (since = s, []) }, 0, 1);
  assert.equal(since, "2026-11-12T14:00:00.000Z");
});

test("REGRESSION: a station that failed is retried from ITS last reading, not from when the batch last succeeded", async () => {
  const f = fakeDb(["A", "B"]);
  // Run 1 at 20:00: A succeeds, B fails (status is still "ok": 1 of 2 failed is over 20%, so make it 'partial' or 'ok' - irrelevant now).
  await runIngest({
    db: f.db, now: () => NOW,
    fetchObs: async (id) => { if (id === "B") throw new Error("NWS down"); return [obs("A", "2026-11-12T19:50:00.000Z")]; },
  }, 0, 1);
  assert.equal(f.store.size, 1);

  // Run 2 an hour later. A resumes from its own pointer; B, which has stored nothing, goes back 6 h, not to A's 19:20.
  const seen = new Map<string, string>();
  const later = new Date("2026-11-12T21:00:00Z");
  await runIngest({
    db: f.db, now: () => later,
    fetchObs: async (id, since) => (seen.set(id, since), [obs(id, "2026-11-12T20:55:00.000Z")]),
  }, 0, 1);
  assert.equal(seen.get("A"), "2026-11-12T19:20:00.000Z");
  assert.equal(seen.get("B"), "2026-11-12T15:00:00.000Z");
});

test("runIngest: running twice with overlapping data inserts no duplicates", async () => {
  const { db, store } = fakeDb(["A", "B"]);
  const fetchObs = async (id: string) => [obs(id, "2026-11-12T19:00:00.000Z"), obs(id, "2026-11-12T19:20:00.000Z")];
  const first = await runIngest({ db, now: () => NOW, fetchObs }, 0, 1);
  const second = await runIngest({ db, now: () => NOW, fetchObs }, 0, 1);
  assert.equal(first.new_rows, 4);
  assert.equal(second.new_rows, 0);
  assert.equal(store.size, 4);
});

test("runIngest: a failing station is counted, others still stored; >20% failing => partial", async () => {
  const ids = ["A", "B", "C", "D", "E"];
  const { db, store } = fakeDb(ids);
  const r = await runIngest({
    db, now: () => NOW,
    fetchObs: async (id) => { if (id === "B") throw new Error("boom"); return [obs(id, "2026-11-12T19:00:00.000Z")]; },
  }, 0, 1);
  assert.equal(r.stations_failed, 1);
  assert.equal(r.stations_ok, 4);
  assert.equal(r.status, "ok"); // 1/5 = 20%, not more than 20%
  assert.equal(store.size, 4);

  const r2 = await runIngest({
    db: fakeDb(ids).db, now: () => NOW,
    fetchObs: async (id) => { if (id !== "A") throw new Error("boom"); return []; },
  }, 0, 1);
  assert.equal(r2.status, "partial");

  const all = fakeDb(ids);
  const r3 = await runIngest({ db: all.db, now: () => NOW, fetchObs: async () => { throw new Error("down"); } }, 0, 1);
  assert.equal(r3.status, "failed");
  assert.equal(all.polls[0].status, "failed");
});

test("runIngest: inserts are chunked", async () => {
  const { db, inserts } = fakeDb(["A"]);
  const many = Array.from({ length: 1201 }, (_, i) => obs("A", new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
  const r = await runIngest({ db, now: () => NOW, insertChunk: 500, fetchObs: async () => many }, 0, 1);
  assert.deepEqual(inserts, [500, 500, 201]);
  assert.equal(r.new_rows, 1201);
});

test("runIngest: db failure marks the poll failed and rethrows; bad batch args rejected", async () => {
  const f = fakeDb(["A"]);
  f.db.insertObservations = async () => { throw new Error("db down"); };
  await assert.rejects(runIngest({ db: f.db, now: () => NOW, fetchObs: async (id) => [obs(id, "2026-11-12T19:00:00.000Z")] }, 0, 1), /db down/);
  assert.equal(f.polls[0].status, "failed");
  assert.match(f.polls[0].error, /db down/);

  await assert.rejects(runIngest({ db: fakeDb([]).db, fetchObs: async () => [] }, 2, 2), /invalid batch/);
  await assert.rejects(runIngest({ db: fakeDb([]).db, fetchObs: async () => [] }, 0, 0), /invalid batch/);
});
