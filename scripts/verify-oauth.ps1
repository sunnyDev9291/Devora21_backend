# Verify OAuth provider configuration and endpoints.
$base = if ($env:API_BASE_URL) { $env:API_BASE_URL } else { "http://31.44.7.64:5000" }

Write-Host "OAuth verification for $base`n"

try {
  $providers = Invoke-RestMethod -Uri "$base/auth/providers" -TimeoutSec 10
  $providers | ConvertTo-Json -Depth 5
  Write-Host ""

  foreach ($name in @("google")) {
    $p = $providers.$name
    $label = $name.Substring(0, 1).ToUpper() + $name.Substring(1)
    if ($p.enabled) {
      Write-Host "[OK] $label OAuth enabled"
      Write-Host "     Start:    $($p.startUrl)"
      Write-Host "     Callback: $($p.callbackUrl)"
    } else {
      Write-Host "[--] $label OAuth not configured (503 on /auth/$name)"
      Write-Host "     Add credentials to .env, then restart the server."
      Write-Host "     Register this callback in the provider console:"
      Write-Host "     $($p.callbackUrl)"
    }
    Write-Host ""
  }
} catch {
  Write-Host "Failed to reach $base/auth/providers"
  Write-Host $_.Exception.Message
  exit 1
}

foreach ($path in @("/auth/google")) {
  try {
    Invoke-WebRequest -Uri "$base$path" -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 10 | Out-Null
    Write-Host "[??] $path returned success without redirect"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 503) {
      Write-Host "[--] $path -> 503 (credentials missing)"
    } elseif ($status -eq 302) {
      Write-Host "[OK] $path -> 302 redirect to provider"
    } else {
      Write-Host "[??] $path -> $status"
    }
  }
}
