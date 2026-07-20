param(
  [switch]$ValidateOnly,
  [switch]$RebuildOnce,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$UvGraphify = Join-Path $HOME ".local\bin\graphify.exe"

function Resolve-Graphify {
  if (Test-Path -LiteralPath $UvGraphify) {
    return (Resolve-Path -LiteralPath $UvGraphify).Path
  }

  $cmd = Get-Command graphify -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "graphify not found. Install with: uv tool install `"graphifyy[all]`""
  }
  return $cmd.Source
}

function Assert-DevToolGraphify {
  param([string]$GraphifyPath)

  $repo = $RepoRoot.Path
  $forbidden = @(
    (Join-Path $repo ".venv-nuitka-build"),
    (Join-Path $repo "python_embedded")
  )

  foreach ($prefix in $forbidden) {
    if ($GraphifyPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to run Graphify from EasyCris Python environment: $GraphifyPath"
    }
  }
}

function Update-GraphifyStalenessDate {
  $report = Join-Path $RepoRoot.Path "graphify-out\GRAPH_REPORT.md"
  if (-not (Test-Path -LiteralPath $report)) {
    return
  }

  $firstLine = Get-Content -LiteralPath $report -TotalCount 1
  $match = [regex]::Match($firstLine, "\((\d{4}-\d{2}-\d{2})\)")
  if (-not $match.Success) {
    return
  }

  $date = $match.Groups[1].Value
  foreach ($fileName in @("CLAUDE.md", "AGENTS.md")) {
    $path = Join-Path $RepoRoot.Path $fileName
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $content = Get-Content -LiteralPath $path -Raw
    $updated = [regex]::Replace($content, '--after="\d{4}-\d{2}-\d{2}"', "--after=`"$date`"")
    if ($updated -ne $content) {
      Set-Content -LiteralPath $path -Value $updated -Encoding UTF8
    }
  }
}

function Remove-StaleGraphifyWiki {
  $wiki = Join-Path $RepoRoot.Path "graphify-out\wiki"
  if (-not (Test-Path -LiteralPath $wiki)) {
    return
  }

  $graphifyOut = Join-Path $RepoRoot.Path "graphify-out"
  if (-not (Test-Path -LiteralPath $graphifyOut)) {
    return
  }

  $resolvedWiki = (Resolve-Path -LiteralPath $wiki).Path
  $resolvedOut = (Resolve-Path -LiteralPath $graphifyOut).Path
  $expectedPrefix = $resolvedOut.TrimEnd([char]"\", [char]"/") + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedWiki.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove wiki outside graphify-out: $resolvedWiki"
  }

  Remove-Item -LiteralPath $resolvedWiki -Recurse -Force
  Write-Host "Removed stale graphify-out/wiki; regenerate it with a full semantic Graphify run when named wiki pages are needed."
}

function Test-GraphifyAnchorNoise {
  param(
    [string]$Label,
    [string]$SourceFile
  )

  $patterns = @(
    '^cn\(\)$',
    '^log(Step|Success|Warning|Error|Info)\(\)$',
    '^setupTest\(\)$',
    '^cleanupTest\(\)$',
    '^verifyCleanState\(\)$',
    '^waitForResults\(\)$',
    '^switchTo.*Tab\(\)$',
    '^\.new\(\)$'
  )

  foreach ($pattern in $patterns) {
    if ($Label -match $pattern) {
      return $true
    }
  }

  return $false
}

function Test-GraphifyE2EAnchor {
  param([string]$SourceFile)

  return $SourceFile -match '^(e2e|tests/e2e|src/e2e)[\\/]'
}

function Get-GraphifyDisplayLabel {
  param(
    [string]$Label,
    [string]$SourceFile,
    [hashtable]$LabelCounts
  )

  if (-not $LabelCounts.ContainsKey($Label) -or $LabelCounts[$Label] -le 1) {
    return $Label
  }

  $parts = $SourceFile -split '[\\/]'
  if ($parts.Count -ge 2) {
    return "{0} ({1})" -f $Label, $parts[$parts.Count - 2]
  }

  return $Label
}

