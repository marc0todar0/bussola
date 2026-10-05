# Backups and upgrades

[← README](../README.md)

## Backup

All the data lives in Postgres.

```bash
docker exec bussola-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > bussola-$(date +%F).sql
```

For nightly backups, run `api/backup.sh` from cron. It writes gzipped dumps and deletes old ones:

```cron
0 4 * * * /path/to/bussola/api/backup.sh
```

| Variable | Default |
|---|---|
| `BUSSOLA_BACKUP_DIR` | `~/backup/bussola` |
| `BUSSOLA_CONTAINER` | `bussola-postgres` |
| `BUSSOLA_KEEP_DAYS` | `30` |

Keep a copy on another machine.

## Restore

⚠️ This replaces **every wallet** on the instance.

```bash
docker compose stop frontend api
docker exec bussola-postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < bussola-2026-09-10.sql
# gzipped: gunzip -c file.sql.gz | docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d
```

On a **new machine**, run `docker compose up -d` once before you restore: the first start creates the `bussola_app` role that the dump refers to.

## Upgrade

Back up first, then:

```bash
curl -LO https://github.com/marc0todar0/bussola/releases/latest/download/docker-compose.yml
docker compose pull
docker compose up -d
```

- Database migrations run by themselves.
- To pin a version, set `BUSSOLA_VERSION=0.2.0` in `.env`.
- Each [release](https://github.com/marc0todar0/bussola/releases) says whether there is anything new to set.
- From a git clone: `git pull && docker compose up -d --build`.
