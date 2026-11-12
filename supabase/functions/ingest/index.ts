// Edge Function: ingest NWS observations into Postgres.
//
// Called on a schedule by pg_cron (see supabase/cron.sql), once per batch:
//   POST /functions/v1/ingest?batch=0&of=4
//
// Auth: the caller must send header `x-ingest-secret` equal to the INGEST_SECRET function secret.
// Deploy with --no-verify-jwt (see supabase/config.toml), since cron doesn't send a user JWT.
import { createClient } from "npm:@supabase/supabase-js@2";
import { type Db, runIngest } from "./core.ts";
import { fetchObservations } from "./nws.ts";

function makeDb(): Db {
  const url = Deno.env.get("SUPABASE_URL")!;
  // Secrets can't be named SUPABASE_*, so a custom SERVICE_ROLE_KEY secret is supported as an override.
  const key = Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const check = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data as T;
  };

  return {
    async listStationIds() {
      const ids: string[] = [];
      for (let from = 0; ; from += 1000) { // the REST API returns at most 1000 rows per request
        const r = await sb.from("stations").select("station_id").eq("active", true)
          .order("station_id").range(from, from + 999);
        const page = check(r, "list stations") as { station_id: string }[];
        ids.push(...page.map((s) => s.station_id));
        if (page.length < 1000) return ids;
      }
    },

    async lastOkPollStart(batch, batches) {
      const r = await sb.from("polls").select("started_at").eq("batch", batch).eq("batches", batches)
        .eq("status", "ok").order("started_at", { ascending: false }).limit(1);
      const rows = check(r, "last poll") as { started_at: string }[];
      return rows.length ? new Date(rows[0].started_at) : null;
    },

    async startPoll(p) {
      const r = await sb.from("polls").insert({
        started_at: p.startedAt.toISOString(), batch: p.batch, batches: p.batches, stations_total: p.stationsTotal,
      }).select("id").single();
      return (check(r, "start poll") as { id: number }).id;
    },

    async insertObservations(rows) {
      if (rows.length === 0) return 0;
      // ignoreDuplicates => ON CONFLICT DO NOTHING; .select() then returns only the rows that were inserted.
      const r = await sb.from("observations")
        .upsert(rows, { onConflict: "station_id,observed_at", ignoreDuplicates: true })
        .select("station_id");
      return (check(r, "insert observations") as unknown[]).length;
    },

    async finishPoll(id, p) {
      const r = await sb.from("polls").update({
        finished_at: new Date().toISOString(), status: p.status, stations_ok: p.stationsOk,
        stations_failed: p.stationsFailed, new_rows: p.newRows, error: p.error ?? null,
      }).eq("id", id);
      check(r, "finish poll");
    },
  };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("INGEST_SECRET");
  if (!secret || req.headers.get("x-ingest-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const q = new URL(req.url).searchParams;
  const batches = Number(q.get("of") ?? 1);
  const batch = Number(q.get("batch") ?? 0);
  try {
    const result = await runIngest({ db: makeDb(), fetchObs: fetchObservations }, batch, batches);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
