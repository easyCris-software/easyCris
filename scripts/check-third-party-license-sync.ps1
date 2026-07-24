param(
  [string]$CanonicalPath = "src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt",
  [string]$MirrorPath = "legal/THIRD_PARTY_LICENSES.txt",
  [string]$OtherArtifactPath = "legal/other-components.json",
  [string]$NpmArtifactPath = "runtime-licenses-js.json",
  [string]$RustArtifactPath = "runtime-licenses-rust.json",
  [string]$PythonArtifactPath = "legal/python-licenses.json"
)

$sourceOfTruthPath = "legal/source-of-truth.json"
if (Test-Path -LiteralPath $sourceOfTruthPath) {
  try {
    $sourceOfTruth = Get-Content -LiteralPath $sourceOfTruthPath -Raw | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('CanonicalPath') -and $sourceOfTruth.notice.canonical) {
      $CanonicalPath = [string]$sourceOfTruth.notice.canonical
    }
    if (-not $PSBoundParameters.ContainsKey('MirrorPath') -and $sourceOfTruth.notice.mirror) {
      $MirrorPath = [string]$sourceOfTruth.notice.mirror
    }
    if (-not $PSBoundParameters.ContainsKey('OtherArtifactPath') -and $sourceOfTruth.artifacts.other) {
      $OtherArtifactPath = [string]$sourceOfTruth.artifacts.other
    }
    if (-not $PSBoundParameters.ContainsKey('NpmArtifactPath') -and $sourceOfTruth.artifacts.npm) {
      $NpmArtifactPath = [string]$sourceOfTruth.artifacts.npm
    }
    if (-not $PSBoundParameters.ContainsKey('RustArtifactPath') -and $sourceOfTruth.artifacts.rust) {
      $RustArtifactPath = [string]$sourceOfTruth.artifacts.rust
    }
    if (-not $PSBoundParameters.ContainsKey('PythonArtifactPath') -and $sourceOfTruth.artifacts.python) {
      $PythonArtifactPath = [string]$sourceOfTruth.artifacts.python
    }
  } catch {
    Write-Error "Failed to parse source-of-truth config at $sourceOfTruthPath"
    exit 1
  }
}

function Normalize-Text {
  param([string]$Text)
  # Collapse malformed CRCRLF first, then normalize all line endings to LF.
  $normalized = $Text -replace "`r+`n", "`n"
  $normalized = $normalized -replace "`r", "`n"
  return $normalized.TrimEnd("`n")
}

if (-not (Test-Path -LiteralPath $CanonicalPath)) {
  Write-Error "Canonical file missing: $CanonicalPath"
  exit 1
}

if (-not (Test-Path -LiteralPath $MirrorPath)) {
  Write-Error "Mirror file missing: $MirrorPath"
  exit 1
}

if (-not (Test-Path -LiteralPath $OtherArtifactPath)) {
  Write-Error "Other components artifact missing: $OtherArtifactPath"
  exit 1
}

foreach ($artifactPath in @($NpmArtifactPath, $RustArtifactPath, $PythonArtifactPath, $OtherArtifactPath)) {
  if (-not (Test-Path -LiteralPath $artifactPath)) {
    Write-Error "License inventory artifact missing: $artifactPath"
    exit 1
  }
  $artifactContent = Get-Content -LiteralPath $artifactPath -Raw
  if ($artifactContent -match '(?i)[A-Z]:(?:\\\\|\\)Users(?:\\\\|\\)|/Users/') {
    Write-Error "License inventory contains a machine-specific user path: $artifactPath"
    exit 1
  }
}

$canonical = Normalize-Text -Text (Get-Content -LiteralPath $CanonicalPath -Raw)
$mirror = Normalize-Text -Text (Get-Content -LiteralPath $MirrorPath -Raw)
$otherArtifact = Get-Content -LiteralPath $OtherArtifactPath -Raw | ConvertFrom-Json

if ($canonical -ne $mirror) {
  Write-Error "Third-party license bundles are out of sync:`n  Canonical: $CanonicalPath`n  Mirror:    $MirrorPath"
  exit 1
}

$lines = $canonical -split "`n"

