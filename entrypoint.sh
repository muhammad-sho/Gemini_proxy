#!/bin/sh
set -eu

db_path="${DB_PATH:-/data/local-gemini-proxy.db}"
db_dir=$(dirname "$db_path")

mkdir -p "$db_dir"

if [ -d "$db_path" ]; then
  echo "Database path is a directory: $db_path" >&2
  exit 1
fi

if [ ! -e "$db_path" ]; then
  touch "$db_path"
fi

dir_uid=$(stat -c '%u' "$db_dir")
dir_gid=$(stat -c '%g' "$db_dir")

if [ "$dir_uid" = "0" ]; then
  echo "The deployment directory is owned by root. Run Docker as the normal directory owner." >&2
  exit 1
fi

chown "$dir_uid:$dir_gid" "$db_path"
chmod 600 "$db_path"

for sidecar in "${db_path}-wal" "${db_path}-shm"; do
  if [ -e "$sidecar" ]; then
    chown "$dir_uid:$dir_gid" "$sidecar"
    chmod 600 "$sidecar"
  fi
done

exec su-exec "$dir_uid:$dir_gid" node server.js
