// NWS (api.weather.gov) client. Plain TypeScript with no Deno-specific imports so it can be unit tested.

export interface Observation {
  station_id: string;
  observed_at: string; // ISO 8601, UTC
  temp_f: number;
}

// NWS requires a User-Agent that identifies the application.
const USER_AGENT = "cs452-pipeline-class-project";

export function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

/** Turn an NWS `/observations` response into rows. Readings with no temperature are skipped. */
export function parseObservations(stationId: string, body: any): Observation[] {
  const out = new Map<string, Observation>(); // keyed by time, so duplicates inside one response collapse
  for (const f of body?.features ?? []) {
    const p = f?.properties;
    const t = p?.temperature?.value;
    if (!p?.timestamp || typeof t !== "number") continue;
    const observed_at = new Date(p.timestamp).toISOString();
    out.set(observed_at, { station_id: stationId, observed_at, temp_f: cToF(t) });
  }
  return [...out.values()];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * All observations for one station since `startISO`.
 * Retries transient failures (429 / 5xx / network). A 404 means "no observations" and returns [].
 * Throws if it still fails after the retries, so the caller can count the station as failed.
 */
export async function fetchObservations(
  stationId: string,
  startISO: string,
  fetchFn: typeof fetch = fetch,
): Promise<Observation[]> {
  const url = `https://api.weather.gov/stations/${encodeURIComponent(stationId)}/observations` +
    `?start=${encodeURIComponent(startISO)}&limit=500`;
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/geo+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return [];
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseObservations(stationId, await res.json());
    } catch (e) {
      if (attempt >= attempts) throw e;
      await sleep(1000 * attempt);
    }
  }
}