function Update-GraphifyAnchorIndex {
  $graph = Join-Path $RepoRoot.Path "graphify-out\graph.json"
  $report = Join-Path $RepoRoot.Path "graphify-out\GRAPH_REPORT.md"
  $anchors = Join-Path $RepoRoot.Path "graphify-out\ANCHORS.md"
  if (-not (Test-Path -LiteralPath $graph) -or -not (Test-Path -LiteralPath $report)) {
    return
  }

  $data = Get-Content -LiteralPath $graph -Raw | ConvertFrom-Json
  if (-not $data.nodes -or -not $data.links) {
    Write-Warning "graph.json missing expected fields; skipping anchor generation"
    return
  }

  $nodeInfo = @{}
  $degree = @{}
  $bridgeDegree = @{}
  foreach ($node in $data.nodes) {
    $id = [string]$node.id
    $nodeInfo[$id] = $node
    $degree[$id] = 0
    $bridgeDegree[$id] = 0
  }

  foreach ($edge in $data.links) {
    $source = [string]$edge.source
    $target = [string]$edge.target
    if (-not $nodeInfo.ContainsKey($source) -or -not $nodeInfo.ContainsKey($target)) {
      continue
    }

    $degree[$source] += 1
    $degree[$target] += 1

    $sourceCommunity = [string]$nodeInfo[$source].community
    $targetCommunity = [string]$nodeInfo[$target].community
    if ($sourceCommunity -ne $targetCommunity) {
      $bridgeDegree[$source] += 1
      $bridgeDegree[$target] += 1
    }
  }

  $anchorRows = foreach ($id in $nodeInfo.Keys) {
    $node = $nodeInfo[$id]
    $label = [string]$node.label
    $sourceFile = [string]$node.source_file
    if (-not $sourceFile -and $node.PSObject.Properties.Name -contains "file") {
      $sourceFile = [string]$node.file
    }
    if (Test-GraphifyAnchorNoise -Label $label -SourceFile $sourceFile) {
      continue
    }

    [PSCustomObject]@{
      Label = $label
      SourceFile = $sourceFile
      Degree = [int]$degree[$id]
      BridgeDegree = [int]$bridgeDegree[$id]
      IsE2E = Test-GraphifyE2EAnchor -SourceFile $sourceFile
    }
  }
  $anchorRows = $anchorRows | Group-Object -Property Label, SourceFile | ForEach-Object {
    $_.Group | Sort-Object @{e='Degree';d=$true}, @{e='BridgeDegree';d=$true}, @{e='Label';d=$false} | Select-Object -First 1
  }

  $labelCounts = @{}
  foreach ($anchor in $anchorRows) {
    if (-not $labelCounts.ContainsKey($anchor.Label)) {
      $labelCounts[$anchor.Label] = 0
    }
    $labelCounts[$anchor.Label] += 1
  }

  foreach ($anchor in $anchorRows) {
    $anchor | Add-Member -NotePropertyName DisplayLabel -NotePropertyValue (Get-GraphifyDisplayLabel -Label $anchor.Label -SourceFile $anchor.SourceFile -LabelCounts $labelCounts)
  }

  $appAnchors = $anchorRows | Where-Object { -not $_.IsE2E }
  $e2eAnchors = $anchorRows | Where-Object { $_.IsE2E }

  $coreAnchors = $appAnchors | Sort-Object @{e='Degree';d=$true}, @{e='BridgeDegree';d=$true}, @{e='Label';d=$false} | Select-Object -First 20
  $bridgeAnchors = $appAnchors | Where-Object { $_.BridgeDegree -gt 0 } | Sort-Object @{e='BridgeDegree';d=$true}, @{e='Degree';d=$true}, @{e='Label';d=$false} | Select-Object -First 20
  $e2eAnchors = $e2eAnchors | Sort-Object @{e='Degree';d=$true}, @{e='BridgeDegree';d=$true}, @{e='Label';d=$false} | Select-Object -First 15

  $reportFirstLine = Get-Content -LiteralPath $report -TotalCount 1
  $summaryLine = (Select-String -Path $report -Pattern '^- \d+ nodes .+ communities' | Select-Object -First 1).Line
  $commit = [string]$data.built_at_commit
  if (-not $commit) {
    $commit = "unknown"
  }

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# Graphify Anchors")
  $lines.Add("")
  $lines.Add("Source: $reportFirstLine")
  $lines.Add("Built from commit: ``$commit``")
  if ($summaryLine) {
    $lines.Add($summaryLine)
  }
  $lines.Add("")
  $lines.Add('Use this file as the stable starting point for agent navigation. Anchor on exact node labels, source files, total degree, and cross-community bridge degree. Do not anchor memory on `Community N` IDs or LLM-generated community names; those are clustering snapshots and can drift after rebuilds.')
  $lines.Add("")
  $lines.Add("## Core Anchors")
  $lines.Add("")
  foreach ($anchor in $coreAnchors) {
    $lines.Add(('- `{0}` - degree {1}, bridge degree {2}, source: {3}' -f $anchor.DisplayLabel, $anchor.Degree, $anchor.BridgeDegree, $anchor.SourceFile))
  }
  $lines.Add("")
  $lines.Add("## Bridge Anchors")
  $lines.Add("")
  foreach ($anchor in $bridgeAnchors) {
    $lines.Add(('- `{0}` - bridge degree {1}, degree {2}, source: {3}' -f $anchor.DisplayLabel, $anchor.BridgeDegree, $anchor.Degree, $anchor.SourceFile))
  }
  $lines.Add("")
  $lines.Add("## E2E Anchors")
  $lines.Add("")
  foreach ($anchor in $e2eAnchors) {
    $lines.Add(('- `{0}` - degree {1}, bridge degree {2}, source: {3}' -f $anchor.DisplayLabel, $anchor.Degree, $anchor.BridgeDegree, $anchor.SourceFile))
  }
  $lines.Add("")
  $lines.Add("## Navigation Rules")
  $lines.Add("")
  $lines.Add('- Start with anchors, then inspect neighbors in graphify-out/graph.json or use targeted `rg` for changed areas.')
  $lines.Add('- Mention community IDs only as current clustering context, never as durable names.')
  $lines.Add('- Treat wiki/community names as a dated reviewer snapshot unless their counts match GRAPH_REPORT.md.')

  Set-Content -LiteralPath $anchors -Value $lines -Encoding UTF8
  Write-Host "Updated graphify-out/ANCHORS.md"
}

