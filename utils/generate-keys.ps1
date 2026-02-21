Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# -----------------------------
# Random helpers
# -----------------------------
function Get-RandomBytes([int]$length) {
    $bytes = New-Object byte[] $length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return $bytes
}

function Gen-Hex([int]$length) {
    $b = Get-RandomBytes $length
    ($b | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Gen-Base64([int]$length) {
    [Convert]::ToBase64String((Get-RandomBytes $length))
}

function Base64UrlEncode([byte[]]$bytes) {
    ([Convert]::ToBase64String($bytes)).TrimEnd("=") -replace "\+","-" -replace "/","_"
}

# -----------------------------
# JWT token generator
# -----------------------------
function Gen-Token($payloadJson, $headerJson, $secret) {

    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payloadJson)
    $headerBytes  = [System.Text.Encoding]::UTF8.GetBytes($headerJson)

    $payloadB64 = Base64UrlEncode $payloadBytes
    $headerB64  = Base64UrlEncode $headerBytes

    $signed = "$headerB64.$payloadB64"

    $keyBytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = $keyBytes

    $sigBytes = $hmac.ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($signed)
    )

    $sigB64 = Base64UrlEncode $sigBytes

    return "$signed.$sigB64"
}

# -----------------------------
# Generate values
# -----------------------------
$jwt_secret = Gen-Base64 30

$header = '{"alg":"HS256","typ":"JWT"}'
$iat = [int][double]::Parse((Get-Date -UFormat %s))
$exp = $iat + (5 * 3600 * 24 * 365)

$anon_payload = "{`"role`":`"anon`",`"iss`":`"supabase`",`"iat`":$iat,`"exp`":$exp}"
$service_payload = "{`"role`":`"service_role`",`"iss`":`"supabase`",`"iat`":$iat,`"exp`":$exp}"

$anon_key = Gen-Token $anon_payload $header $jwt_secret
$service_role_key = Gen-Token $service_payload $header $jwt_secret

$secret_key_base = Gen-Base64 48
$vault_enc_key = Gen-Hex 16
$pg_meta_crypto_key = Gen-Base64 24

$logflare_public_access_token  = Gen-Base64 24
$logflare_private_access_token = Gen-Base64 24

$s3_protocol_access_key_id = Gen-Hex 16
$s3_protocol_access_key_secret = Gen-Hex 32

$minio_root_password = Gen-Hex 16

$postgres_password = Gen-Hex 16
$dashboard_password = Gen-Hex 16

# -----------------------------
# Print
# -----------------------------
Write-Host ""
Write-Host "JWT_SECRET=$jwt_secret"
Write-Host ""
Write-Host "ANON_KEY=$anon_key"
Write-Host "SERVICE_ROLE_KEY=$service_role_key"
Write-Host ""
Write-Host "SECRET_KEY_BASE=$secret_key_base"
Write-Host "VAULT_ENC_KEY=$vault_enc_key"
Write-Host "PG_META_CRYPTO_KEY=$pg_meta_crypto_key"
Write-Host "LOGFLARE_PUBLIC_ACCESS_TOKEN=$logflare_public_access_token"
Write-Host "LOGFLARE_PRIVATE_ACCESS_TOKEN=$logflare_private_access_token"
Write-Host "S3_PROTOCOL_ACCESS_KEY_ID=$s3_protocol_access_key_id"
Write-Host "S3_PROTOCOL_ACCESS_KEY_SECRET=$s3_protocol_access_key_secret"
Write-Host "MINIO_ROOT_PASSWORD=$minio_root_password"
Write-Host ""
Write-Host "POSTGRES_PASSWORD=$postgres_password"
Write-Host "DASHBOARD_PASSWORD=$dashboard_password"
Write-Host ""

# -----------------------------
# .env update
# -----------------------------
function Set-Or-AddEnvValue($content, $key, $value) {
    $pattern = "(?m)^" + [regex]::Escape($key) + "=.*"

    if ($content -match $pattern) {
        return ($content -replace $pattern, "$key=$value")
    }
    else {
        return ($content.TrimEnd() + "`r`n$key=$value`r`n")
    }
}

$envPath = ".env"
if (-not (Test-Path $envPath)) {
    Write-Host "No .env found. Skipping."
    exit
}

$reply = Read-Host "Update .env file? (y/N)"
if ($reply -notmatch "^[Yy]") {
    Write-Host "Not updating .env"
    exit
}

$content = Get-Content $envPath -Raw

$content = Set-Or-AddEnvValue $content "JWT_SECRET" $jwt_secret
$content = Set-Or-AddEnvValue $content "ANON_KEY" $anon_key
$content = Set-Or-AddEnvValue $content "SERVICE_ROLE_KEY" $service_role_key
$content = Set-Or-AddEnvValue $content "SECRET_KEY_BASE" $secret_key_base
$content = Set-Or-AddEnvValue $content "VAULT_ENC_KEY" $vault_enc_key
$content = Set-Or-AddEnvValue $content "PG_META_CRYPTO_KEY" $pg_meta_crypto_key
$content = Set-Or-AddEnvValue $content "LOGFLARE_PUBLIC_ACCESS_TOKEN" $logflare_public_access_token
$content = Set-Or-AddEnvValue $content "LOGFLARE_PRIVATE_ACCESS_TOKEN" $logflare_private_access_token
$content = Set-Or-AddEnvValue $content "S3_PROTOCOL_ACCESS_KEY_ID" $s3_protocol_access_key_id
$content = Set-Or-AddEnvValue $content "S3_PROTOCOL_ACCESS_KEY_SECRET" $s3_protocol_access_key_secret
$content = Set-Or-AddEnvValue $content "MINIO_ROOT_PASSWORD" $minio_root_password
$content = Set-Or-AddEnvValue $content "POSTGRES_PASSWORD" $postgres_password
$content = Set-Or-AddEnvValue $content "DASHBOARD_PASSWORD" $dashboard_password

Copy-Item $envPath "$envPath.old" -Force
Set-Content $envPath $content -Encoding utf8

Write-Host "Updated .env (backup: .env.old)"