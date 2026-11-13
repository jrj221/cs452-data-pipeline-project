-- Two things:
--   1. latest_observation_times(): newest stored reading per station, so ingest can start each station's fetch
--      from ITS OWN last reading (a station that failed in one run is retried from where it left off, instead of
--      being skipped because a different station in the same batch succeeded).
--   2. thin_observations(): keep only the newest reading per station per hour, plus an hourly cron job to run it.
--      The map's slider shows one reading per station per hour anyway, so the extra readings (many stations report
--      every 5-20 minutes) were only using space. ~380k rows (46 MB) a week becomes ~100k rows (~12 MB).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Per-station pointers (used by the ingest Edge Function, which runs as the service role)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.latest_observation_times()
returns table (station_id text, latest timestamptz)
language sql
stable
as $$
  select o.station_id, max(o.observed_at) as latest
  from public.observations o
  group by o.station_id;
$$;

revoke all on function public.latest_observation_times() from public, anon, authenticated;
grant execute on function public.latest_observation_times() to service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Thinning: newest reading per station per hour
--
-- An hour "bucket" is (H-1, H]: a reading stamped exactly H:00 belongs to the bucket that ENDS at H. That matches the
-- slider, whose frame at H shows each station's newest reading at or before H, i.e. the last reading in that bucket.
-- So thinning never changes what an hourly frame shows.
--
-- Only completed buckets (ending at or before the start of the current hour) are thinned, so the newest readings,
-- which the "latest" frame uses, are untouched. Only the last 2 days are scanned: older hours were already thinned,
-- and this covers the ingest's backfill window (24 h). If a backfill re-inserts old extra readings, the next run of
-- this function removes them again. Returns how many rows it deleted.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.thin_observations()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with ranked as (
    select station_id, observed_at,
           row_number() over (
             partition by station_id, date_trunc('hour', observed_at - interval '1 microsecond')
             order by observed_at desc
           ) as rn
    from public.observations
    where observed_at <= date_trunc('hour', now())
      and observed_at >  date_trunc('hour', now()) - interval '2 days'
  )
  delete from public.observations o
  using ranked r
  where o.station_id = r.station_id
    and o.observed_at = r.observed_at
    and r.rn > 1;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.thin_observations() from public, anon, authenticated;

-- Runs at :10 every hour, after the ingest jobs (:00-:03) have finished. UTC hours = Mountain hours.
-- (To change how long full-resolution data is kept, change the 'interval' above; to stop thinning:
--  select cron.unschedule('thin-observations');)
select cron.schedule('thin-observations', '10 * * * *', $$ select public.thin_observations(); $$);
