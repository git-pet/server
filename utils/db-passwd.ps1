Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -----------------------------
# Helpers
# -----------------------------
function Gen-Hex([int]$length) {
    $bytes = New-Object byte[] $length
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Get-EnvValue($key) {
    if (-not (Test-Path ".env")) { return $null }
    $line = Select-String -Path ".env" -Pattern "^$key=" | Select-Object -First 1
    if ($line) { return ($line.Line -split "=",2)[1] }
    return $null
}

function Replace-EnvValue($key, $value) {
    $content = Get-Content ".env" -Raw
    $content = $content -replace "^$key=.*","$key=$value"
    Copy-Item ".env" ".env.old" -Force
    Set-Content ".env" $content
}

# -----------------------------
# Checks
# -----------------------------
try {
    docker compose version | Out-Null
}
catch {
    Write-Host "Docker Compose not found."
    exit 1
}

if (-not (Test-Path ".env")) {
    Write-Host "Missing .env file. Exiting."
    exit 1
}

$new_passwd = Gen-Hex 16

# -----------------------------
# Find Postgres container
# -----------------------------
$dbImagePrefix = "supabase.postgres:"

$composeLines = docker compose ps --format "{{.Image}}`t{{.Service}}`t{{.Status}}" 2>$null

$match = $composeLines | Where-Object { $_ -like "$dbImagePrefix*" } | Select-Object -First 1

if (-not $match) {
    Write-Host "Postgres container not found. Exiting."
    exit 1
}

$parts = $match -split "`t"
$db_image = $parts[0]
$db_srv_name = $parts[1]
$db_srv_status = $parts[2]

if ($db_srv_status -notlike "Up*") {
    Write-Host "Postgres container status: $db_srv_status"
    Write-Host "Exiting."
    exit 1
}

$db_srv_port = Get-EnvValue "POSTGRES_PORT"
$portSource = " (.env):"
if (-not $db_srv_port) {
    $db_srv_port = "5432"
    $portSource = " (default):"
}

$db_admin_user = "supabase_admin"

# -----------------------------
# Preview
# -----------------------------
Write-Host ""
Write-Host "*** Check configuration below before updating database passwords! ***"
Write-Host ""
Write-Host "Service name: $db_srv_name"
Write-Host "Service status: $db_srv_status"
Write-Host "Service port$portSource $db_srv_port"
Write-Host "Image: $db_image"
Write-Host ""
Write-Host "Admin user: $db_admin_user"
Write-Host ""
Write-Host "New database password: $new_passwd"
Write-Host ""

$reply = Read-Host "Update database passwords? (y/N)"
if ($reply -notmatch "^[Yy]") {
    Write-Host "Canceled. Not updating passwords."
    exit 0
}

# -----------------------------
# SQL
# -----------------------------
$sql = @"
alter user anon with password '$new_passwd';
alter user authenticated with password '$new_passwd';
alter user authenticator with password '$new_passwd';
alter user dashboard_user with password '$new_passwd';
alter user pgbouncer with password '$new_passwd';
alter user postgres with password '$new_passwd';
alter user service_role with password '$new_passwd';
alter user supabase_admin with password '$new_passwd';
alter user supabase_auth_admin with password '$new_passwd';
alter user supabase_functions_admin with password '$new_passwd';
alter user supabase_replication_admin with password '$new_passwd';
alter user supabase_storage_admin with password '$new_passwd';

DROP SCHEMA _supavisor CASCADE;
create schema if not exists _supavisor;
alter schema _supavisor owner to supabase_admin;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = '_analytics'
      AND table_name = 'source_backends'
  ) THEN
    UPDATE _analytics.source_backends
    SET config = jsonb_set(
      config,
      '{url}',
      '""postgresql://$db_admin_user:$new_passwd@$db_srv_name:$db_srv_port/postgres""',
      false
    )
    WHERE type = 'postgres';
  END IF;
END
$$;
"@

Write-Host "Updating passwords..."
Write-Host "Connecting to database container..."

$sql | docker compose exec -T $db_srv_name psql -U $db_admin_user -d "_supabase" -v ON_ERROR_STOP=1

# -----------------------------
# Update .env
# -----------------------------
Write-Host "Updating POSTGRES_PASSWORD in .env..."
Replace-EnvValue "POSTGRES_PASSWORD" $new_passwd

Write-Host ""
Write-Host "Success. To update and restart containers use:"
Write-Host ""
Write-Host "docker compose up -d --force-recreate"
Write-Host ""