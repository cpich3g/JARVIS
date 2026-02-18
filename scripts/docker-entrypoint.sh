#!/bin/sh
# Docker entrypoint: initialises openclaw.json from OPENCLAW_CFG_B64 env var
# if set, then hands off to CMD (the gateway start command).
#
# Usage (cloud deployments):
#   Set OPENCLAW_CFG_B64 = base64-encoded contents of openclaw.json
#   The file is written (or overwritten) on every container start so that
#   updating the ACA secret automatically propagates on next restart.
#
# WhatsApp/channel credentials live under ~/.openclaw/credentials/ and
# ~/.openclaw/sessions/ (on the NFS volume) and are NOT touched here.

CONFIG_DIR="${HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"

if [ -n "$OPENCLAW_CFG_B64" ]; then
  mkdir -p "$CONFIG_DIR"
  echo "[entrypoint] Writing openclaw.json from OPENCLAW_CFG_B64..."
  printf '%s' "$OPENCLAW_CFG_B64" | base64 -d > "$CONFIG_FILE"
  if [ $? -eq 0 ]; then
    echo "[entrypoint] Config written OK."
  else
    echo "[entrypoint] WARNING: Config write failed." >&2
  fi
fi

exec "$@"
