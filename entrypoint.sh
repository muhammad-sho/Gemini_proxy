#!/bin/sh
set -e

# When started as root (default), fix ownership of the data volume — bind mounts
# arrive owned by whatever uid owns the host directory — then drop to the
# unprivileged app user before launching the server. If the image is run with
# an explicit `user:` or the volume is already writable, we skip straight to exec.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R app:app /data
  exec su-exec app:app "$@"
fi

exec "$@"
