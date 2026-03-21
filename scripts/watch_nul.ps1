param(
    [string]$WatchPath = "C:\Users\RajLord_new\Desktop\tauri\python_embedded",
    [string]$LogPath = "C:\Users\RajLord_new\Desktop\tauri\nul-watch.log"
)

$ErrorActionPreference = "Stop"

Write-Host "Watching for creation of 'nul' under: $WatchPath"
Write-Host "Logging to: $LogPath"
Write-Host "Press Ctrl+C to stop."

if (-not (Test-Path $WatchPath)) {
    Write-Error "WatchPath not found: $WatchPath"
    exit 1
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $WatchPath
$watcher.Filter = "*"
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

$log = {
    param($eventType, $fullPath)
    $ts = (Get-Date).ToString("s")
    $line = "$ts [$eventType] $fullPath"
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

Register-ObjectEvent $watcher Created -Action {
    $fullPath = $Event.SourceEventArgs.FullPath
    if ([System.IO.Path]::GetFileName($fullPath).ToLowerInvariant() -eq "nul") {
        & $using:log "CREATED" $fullPath
    }
} | Out-Null

Register-ObjectEvent $watcher Renamed -Action {
    $fullPath = $Event.SourceEventArgs.FullPath
    if ([System.IO.Path]::GetFileName($fullPath).ToLowerInvariant() -eq "nul") {
        & $using:log "RENAMED" $fullPath
    }
} | Out-Null

Register-ObjectEvent $watcher Changed -Action {
    $fullPath = $Event.SourceEventArgs.FullPath
    if ([System.IO.Path]::GetFileName($fullPath).ToLowerInvariant() -eq "nul") {
        & $using:log "CHANGED" $fullPath
    }
} | Out-Null

while ($true) { Start-Sleep -Seconds 1 }
