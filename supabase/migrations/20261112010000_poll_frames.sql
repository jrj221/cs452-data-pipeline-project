-- Read endpoint for the time slider: one "frame" (a map snapshot) per past ingest round.
--
-- Call as:  POST {SUPABASE_URL}/rest/v1/rpc/poll_frames   body {"max_frames": 48}
--
-- Returns one JSON array, oldest -> newest:
--   [{"t": "<when the round finished>", "hour": "<start of the hour>",
--     "rows": [["KSLC", 52.1, 20], ...]},   -- [station_id, temp_f, age_minutes of that reading at time t]
--    ...]
--
-- Rounds come from the polls table: all successful runs (status ok/partial) in the same clock hour are one
-- round, so manual or retried runs don't create duplicate frames. Each frame is the map as of the time the round
-- finished: the newest reading per station at or before then, no older than max_age.
-- Station names/coordinates are not repeated per frame; fetch them once from /rest/v1/stations.
--
-- Returned as a single JSON value so PostgREST's 1000-row response cap doesn't truncate it.
-- Capped at 168 frames (a week of hourly rounds) to stay inside the API's statement timeout.
create or replace function public.poll_frames(
  max_frames int      default 48,
  max_age    interval default interval '3 hours'
)
returns jsonb
language sql
stable
as $$
  with rounds as (
    select date_trunc('hour', started_at) as hour, max(finished_at) as t
    from public.polls
    where status in ('ok', 'partial') and finished_at is not null
    group by 1
    order by 1 desc
    limit least(greatest(max_frames, 1), 168)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        't', r.t,
        'hour', r.hour,
        'rows', (
          select coalesce(jsonb_agg(jsonb_build_array(o.station_id, o.temp_f, o.age_minutes)), '[]'::jsonb)
          from public.observations_as_of(r.t, max_age) o
        )
      )
      order by r.t
    ),
    '[]'::jsonb
  )
  from rounds r;
$$;

grant execute on function public.poll_frames(int, interval) to anon, authenticated;