if ($canonical.Contains('C:\Users\')) {
  Write-Error "Third-party license bundle contains blocked noise token (machine-specific absolute Windows path)."
  exit 1
}
if ($canonical.Contains('/Users/')) {
  Write-Error "Third-party license bundle contains blocked noise token (machine-specific absolute macOS path)."
  exit 1
}

$legacyMarkers = @(
  'JavaScript Runtime Dependencies (NPM)',
  'Rust Crate Notices (Cargo)',
  'Python Package Licenses Summary'
)

function Is-SpdxNoiseLine {
  param([string]$Line)
  $trimmed = $Line.Trim()
  if ($trimmed -eq '') { return $false }
  return $trimmed -match '^(SPDXVersion|DataLicense|DataFormat|SPDXID|DocumentName|DocumentNamespace|Relationship|Package(Name|Supplier|HomePage|LicenseDeclared|CopyrightText|Summary|Comment|DownloadLocation|Version|VerificationCode|LicenseConcluded|LicenseInfoFromFiles|LicenseComments|FilesAnalyzed)|File(Name|Checksum|Type|LicenseConcluded|CopyrightText)|License(ID|Name|CrossReference|Comment)|ExtractedText):\s*'
}

function Is-PackageHeaderLine {
  param(
    [string]$Current,
    [string]$Next
  )
  $trimmed = $Current.Trim()
  $nextTrimmed = $Next.Trim()
  if ($trimmed -eq '' -or $trimmed.Contains(':')) { return $false }
  if ($nextTrimmed -notmatch '^-{3,}$') { return $false }
  if ($trimmed -match '^[^:]+@[^\\\s]+$') { return $true }
  if ($trimmed -match '^[A-Za-z0-9_.+-]+(?:-[A-Za-z0-9_.+-]+)*\s+\d[\w.+-]*$') { return $true }
  return $false
}

for ($i = 0; $i -lt $lines.Length; $i++) {
  $trimmed = $lines[$i].Trim()
  if ($legacyMarkers -contains $trimmed) {
    Write-Error "Third-party license bundle contains blocked noise token (legacy inventory marker): $trimmed"
    exit 1
  }
  if (Is-SpdxNoiseLine -Line $trimmed) {
    Write-Error "Third-party license bundle contains blocked noise token (raw SPDX metadata noise): $trimmed"
    exit 1
  }
}

$jsSectionStart = [Array]::IndexOf($lines, 'JavaScript Runtime License Texts (NPM)')

if ($jsSectionStart -ge 0) {
  $inPackageSection = $false
  for ($i = $jsSectionStart + 1; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    $trimmed = $line.Trim()
    if ($trimmed -eq '') { continue }

    $next = ''
    if ($i + 1 -lt $lines.Length) { $next = $lines[$i + 1].Trim() }
    if (Is-PackageHeaderLine -Current $trimmed -Next $next) {
      $inPackageSection = $true
      continue
    }

    if (-not $inPackageSection) { continue }

    if ($trimmed -match '^License file:\s*node_modules\\') {
      Write-Error "Third-party license bundle contains package-block noise (node_modules license path): $trimmed"
      exit 1
    }
    if ($trimmed -match '^Repository:\s*https?://') {
      Write-Error "Third-party license bundle contains package-block noise (repository line): $trimmed"
      exit 1
    }
    if ($trimmed -match '^```') {
      Write-Error "Third-party license bundle contains fenced code block inside a package section."
      exit 1
    }
    if ($trimmed -match '^#{1,6}\s+' -or $trimmed -match '^\[!\[') {
      Write-Error "Third-party license bundle contains markdown artifact inside a package section: $trimmed"
      exit 1
    }
    if ($trimmed -match '</?legalese>') {
      Write-Error "Third-party license bundle contains HTML/README artifact inside a package section: $trimmed"
      exit 1
    }
    if ($trimmed -match '^module\.exports\b' -or $trimmed -match '^(var|let|const)\s+\w+\s*=.*require\(') {
      Write-Error "Third-party license bundle contains code artifact inside a package section: $trimmed"
      exit 1
    }
  }
}

$requiredOtherTitles = @()
if ($otherArtifact.licenseTexts) {
  foreach ($entry in $otherArtifact.licenseTexts) {
    $title = [string]$entry.title
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    $required = $true
    if ($null -ne $entry.required) {
      $required = [bool]$entry.required
    }
    if ($required) {
      $requiredOtherTitles += $title.Trim()
    }
  }
}

if ($requiredOtherTitles.Count -gt 0) {
  if ($lines -notcontains 'Other License Texts') {
    Write-Error "Third-party license bundle is missing required 'Other License Texts' section."
    exit 1
  }

  foreach ($title in $requiredOtherTitles) {
    if ($lines -notcontains $title) {
      Write-Error "Third-party license bundle is missing required other-license text title: $title"
      exit 1
    }
  }
}

Write-Host "Third-party license bundles are in sync."
