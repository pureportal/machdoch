param(
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'reverified-package-import-status-2026-10-12-retry.json'
if (Test-Path -LiteralPath $statusPath) { throw 'A resumed import record already exists' }
$status = @{ processId = $PID; state = 'starting'; operations = @() }
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
$env:MACHDOCH_IMAGE_MODEL_STORE = $ModelRoot
$testBinary = Join-Path $workspace '.cache/rust/debug/deps/machdoch_lib-e83b0fc15a4f2ae0.exe'
if (-not (Test-Path -LiteralPath $testBinary)) { throw 'The native verification executable is missing' }
try {
    foreach ($architecture in @('flux-1-schnell', 'qwen-image', 'qwen-image-2512')) {
        $requestPath = Join-Path $VerificationRoot ($architecture + '-import-request.json')
        $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
        if (-not (Test-Path -LiteralPath (Join-Path $request.sourcePath 'model_index.json'))) {
            throw "Package preparation is incomplete: $architecture"
        }
        $env:MACHDOCH_IMAGE_MODEL_IMPORT_REQUEST = $requestPath
        $record = @{ name = $architecture; state = 'running'; startedAt = [DateTime]::UtcNow.ToString('o') }
        $status.state = 'running'
        $status.operations += $record
        $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
        if ($architecture -eq 'flux-1-schnell') {
            Copy-Item -LiteralPath (Join-Path $checks 'flux-1-schnell-native-import-current.log') -Destination (Join-Path $checks 'flux-1-schnell-interrupted-parent-import.log') -ErrorAction Stop
        }
        & $testBinary media::model_package_import::tests::external_image_model_package_import --exact --ignored --nocapture *> (Join-Path $checks ($architecture + '-native-import-current.log'))
        $record.exitCode = $LASTEXITCODE
        $record.state = if ($LASTEXITCODE -eq 0) { 'passed' } else { 'failed' }
        $record.finishedAt = [DateTime]::UtcNow.ToString('o')
        $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw "Native import failed: $architecture" }
    }
    $status.state = 'finished'
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
