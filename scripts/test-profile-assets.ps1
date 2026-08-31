$ErrorActionPreference = "Stop"
$base = "https://api.devora21.com"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$email = "assets-$(Get-Random)@example.com"

Write-Host "Register + verify $email"
Invoke-RestMethod -Uri "$base/auth/register" -Method POST -WebSession $session `
  -ContentType "application/json" `
  -Body (@{ email = $email; password = "TestPass123!"; firstName = "Temp"; lastName = "User" } | ConvertTo-Json) | Out-Null

$token = node scripts/get-email-token.js verify $email
Invoke-RestMethod -Uri "$base/auth/verify-email" -Method POST -ContentType "application/json" `
  -Body (@{ token = $token } | ConvertTo-Json) | Out-Null

$tmp = Join-Path $env:TEMP "devora21-profile-test"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$pngPath = Join-Path $tmp "avatar.png"
[IO.File]::WriteAllBytes($pngPath, [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))

$docxPath = Join-Path $tmp "MyResume.docx"
[IO.File]::WriteAllBytes($docxPath, [byte[]](0x50, 0x4B, 0x03, 0x04) + (1..100 | ForEach-Object { 0 }))

$promptPath = Join-Path $tmp "my-prompt.md"
Set-Content -Path $promptPath -Value "# Write concise bullet points" -NoNewline

Write-Host "POST /auth/onboarding (multipart)"
$onb = curl.exe -s -b ($session.Cookies.GetCookies($base) | ForEach-Object { "$($_.Name)=$($_.Value)" }) -c "$tmp\cookies.txt" `
  -X POST "$base/auth/onboarding" `
  -F "firstName=Jane" `
  -F "lastName=Doe" `
  -F "onboardingCompleted=true" `
  -F "avatar=@$pngPath;type=image/png" `
  -F "resumeTemplate=@$docxPath;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document" `
  -F "promptFile=@$promptPath;type=text/markdown"

# Re-read session cookies from curl cookie jar for subsequent requests
foreach ($line in Get-Content "$tmp\cookies.txt" | Where-Object { $_ -notmatch '^#' -and $_.Trim() }) {
  $parts = $line -split "`t"
  if ($parts.Length -ge 7) {
    $session.Cookies.Add((New-Object System.Net.Cookie($parts[5], $parts[6], $parts[2], $parts[0])))
  }
}

$onbJson = $onb | ConvertFrom-Json
Write-Host "onboardingCompleted=$($onbJson.user.onboardingCompleted)"
Write-Host "resumeTemplateFileName=$($onbJson.user.resumeTemplateFileName)"
Write-Host "promptFileName=$($onbJson.user.promptFileName)"
Write-Host "avatar=$($onbJson.user.avatar)"

$me = Invoke-RestMethod -Uri "$base/auth/me" -WebSession $session
Write-Host "me: customPrompt omitted=$($null -eq $me.user.customPrompt)"

$prompt = Invoke-RestMethod -Uri "$base/auth/profile/prompt" -WebSession $session
Write-Host "prompt content length=$($prompt.content.Length) fileName=$($prompt.fileName)"

$template = Invoke-RestMethod -Uri "$base/auth/profile/resume-template" -WebSession $session
Write-Host "template fileName=$($template.fileName) base64 length=$($template.templateBase64.Length)"

Write-Host "Done."
