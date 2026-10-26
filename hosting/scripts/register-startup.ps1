<#
  Starts the hosted stack when you sign in to Windows, so a reboot does not leave the site down.

    .\register-startup.ps1 -SaasRoot <dir> -Runtime <dir> -Frontends none -TunnelName saas      # install
    .\register-startup.ps1 -Remove                                                              # uninstall

  It registers one per-user scheduled task ("SaaS-Hosting-Stack") that waits for Docker, brings the data
  plane up, then runs stack.mjs. It changes nothing else. Docker Desktop itself must be set to start at
  sign-in (Docker Desktop > Settings > General).
#>
param(
  [string]$SaasRoot,
  [string]$Runtime,
  [ValidateSet('none', 'local')][string]$Frontends = 'none',
  [string]$TunnelName,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'SaaS-Hosting-Stack'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  'Removed.'
  return
}
if (-not $SaasRoot -or -not $Runtime) { throw 'Give -SaasRoot and -Runtime (or -Remove).' }

$infra = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$hosting = Join-Path $infra 'hosting'
$node = (Get-Command node).Source
$tunnel = if ($TunnelName) { "--tunnel named --tunnel-name $TunnelName" } else { '--tunnel none' }

$script = @"
`$ErrorActionPreference = 'Continue'
# Wait for Docker's engine (up to 5 minutes), then the data plane, then the stack.
for (`$i = 0; `$i -lt 60; `$i++) { docker info *> `$null; if (`$LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 5 }
docker compose --env-file '$Runtime\infra.env' -f '$hosting\compose.yml' up -d --wait
& '$node' '$hosting\scripts\stack.mjs' up --saas-root '$SaasRoot' --runtime '$Runtime' --frontends $Frontends $tunnel
"@
$file = Join-Path $Runtime 'start-stack.ps1'
Set-Content -Path $file -Value $script -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$file`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the hosted SaaS stack at sign-in' -Force | Out-Null
"Registered the task '$taskName'. It runs $file at sign-in."
