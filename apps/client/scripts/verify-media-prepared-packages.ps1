param(
    [Parameter(Mandatory)][int]$ConversionProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'native-package-verification-status.json'
if (Test-Path -LiteralPath $statusPath) { throw 'Native package verification already exists' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $ConversionProcessId"
if ($null -eq $target -or -not $target.CommandLine.Contains('prepared-flux-2-klein-4b-normalized')) {
    throw 'The selected conversion process is not running'
}
$status = @{ state = 'waiting'; processId = $PID; conversionProcessId = $ConversionProcessId; operations = @() }
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
Wait-Process -Id $ConversionProcessId
Set-Location -LiteralPath (Join-Path $workspace 'apps/client')
$env:TAURI_CONFIG = '{"identifier":"com.machdoch.imageverification.dev","build":{"devUrl":null}}'
$targetDirectory = Join-Path $workspace '.cache/rust'
foreach ($operation in @('test', 'build')) {
    $record = @{ name = $operation; state = 'running'; startedAt = [DateTime]::UtcNow.ToString('o') }
    $status.state = 'running'
    $status.operations += $record
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    $log = Join-Path $checks ("native-qwen-gguf-$operation.log")
    if ($operation -eq 'test') {
        & node scripts/run-cargo.mjs test --manifest-path src-tauri/Cargo.toml --target-dir $targetDirectory --lib media::model_package_import::tests -- --test-threads=1 *> $log
    } else {
        & node scripts/run-cargo.mjs build --manifest-path src-tauri/Cargo.toml --target-dir $targetDirectory --bin machdoch *> $log
    }
    $record.exitCode = $LASTEXITCODE
    $record.state = if ($LASTEXITCODE -eq 0) { 'passed' } else { 'failed' }
    $record.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Native $operation failed; inspect $log" }
}
$env:MACHDOCH_IMAGE_MODEL_STORE = $ModelRoot
$testBinary = Join-Path $targetDirectory 'debug/deps/machdoch_lib-e83b0fc15a4f2ae0.exe'
if (-not (Test-Path -LiteralPath $testBinary)) { throw 'The expected native test executable is missing' }
foreach ($architecture in @('stable-diffusion-2', 'flux-2', 'flux-2-klein-base-4b', 'flux-1-schnell')) {
    $request = Join-Path $VerificationRoot ($architecture + '-import-request.json')
    $source = (Get-Content -LiteralPath $request -Raw | ConvertFrom-Json).sourcePath
    if (-not (Test-Path -LiteralPath (Join-Path $source 'provenance.json'))) {
        throw "Package conversion is incomplete: $architecture"
    }
    $record = @{ name = $architecture; state = 'running'; startedAt = [DateTime]::UtcNow.ToString('o') }
    $status.operations += $record
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    $env:MACHDOCH_IMAGE_MODEL_IMPORT_REQUEST = $request
    $log = Join-Path $checks ($architecture + '-native-import-current.log')
    & $testBinary media::model_package_import::tests::external_image_model_package_import --exact --ignored --nocapture *> $log
    $record.exitCode = $LASTEXITCODE
    $record.state = if ($LASTEXITCODE -eq 0) { 'passed' } else { 'failed' }
    $record.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Native import failed: $architecture" }
}
$status.state = 'finished'
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