function Invoke-GraphifyPostUpdate {
  Remove-StaleGraphifyWiki
  Update-GraphifyStalenessDate
  Update-GraphifyAnchorIndex
}

function Get-GraphifyOutputStamp {
  $paths = @(
    (Join-Path $RepoRoot.Path "graphify-out\graph.json"),
    (Join-Path $RepoRoot.Path "graphify-out\GRAPH_REPORT.md")
  )

  $ticks = 0
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path
      if ($item.LastWriteTimeUtc.Ticks -gt $ticks) {
        $ticks = $item.LastWriteTimeUtc.Ticks
      }
    }
  }
  return $ticks
}

function Start-GraphifyWatchWithAnchors {
  $lastStamp = Get-GraphifyOutputStamp
  $process = Start-Process -FilePath $Graphify -ArgumentList @("watch", ".") -NoNewWindow -PassThru

  try {
    while (-not $process.HasExited) {
      Start-Sleep -Seconds 2
      $stamp = Get-GraphifyOutputStamp
      if ($stamp -ne 0 -and $stamp -ne $lastStamp) {
        Start-Sleep -Milliseconds 500
        $stableStamp = Get-GraphifyOutputStamp
        if ($stableStamp -ne 0 -and $stableStamp -eq $stamp) {
          Invoke-GraphifyPostUpdate
          $lastStamp = $stableStamp
        }
      }
    }
    exit $process.ExitCode
  }
  finally {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id
    }
  }
}

$Graphify = Resolve-Graphify
Assert-DevToolGraphify -GraphifyPath $Graphify

if ($ValidateOnly) {
  Write-Host "graphify: $Graphify"
  & $Graphify --version
  exit $LASTEXITCODE
}

Push-Location $RepoRoot
try {
  if ($RebuildOnce) {
    $args = @("update", ".")
    if ($Force) {
      $args += "--force"
    }
    & $Graphify @args
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
    Invoke-GraphifyPostUpdate
    exit 0
  }

  Start-GraphifyWatchWithAnchors
}
finally {
  Pop-Location
}
