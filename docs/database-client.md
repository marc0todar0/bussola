# Connecting a database client

[← Installation](install.md)

Postgres is not published, not even on the server. To reach it, put a `docker-compose.override.yml` next to `docker-compose.yml` (Compose reads it by itself):

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
```

then run `docker compose up -d`. Postgres now listens on the server's `127.0.0.1:5432` only, never the LAN, so you connect through an SSH tunnel. Delete the file and run `docker compose up -d` again to close it.

DBeaver: host `localhost`, port `5432`, database `PGDATABASE`, user `PGUSER`, password `PGPASSWORD`. On the **SSH** tab, turn on *Use SSH Tunnel* and enter your server login.

> ⚠️ `PGUSER` is a superuser: it **bypasses Row Level Security** and can see and change every wallet. Mark the connection read-only in the client.

## Changing PGUSER, PGPASSWORD or PGDATABASE

These values are written into the volume the first time Postgres starts. Changing them in `.env` afterwards renames nothing: the API just can't connect. To really change them, take a [backup](operations.md#backup), start on a new volume and restore. `docker compose down -v` deletes the volume **and all its data**.
