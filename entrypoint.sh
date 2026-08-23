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

chown node:node "$db_path"
chmod 600 "$db_path"

for sidecar in "${db_path}-wal" "${db_path}-shm"; do
  if [ -e "$sidecar" ]; then
    chown node:node "$sidecar"
    chmod 600 "$sidecar"
  fi
done

exec su-exec node:node node server.js
