# Verify email flow endpoints (verify-email, forgot-password, reset-password).
$base = if ($env:API_BASE_URL) { $env:API_BASE_URL } else { "http://31.44.7.64:5000" }
$root = Split-Path -Parent $PSScriptRoot

function Get-EmailToken($type, $email) {
  $token = node "$root\scripts\get-email-token.js" $type $email 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $token) { return $null }
  return $token.Trim()
}

Write-Host "Email flow verification for $base"
Write-Host ""

try {
  $status = Invoke-RestMethod -Uri "$base/auth/email-status" -TimeoutSec 10
  $status | ConvertTo-Json -Depth 5
  Write-Host ""
  if ($status.enabled) {
    Write-Host "[OK] SMTP configured (from: $($status.from))"
  } else {
    Write-Host "[--] SMTP not configured - emails log to server console only"
    Write-Host "     Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env and restart"
  }
  Write-Host ""
} catch {
  Write-Host "Failed to reach $base/auth/email-status"
  Write-Host $_.Exception.Message
  exit 1
}

$testEmail = "email-flow-test@example.com"
$testPassword = "TestPass123!"
$newPassword = "NewPass123!"

Write-Host "=== 1. Register (triggers verification email) ==="
try {
  Invoke-RestMethod -Uri "$base/auth/register" -Method POST -ContentType "application/json" `
    -Body (@{ email = $testEmail; password = $testPassword; firstName = "Email"; lastName = "Test" } | ConvertTo-Json) | Out-Null
  Write-Host "PASS register (check server logs for verification link if SMTP off)"
} catch {
  if ($_.ErrorDetails.Message -match "409|already registered") {
    Write-Host "SKIP user already exists"
  } else {
    Write-Host "FAIL $($_.ErrorDetails.Message)"
    exit 1
  }
}

Write-Host ""
Write-Host "=== 2. Verify email ==="
$verifyToken = Get-EmailToken "verify" $testEmail
if (-not $verifyToken) {
  Write-Host "FAIL no verification token in database"
  exit 1
}
try {
  $verified = Invoke-RestMethod -Uri "$base/auth/verify-email" -Method POST -ContentType "application/json" `
    -Body (@{ token = $verifyToken } | ConvertTo-Json)
  Write-Host "PASS verify-email - $($verified.message)"
} catch {
  Write-Host "FAIL $($_.ErrorDetails.Message)"
  exit 1
}

Write-Host ""
Write-Host "=== 3. Forgot password (triggers reset email) ==="
try {
  $forgot = Invoke-RestMethod -Uri "$base/auth/forgot-password" -Method POST -ContentType "application/json" `
    -Body (@{ email = $testEmail } | ConvertTo-Json)
  Write-Host "PASS forgot-password - $($forgot.message)"
} catch {
  Write-Host "FAIL $($_.ErrorDetails.Message)"
  exit 1
}

Write-Host ""
Write-Host "=== 4. Reset password ==="
$resetToken = Get-EmailToken "reset" $testEmail
if (-not $resetToken) {
  Write-Host "FAIL no reset token in database"
  exit 1
}
try {
  $reset = Invoke-RestMethod -Uri "$base/auth/reset-password" -Method POST -ContentType "application/json" `
    -Body (@{ token = $resetToken; password = $newPassword } | ConvertTo-Json)
  Write-Host "PASS reset-password - $($reset.message)"
} catch {
  Write-Host "FAIL $($_.ErrorDetails.Message)"
  exit 1
}

Write-Host ""
Write-Host "=== 5. Login with new password ==="
try {
  $login = Invoke-RestMethod -Uri "$base/auth/login" -Method POST -ContentType "application/json" `
    -Body (@{ email = $testEmail; password = $newPassword } | ConvertTo-Json)
  Write-Host "PASS login with reset password - $($login.user.email)"
} catch {
  Write-Host "FAIL $($_.ErrorDetails.Message)"
  exit 1
}

Write-Host ""
Write-Host "All email flow checks passed."
