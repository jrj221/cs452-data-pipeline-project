// Ingest orchestration, separated from Supabase/Deno so it can be tested with a fake database.
import type { Observation } from "./nws.ts";

export interface Db {
  listStationIds(): Promise<string[]>;
  /** Start time of the most recent successful run of this same batch, or null. */
  lastOkPollStart(batch: number, batches: number): Promise<Date | null>;
  /** Creates the polls row and returns its id. */
  startPoll(p: { startedAt: Date; batch: number; batches: number; stationsTotal: number }): Promise<number>;
  /** Insert rows, ignoring ones that already exist. Returns how many were actually new. */
  insertObservations(rows: Observation[]): Promise<number>;
  finishPoll(
    id: number,
    p: { status: "ok" | "partial" | "failed"; stationsOk: number; stationsFailed: number; newRows: number; error?: string },
  ): Promise<void>;
}

export interface IngestDeps {
  db: Db;
  fetchObs: (stationId: string, startISO: string) => Promise<Observation[]>;
  now?: () => Date;
  concurrency?: number;
  insertChunk?: number;
}

export interface IngestResult {
  poll_id: number;
  batch: number;
  batches: number;
  since: string;
  stations_total: number;
  stations_ok: number;
  stations_failed: number;
  new_rows: number;
  status: string;
}

const HOUR = 3600_000;

/**
 * How far back to ask NWS for observations. If the last run of this batch succeeded, start slightly
 * before it (30 min overlap) so a late or missed run is made up for. Never go back more than 24 h.
 * With no history, look back 6 h.
 */
export function computeSince(lastOk: Date | null, now: Date): Date {
  const earliest = new Date(now.getTime() - 24 * HOUR);
  const wanted = lastOk ? new Date(lastOk.getTime() - 30 * 60_000) : new Date(now.getTime() - 6 * HOUR);
  return wanted < earliest ? earliest : wanted;
}

/** Station i belongs to batch (i mod batches). Interleaving spreads busy areas across batches. */
export function pickBatch<T>(items: T[], batch: number, batches: number): T[] {
  return items.filter((_, i) => i % batches === batch);
}

export async function runIngest(deps: IngestDeps, batch: number, batches: number): Promise<IngestResult> {
  if (!Number.isInteger(batches) || batches < 1 || !Number.isInteger(batch) || batch < 0 || batch >= batches) {
    throw new Error(`invalid batch ${batch} of ${batches}`);
  }
  const { db, fetchObs } = deps;
  const now = deps.now ?? (() => new Date());
  const concurrency = deps.concurrency ?? 8;
  const chunk = deps.insertChunk ?? 500;

  const startedAt = now();
  const ids = pickBatch(await db.listStationIds(), batch, batches);
  const since = computeSince(await db.lastOkPollStart(batch, batches), startedAt);
  const pollId = await db.startPoll({ startedAt, batch, batches, stationsTotal: ids.length });

  try {
    // Fetch with a small worker pool.
    const rows: Observation[] = [];
    let ok = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          rows.push(...await fetchObs(id, since.toISOString()));
          ok++;
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

    // Insert in chunks; duplicates are ignored by the database (primary key).
    let newRows = 0;
    for (let i = 0; i < rows.length; i += chunk) newRows += await db.insertObservations(rows.slice(i, i + chunk));

    const status = ids.length > 0 && ok === 0 ? "failed" : failed > ids.length * 0.2 ? "partial" : "ok";
    await db.finishPoll(pollId, { status, stationsOk: ok, stationsFailed: failed, newRows });
    return {
      poll_id: pollId, batch, batches, since: since.toISOString(),
      stations_total: ids.length, stations_ok: ok, stations_failed: failed, new_rows: newRows, status,
    };
  } catch (e) {
    await db.finishPoll(pollId, {
      status: "failed", stationsOk: 0, stationsFailed: ids.length, newRows: 0, error: String(e),
    }).catch(() => {});
    throw e;
  }
}
