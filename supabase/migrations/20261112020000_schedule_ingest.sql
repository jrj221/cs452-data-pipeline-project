-- Hourly ingest schedule: pg_cron fires, pg_net calls the `ingest` Edge Function.
--
-- Prerequisite (not in this file, because it is a secret): a Vault secret named INGEST_SECRET whose value matches
-- the function secret set with `supabase secrets set INGEST_SECRET=...`. This file contains no secrets; each job
-- reads the value from Vault when it runs, so it is safe to commit. The project URL is public (it is in every URL
-- of the site), so it is written out below.
--
-- The station list is split into 4 batches (each Edge Function call has a 2 s CPU limit). Each batch runs once an
-- hour, one minute apart: :00, :01, :02, :03. pg_cron uses UTC, and Mountain Time is a whole-hour offset from UTC,
-- so these are also on the hour in Mountain time.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ingest-batch-' || b,
  b || ' * * * *',
  format($cmd$
    select net.http_post(
      url := 'https://yizssnodqrcajfipemrw.supabase.co/functions/v1/ingest?batch=%s&of=4',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ingest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'INGEST_SECRET')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$, b)
)
from generate_series(0, 3) as b;

-- OPTIONAL (not enabled): keep the database under the free plan's 500 MB. At ~120 bytes/row and roughly 50k new
-- rows a day, 500 MB fills in about 2-3 months. To delete rows older than 45 days nightly, run this by hand
-- (deleted history is gone, so pick the window you want):
--   select cron.schedule('prune-observations', '30 3 * * *',
--     $$ delete from public.observations where observed_at < now() - interval '45 days' $$);

-- Useful afterwards (SQL editor):
--   select * from cron.job;                                                  -- the schedules
--   select * from cron.job_run_details order by start_time desc limit 10;    -- did cron fire?
--   select * from net._http_response order by created desc limit 10;         -- what the function returned
--   select cron.unschedule('ingest-batch-0');                                -- stop a job
