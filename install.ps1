# module-graph-mcp installer — Windows (PowerShell)
#
#   irm https://raw.githubusercontent.com/eren11qq/module-graph-mcp/main/install.ps1 | iex
#
# Clones (or updates) the repo into $HOME\.module-graph-mcp, builds it, and puts a
# `module-graph` command on your user PATH. No admin rights required.

$ErrorActionPreference = "Stop"

$RepoUrl   = if ($env:MODULE_GRAPH_REPO) { $env:MODULE_GRAPH_REPO } else { "https://github.com/eren11qq/module-graph-mcp.git" }
$InstallDir = if ($env:MODULE_GRAPH_HOME) { $env:MODULE_GRAPH_HOME } else { Join-Path $HOME ".module-graph-mcp" }
$BinDir     = if ($env:MODULE_GRAPH_BIN_DIR) { $env:MODULE_GRAPH_BIN_DIR } else { Join-Path $HOME ".local\bin" }

function Say([string]$msg) { Write-Host "[module-graph] $msg" }

foreach ($cmd in @("git", "node", "npm")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd is required but not found on PATH."
  }
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "node >= 20 required (found $(node --version))." }

if (Test-Path (Join-Path $InstallDir ".git")) {
  Say "updating existing install at $InstallDir"
  git -C $InstallDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "git pull failed." }
} else {
  Say "cloning $RepoUrl -> $InstallDir"
  git clone $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
}

Push-Location $InstallDir
try {
  Say "installing dependencies (devDeps included - needed for the build)"
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

  Say "building server + dashboard"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
} finally {
  Pop-Location
}

Say "creating 'module-graph' command at $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$server = Join-Path $InstallDir "dist\server\index.js"

# The .cmd wrapper must survive non-ASCII install paths (e.g. a Chinese user
# profile name). "-Encoding Ascii" would mangle them into "??" and the command
# would die with MODULE_NOT_FOUND. Two layers of defense:
#  1. If the server lives under $HOME, reference it via %USERPROFILE% so the
#     file content is pure ASCII (cmd.exe resolves the profile name at runtime).
#  2. Otherwise write the literal path using the system OEM code page, which is
#     what cmd.exe uses to read batch files.
$homeNorm = $HOME.TrimEnd('\')
$serverNorm = $server.TrimEnd('\')
$serverLine = $null
if ($serverNorm.StartsWith($homeNorm + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
  $rel = $serverNorm.Substring($homeNorm.Length + 1)
  if ($rel -cmatch '^[\x00-\x7F]*$') {
    $serverLine = "node `"%USERPROFILE%\$rel`" %*"
  }
}
if (-not $serverLine) {
  $oemCp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage').OEMCP
  $oem = [System.Text.Encoding]::GetEncoding($oemCp)
  [System.IO.File]::WriteAllLines((Join-Path $BinDir "module-graph.cmd"), @("@echo off", "node `"$server`" %*"), $oem)
} else {
  Set-Content -Path (Join-Path $BinDir "module-graph.cmd") -Encoding Ascii -Value @("@echo off", $serverLine)
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  Say "added $BinDir to your user PATH (open a new terminal to pick it up)"
}
if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

Say "done. try it on the bundled demo app:"
Say "  module-graph --root `"$InstallDir\test-fixtures\sample-app`" --open"
Say ""
Say "register as an MCP server (absolute paths):"
Say "  claude mcp add module-graph -- node `"$server`" --root C:\path\to\your-project"
Say ""
Say "to upgrade later: rerun the same irm one-liner."
Say "to uninstall: remove $BinDir\module-graph.cmd and $InstallDir"
