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
# ~/.openclaw/sessions/ (on the NFS volume) and are NOT touched here
# UNLESS WA_CREDS_B64 is set (one-time seed for initial deployment).

CONFIG_DIR="${HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"

if [ -n "$OPENCLAW_CFG_B64" ]; then
  mkdir -p "$CONFIG_DIR"
  echo "[entrypoint] Writing openclaw.json from OPENCLAW_CFG_B64..."
  printf '%s' "$OPENCLAW_CFG_B64" | base64 -d > "$CONFIG_FILE"
  if [ $? -eq 0 ]; then
    echo "[entrypoint] Config written OK."
    # Clear stale device identity so the gateway re-issues tokens.
    rm -f "${CONFIG_DIR}/identity/device.json" \
          "${CONFIG_DIR}/identity/device-auth.json" 2>/dev/null
    echo "[entrypoint] Cleared stale device identity tokens."
  else
    echo "[entrypoint] WARNING: Config write failed." >&2
  fi
fi

# Seed WhatsApp credentials from WA_CREDS_B64 (base64-encoded tar.gz).
# Only extracts if the creds dir is empty (avoids overwriting live session).
WA_CREDS_DIR="${CONFIG_DIR}/credentials/whatsapp/default"
if [ -n "$WA_CREDS_B64" ]; then
  mkdir -p "$WA_CREDS_DIR"
  existing=$(ls -A "$WA_CREDS_DIR" 2>/dev/null | head -1)
  if [ -z "$existing" ]; then
    echo "[entrypoint] Seeding WhatsApp credentials from WA_CREDS_B64..."
    printf '%s' "$WA_CREDS_B64" | base64 -d | tar xzf - -C "$WA_CREDS_DIR"
    if [ $? -eq 0 ]; then
      chmod 600 "$WA_CREDS_DIR/creds.json" 2>/dev/null
      echo "[entrypoint] WhatsApp credentials seeded OK."
    else
      echo "[entrypoint] WARNING: WhatsApp credentials seed failed." >&2
    fi
  else
    echo "[entrypoint] WhatsApp credentials already exist, skipping seed."
  fi
fi

exec "$@"
