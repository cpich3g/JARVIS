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

# Resolve home for the node user (uid 1000) regardless of current USER.
NODE_HOME=$(getent passwd node | cut -d: -f6)
CONFIG_DIR="${NODE_HOME}/.openclaw"
CONFIG_FILE="${CONFIG_DIR}/openclaw.json"

# --- Fix NFS volume permissions (runs as root before dropping privileges) ---
DATA_DIR="${OPENCLAW_STATE_DIR:-/data}"
if [ -d "$DATA_DIR" ] && [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] Fixing ownership of ${DATA_DIR} for node (uid 1000)..."
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
fi

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

# --- Install missing ClawHub skills ---
# Reads skill entries from openclaw.json and installs any that are missing.
SKILLS_DIR="${CONFIG_DIR}/skills"
if [ -f "$CONFIG_FILE" ] && command -v clawhub >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  SKILL_NAMES=$(jq -r '.skills.entries // {} | keys[]' "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$SKILL_NAMES" ]; then
    mkdir -p "$SKILLS_DIR"
    for skill in $SKILL_NAMES; do
      if [ ! -d "${SKILLS_DIR}/${skill}" ]; then
        echo "[entrypoint] Installing ClawHub skill: ${skill}..."
        gosu node clawhub install "$skill" --workdir "$CONFIG_DIR" --no-input 2>&1 || \
          echo "[entrypoint] WARNING: Failed to install skill: ${skill}" >&2
      else
        echo "[entrypoint] Skill already installed: ${skill}"
      fi
    done
  fi
fi

# Ensure config dir is owned by node
chown -R node:node "$CONFIG_DIR" 2>/dev/null || true

# Drop privileges to the node user (uid 1000) for the actual gateway process.
if [ "$(id -u)" = "0" ]; then
  exec gosu node "$@"
fi
exec "$@"
