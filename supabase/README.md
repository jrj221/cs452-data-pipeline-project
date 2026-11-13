# Supabase setup

Run from the repo root. Needs the [Supabase CLI](https://supabase.com/docs/guides/cli) and a free Supabase project.

1. **Link the project.** Note the project ref (the `abcd…` in `abcd.supabase.co`).
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   ```
2. **Create the secret.** Copy a random value, paste it into the dashboard's Vault as `INGEST_SECRET` (the name is
   case-sensitive), then set the same value on the function:
   ```bash
   openssl rand -hex 32 | pbcopy
   supabase secrets set INGEST_SECRET="$(pbpaste)"
   ```
3. **Create the database and schedule.** Applies the migrations (tables, read functions, hourly cron jobs) and loads the stations:
   ```bash
   supabase db push --include-seed
   ```
4. **Deploy the ingest function.**
   ```bash
   supabase functions deploy ingest --no-verify-jwt
   ```
5. **Done.** Cron calls the function every hour. To run it by hand, see "How the APIs are called" in the [main README](../README.md).

Tests for the ingest logic: `node --test supabase/functions/ingest/core.test.ts`
