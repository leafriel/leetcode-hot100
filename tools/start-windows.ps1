param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Start-LocalService {
    param([string]$Script, [int]$Port, [string]$LogName)

    $listener = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) {
        foreach ($connection in $listener) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
            if ($connection.LocalAddress -ne '127.0.0.1' -or
                $owner.Name -ne 'node.exe' -or
                $owner.CommandLine -notmatch [regex]::Escape($Script)) {
                throw "Port $Port is occupied by another application. Close it and try again."
            }
        }
        Write-Host "Already running: http://127.0.0.1:$Port"
        return
    }

    $process = Start-Process -FilePath $node -ArgumentList @($Script, "$Port") `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $projectRoot "$LogName.log") `
        -RedirectStandardError (Join-Path $projectRoot "$LogName-error.log")

    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "Service exited. See $LogName-error.log in $projectRoot"
        }
        $ready = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $process.Id })
        if ($ready.Count -gt 0) {
            Write-Host "Started: http://127.0.0.1:$Port (PID $($process.Id))"
            return
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Service did not become ready. See $LogName-error.log in $projectRoot"
}

try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Start-LocalService 'tools/serve.js' 8931 'server'
    Start-LocalService 'tools/cors-proxy.mjs' 8966 'proxy'

    $page = Invoke-WebRequest 'http://127.0.0.1:8931/' -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'js/app.js') {
        throw 'The web service did not return the expected application.'
    }
    $proxy = Invoke-WebRequest 'http://127.0.0.1:8966/' -Method Options -UseBasicParsing -TimeoutSec 5
    if ($proxy.StatusCode -ne 204 -or $proxy.Headers['Access-Control-Allow-Origin'] -ne '*') {
        throw 'The AI proxy did not pass its health check.'
    }

    Write-Host 'Ready: http://127.0.0.1:8931/ (services keep running in the background).'
    if (-not $NoBrowser) {
        Start-Process 'http://127.0.0.1:8931/'
    }
} catch {
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
