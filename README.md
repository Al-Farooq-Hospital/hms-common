# hms-common

Shared library used by every HMS microservice (`@hms/common`).

- `auth` - JWT sign/verify, `authenticate`, `requireRole`
- `crud` - declarative `crudRouter` / table DDL from a column spec
- `bus` - NATS publish/subscribe helpers (subjects `hms.<resource>.<action>`)
- `service` - `startService()`: Postgres schema + migrations, /healthz /readyz /metrics, error handling, service-to-service `ctx.call()`

Services depend on it as a git dependency:

```json
"@hms/common": "git+https://github.com/Al-Farooq-Hospital/hms-common.git#main"
```

The package is compiled by its `prepare` script when npm installs it. This repo is public so `npm ci` works in Docker/CI without credentials.
To release a change: push to `main`, then in each service run `npm update @hms/common` and commit the lockfile.
