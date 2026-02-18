#!/usr/bin/env pwsh
# deploy-aca.ps1 — Build, push, and deploy OpenClaw to Azure Container Apps
#
# Prerequisites:
#   - az CLI logged in (az login) with access to subscription db2cf8dd-...
#   - Docker Desktop running
#   - pnpm available
#
# Usage:
#   ./scripts/deploy-aca.ps1                     # build + push + update ACA
#   ./scripts/deploy-aca.ps1 -SkipBuild          # push existing local image + update ACA
#   ./scripts/deploy-aca.ps1 -SeedConfig         # also upload openclaw.json to file share
#   ./scripts/deploy-aca.ps1 -SkipBuild -SeedConfig

param(
    [switch]$SkipBuild,
    [switch]$SeedConfig,
    [string]$Tag = (Get-Date -Format "yyyyMMdd-HHmmss")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Config ────────────────────────────────────────────────────────────────────
$RG = "rg-spirosclaw-sandbox"
$ACR = "spirosclawsbxacr"
$ACR_SERVER = "$ACR.azurecr.io"
$APP_NAME = "spirosclawsbx-app"
$IMAGE_REPO = "$ACR_SERVER/openclaw"
$IMAGE_TAG = "${IMAGE_REPO}:${Tag}"
$IMAGE_LATEST = "${IMAGE_REPO}:latest"

$STORAGE_ACCOUNT = "spirosclawsbxst"
$SHARE_NAME = "spirosclawsbx-state"
$LOCAL_CONFIG = "$env:USERPROFILE\.openclaw\openclaw.json"

# ── Helpers ───────────────────────────────────────────────────────────────────
function Step($msg) { Write-Host "`n▶ $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  · $msg" -ForegroundColor Gray }

# ── Step 1: Build ─────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Step "Building Docker image: $IMAGE_TAG"
    docker build `
        --platform linux/amd64 `
        -t $IMAGE_TAG `
        -t $IMAGE_LATEST `
        .
    Ok "Build complete"
}
else {
    Info "Skipping build (using existing local image)"
    # Re-tag latest as the new tag
    docker tag $IMAGE_LATEST $IMAGE_TAG
}

# ── Step 2: Push to ACR ───────────────────────────────────────────────────────
Step "Pushing to ACR: $ACR_SERVER"
az acr login --name $ACR
docker push $IMAGE_TAG
docker push $IMAGE_LATEST
Ok "Push complete: $IMAGE_TAG"

# ── Step 3 (optional): Seed openclaw.json via container exec ──────────────────
# The storage account uses NFS/private endpoint — no direct upload from outside.
# We exec into the running container to write the config to the mounted volume.
if ($SeedConfig) {
    Step "Seeding openclaw.json via container exec (storage uses private endpoint)"
    if (-not (Test-Path $LOCAL_CONFIG)) {
        Write-Error "Config not found at $LOCAL_CONFIG"
        exit 1
    }

    # Prepare config: strip gateway token (injected via env), set bind=lan
    $cfg = Get-Content $LOCAL_CONFIG -Raw | ConvertFrom-Json
    if ($cfg.gateway -and $cfg.gateway.auth) { $cfg.gateway.auth.PSObject.Properties.Remove("token") }
    if ($cfg.gateway) { $cfg.gateway | Add-Member -NotePropertyName "bind" -NotePropertyValue "lan" -Force }

    # Escape for shell injection into the container
    $configJson = ($cfg | ConvertTo-Json -Depth 20 -Compress) -replace "'", "'\'''"

    Info "Writing config to /home/node/.openclaw/openclaw.json in container..."
    az containerapp exec `
        --name $APP_NAME `
        --resource-group $RG `
        --command "sh -c 'mkdir -p /home/node/.openclaw && printf ''%s'' '"'"'$configJson'"'"' > /home/node/.openclaw/openclaw.json && echo OK'" 2>&1

    Ok "openclaw.json written to container volume"
}

# ── Step 4: Update Container App with new image ────────────────────────────────
Step "Updating Container App: $APP_NAME → $IMAGE_TAG"
az containerapp update `
    --name $APP_NAME `
    --resource-group $RG `
    --image $IMAGE_TAG `
    --output table

Ok "Deployment complete!"
Write-Host "`n  URL: https://$(az containerapp show --name $APP_NAME --resource-group $RG --query 'properties.configuration.ingress.fqdn' -o tsv)" -ForegroundColor Yellow
