-- Rebuild the time slider's frames from the stored readings instead of from ingest rounds.
--
-- Before: one frame per clock hour in which an ingest run succeeded (so a backfill produced no extra frames).
-- Now:   one frame at the top of every hour, from the first stored reading up to the newest, plus a final
--        "latest" frame. So a 6-hour backfill gives ~6 frames immediately.
--
-- Each frame is the map as of its time t: every station's newest reading at or before t, no older than max_age
-- (see observations_as_of). Hours with no readings in range (e.g. a long outage) produce no frame.
--
-- The final frame's time is the later of the newest reading and the latest successful ingest run, so it lines up
-- with the "most recent refresh" shown on the site.
--
-- Call as:  POST {SUPABASE_URL}/rest/v1/rpc/poll_frames   body {"max_frames": 48}
-- Returns a JSON array, oldest -> newest (same shape as before, so the website needs no change):
--   [{"t": "<frame time>", "hour": "<start of that hour>", "rows": [["KSLC", 52.1, 20], ...]}, ...]
--   rows are [station_id, temp_f, age_minutes of that reading at time t].
-- Capped at 168 frames (a week of hourly frames) to stay inside the API's statement timeout.
-- Hours are whole-hour boundaries, which coincide in UTC and Mountain time.
create or replace function public.poll_frames(
  max_frames int      default 48,
  max_age    interval default interval '3 hours'
)
returns jsonb
language sql
stable
as $$
  with bounds as (
    select
      min(observed_at) as first_t,
      greatest(
        max(observed_at),
        (select max(finished_at) from public.polls where status in ('ok', 'partial'))
      ) as last_t
    from public.observations
  ),
  times as (
    -- the top of every hour after the first reading, up to the latest time, that has at least one reading within
    -- max_age before it. Hours inside an outage are skipped here (not after the limit below), so max_frames
    -- still means "this many frames" ...
    select h as t
    from bounds, generate_series(date_trunc('hour', first_t) + interval '1 hour', last_t, interval '1 hour') as h
    where exists (
      select 1 from public.observations o where o.observed_at <= h and o.observed_at > h - max_age
    )
    union
    -- ... plus one final frame at the latest time itself
    select last_t from bounds where last_t is not null
  ),
  chosen as (
    select t from times order by t desc limit least(greatest(max_frames, 1), 168)
  ),
  frames as (
    select
      c.t,
      date_trunc('hour', c.t) as hour,
      (
        select coalesce(jsonb_agg(jsonb_build_array(o.station_id, o.temp_f, o.age_minutes)), '[]'::jsonb)
        from public.observations_as_of(c.t, max_age) o
      ) as rows
    from chosen c
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('t', t, 'hour', hour, 'rows', rows) order by t),
    '[]'::jsonb
  )
  from frames
  where jsonb_array_length(rows) > 0;
$$;

grant execute on function public.poll_frames(int, interval) to anon, authenticated;
