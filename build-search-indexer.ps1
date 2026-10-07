# build-search-indexer.ps1  (run from the gig-dashboard folder)
#
# Bundles lambda/search-indexer/index.ts and the website code it uses into one
# file, zips it, and checks the zip really contains the fresh build.
# Absolute paths throughout: relative paths with Compress-Archive have written
# zips to the wrong place before.

$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$out  = Join-Path $root 'build\search-indexer'
$zip  = Join-Path $root 'build\search-indexer.zip'

if (-not (Test-Path (Join-Path $root 'lambda\search-indexer\index.ts'))) {
  throw "Run this from the gig-dashboard folder (lambda\search-indexer\index.ts not found)."
}
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $out | Out-Null

# The AWS SDK is already inside the Lambda Node.js runtime, so it is left out.
# Each option is built as one complete string first: writing --x=(Join-Path ...)
# inline makes PowerShell pass "--x=" and the path as two separate arguments.
$entry      = Join-Path $root 'lambda\search-indexer\index.ts'
$tsconfigArg = "--tsconfig=$(Join-Path $root 'tsconfig.json')"
$outfileArg  = "--outfile=$(Join-Path $out 'index.js')"
$esbuildArgs = @($entry, '--bundle', '--platform=node', '--target=node22', '--format=cjs',
                 '--external:@aws-sdk/*', $tsconfigArg, $outfileArg)
npx --yes esbuild@0.24.0 @esbuildArgs
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

Compress-Archive -Path (Join-Path $out 'index.js') -DestinationPath $zip -Force

# Verify: the zip exists, holds index.js, and that file contains the handler.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entry = $z.Entries | Where-Object { $_.FullName -eq 'index.js' }
  if (-not $entry) { throw "index.js missing from zip" }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  $text = $reader.ReadToEnd(); $reader.Close()
  if ($text -notmatch 'search-indexer' -or $text -notmatch 'warmMaster') { throw "zip does not contain the expected handler" }
} finally { $z.Dispose() }

$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Built $zip ($size MB). Upload it in the Lambda console for search-indexer."