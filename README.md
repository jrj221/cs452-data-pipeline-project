# Utah weather pipeline

A data pipeline that pulls live National Weather Service station observations, stores them in a database, and shows
them as a color-shaded map of Utah (blue = cold, red = hot) with a slider to see how temperatures changed over time.

```
Supabase pg_cron (hourly) -> Edge Function `ingest` -> NWS API -> Postgres -> REST API -> static site (docs/)
```

- `supabase/`: database schema, the ingest Edge Function, and the hourly schedule. Setup steps are in
  [supabase/README.md](supabase/README.md).
- `docs/`: the website (served by GitHub Pages).
- `observations.json`: the fixed list of stations tracked. `build_config.py` regenerates it.
- `make_map.py`: an earlier standalone script that builds a one-off `map.html` straight from NWS (no database).

Secrets (the ingest secret, database password, service-role key) are never stored in this repo.
