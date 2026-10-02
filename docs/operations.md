# Operations

Keeping a Bussola instance safe over time: backups, restores and upgrades. Back to the [README](../README.md).

- [Backups and restore](#backups-and-restore)
- [Upgrading](#upgrading)

## Backups and restore

Everything lives in the Postgres volume, so a backup is a database dump.

### Back up

A one-off dump:

```bash
docker exec bussola-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > bussola-$(date +%F).sql
```

For regular backups, `api/backup.sh` does the same thing: it reads `.env`,
writes a gzipped dump named `<PGDATABASE>_<timestamp>.sql.gz`, refuses to leave
a truncated file behind if `pg_dump` fails, and deletes dumps older than the
retention period. Run it from cron, for example every night at 4:00:

```cron
0 4 * * * /path/to/bussola/api/backup.sh
```

It is configured through environment variables:

| Variable | Default |
|---|---|
| `BUSSOLA_BACKUP_DIR` | `~/backup/bussola` |
| `BUSSOLA_CONTAINER` | `bussola-postgres` |
| `BUSSOLA_KEEP_DAYS` | `30` |

Keep a copy somewhere other than the machine running Bussola.

A wallet can also be exported as a single archive (see
[Import and export](using.md#import-and-export)), but that is a way to move a
wallet, not a backup of the instance.

### Restore

A restore replaces the whole database, every wallet included:

```bash
docker compose stop frontend api

docker exec bussola-postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'

# a plain .sql dump
docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < bussola-2026-09-10.sql
# or a gzipped one from backup.sh
gunzip -c ~/backup/bussola/bussola_20260910040000.sql.gz | docker exec -i bussola-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

docker compose up -d
```

To restore on a **new machine**, run `docker compose up -d` once first, then
follow the steps above. The first start creates the `bussola_app` database role,
which lives outside the dump, and the dump's permissions refer to it.

## Upgrading

Take a backup first. Then, in the folder with `docker-compose.yml` and `.env`,
download the new version's compose file and restart:

```bash
curl -LO https://github.com/marc0todar0/bussola/releases/latest/download/docker-compose.yml
docker compose pull
docker compose up -d
```

Each release's compose file names the images of that version, so nothing
changes until you download a new one. `BUSSOLA_VERSION` in `.env` overrides it
(e.g. `0.2.0`, to stay on or go back to a release). Your `.env` stays as it is;
the [releases page](https://github.com/marc0todar0/bussola/releases) says what
changed in each version, and whether there is anything new to set.

With a clone of the repository instead ([From the source
code](install.md#from-the-source-code)):

```bash
git pull
docker compose up -d --build
```

Pending database migrations are applied automatically when the API starts, before
it accepts any request. There is nothing to run by hand.

