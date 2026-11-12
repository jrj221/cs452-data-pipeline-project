-- Weather pipeline schema.
--
--   stations      fixed list of NWS stations we track (seeded from observations.json)
--   observations  one row per (station, observation time): the time series
--   polls         one row per ingest run, so you can see when the pipeline ran and what it got
--
-- Reads:  anyone (the public "anon" key used by the website) can SELECT and call the functions below.
-- Writes: only the service role (used by the ingest Edge Function) -- it bypasses RLS.

create table public.stations (
  station_id  text primary key,
  name        text,
  lat         double precision not null,
  lon         double precision not null,
  county_fips text,                       -- optional, can be filled in later
  active      boolean not null default true
);

create table public.observations (
  station_id  text not null references public.stations (station_id) on delete cascade,
  observed_at timestamptz not null,       -- when the station took the reading (from NWS)
  temp_f      real not null,
  fetched_at  timestamptz not null default now(),   -- when our pipeline stored it
  primary key (station_id, observed_at)   -- makes re-running / overlapping fetches harmless
);

-- "all stations around time T" queries filter on observed_at without a station.
create index observations_observed_at_idx on public.observations (observed_at desc);

create table public.polls (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null,
  finished_at      timestamptz,
  batch            int  not null,         -- which slice of the station list this run handled (0-based)
  batches          int  not null,         -- how many slices the list is split into
  stations_total   int,
  stations_ok      int,
  stations_failed  int,
  new_rows         int,                   -- rows actually inserted (duplicates excluded)
  status           text not null default 'running'
                   check (status in ('running', 'ok', 'partial', 'failed')),
  error            text
);
create index polls_batch_idx on public.polls (batch, batches, started_at desc);

-- ---------------------------------------------------------------------------------------------
-- Row level security: public read, no public write.
-- ---------------------------------------------------------------------------------------------
alter table public.stations     enable row level security;
alter table public.observations enable row level security;
alter table public.polls        enable row level security;

create policy "public read stations"     on public.stations     for select to anon, authenticated using (true);
create policy "public read observations" on public.observations for select to anon, authenticated using (true);
create policy "public read polls"        on public.polls        for select to anon, authenticated using (true);

-- Belt and braces: even if a write policy were added by mistake, these roles can't write.
revoke insert, update, delete, truncate on public.stations, public.observations, public.polls from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Read endpoint.
--
-- Call as:  POST {SUPABASE_URL}/rest/v1/rpc/observations_as_of   (header: apikey: <anon/publishable key>)
--           body {}                                     -> the current map
--           body {"as_of": "2026-11-12T18:00:00Z"}      -> the map as it was at that time
--           body {"max_age": "6 hours"}                 -> accept older readings
--
-- For each station it returns the newest reading at or before `as_of`, as long as that reading is
-- no older than `max_age`. Runs as the caller, so the RLS policies above apply.
-- ---------------------------------------------------------------------------------------------
create or replace function public.observations_as_of(
  as_of   timestamptz default now(),
  max_age interval    default interval '3 hours'
)
returns table (
  station_id  text,
  name        text,
  lat         double precision,
  lon         double precision,
  county_fips text,
  temp_f      real,
  observed_at timestamptz,
  age_minutes integer
)
language sql
stable
as $$
  select distinct on (o.station_id)
         s.station_id, s.name, s.lat, s.lon, s.county_fips,
         o.temp_f, o.observed_at,
         round(extract(epoch from (as_of - o.observed_at)) / 60)::integer as age_minutes
  from public.observations o
  join public.stations s using (station_id)
  where s.active
    and o.observed_at <= as_of
    and o.observed_at >  as_of - max_age
  order by o.station_id, o.observed_at desc;
$$;

grant execute on function public.observations_as_of(timestamptz, interval) to anon, authenticated;

-- Per-station history needs no function. The table itself is readable through the REST API:
--   GET {SUPABASE_URL}/rest/v1/observations?station_id=eq.KSLC&observed_at=gte.2026-11-11T00:00:00Z&order=observed_at.desc
--
-- Pipeline health (when did ingest last succeed?):
--   GET {SUPABASE_URL}/rest/v1/polls?order=started_at.desc&limit=20
