#!/bin/sh
set -eu

export PGDATABASE="${POSTGRES_DB:-postgres}"
export PGHOST="${POSTGRES_HOST:-localhost}"
export PGPORT="${POSTGRES_PORT:-5432}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

db=$(cd -- "$(dirname -- "$0")" > /dev/null 2>&1 && pwd)

psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin <<EOSQL
do \$\$
begin
  if not exists (select from pg_roles where rolname = 'postgres') then
    create role postgres superuser login password '$PGPASSWORD';
    alter database postgres owner to postgres;
  end if;
end \$\$
EOSQL

for sql in "$db"/init-scripts/*.sql; do
    echo "$0: running $sql"
    psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U postgres -f "$sql"
done

psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U postgres \
    -c "ALTER USER supabase_admin WITH PASSWORD '$PGPASSWORD'"

for sql in "$db"/migrations/*.sql; do
    echo "$0: running $sql"
    psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -f "$sql"
done

if [ -d "$db/app-migrations" ]; then
    for sql in $(ls "$db"/app-migrations/*.sql 2>/dev/null | sort); do
        echo "$0: running app migration $sql"
        psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U postgres -f "$sql"
    done
else
    echo "$0: no app-migrations directory found, skipping"
fi

postinit="/etc/postgresql.schema.sql"
if [ -e "$postinit" ]; then
    echo "$0: running $postinit"
    psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -f "$postinit"
fi

psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin \
    -c 'SELECT extensions.pg_stat_statements_reset(); SELECT pg_stat_reset();' || true