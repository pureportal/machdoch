param(
    [Parameter(Mandatory)][int]$NativeVerificationProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'native-qwen-package-verification-status.json'
if (Test-Path -LiteralPath $statusPath) { throw 'Qwen package verification already exists' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $NativeVerificationProcessId"
if ($null -eq $target -or $null -eq $target.CommandLine -or -not $target.CommandLine.Contains('verify-media-prepared-packages.ps1')) {
    throw 'The selected native verification process is not running'
}
$status = @{ state = 'waiting'; processId = $PID; nativeVerificationProcessId = $NativeVerificationProcessId; operations = @() }
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
Wait-Process -Id $NativeVerificationProcessId
$nativeStatus = Get-Content -LiteralPath (Join-Path $checks 'native-package-verification-status.json') -Raw | ConvertFrom-Json
foreach ($operation in @('test', 'build')) {
    if (@($nativeStatus.operations | Where-Object { $_.name -eq $operation -and $_.state -eq 'passed' }).Count -ne 1) {
        throw "Native $operation did not pass"
    }
}
$env:MACHDOCH_IMAGE_MODEL_STORE = $ModelRoot
$testBinary = Join-Path $workspace '.cache/rust/debug/deps/machdoch_lib-e83b0fc15a4f2ae0.exe'
if (-not (Test-Path -LiteralPath $testBinary)) { throw 'The expected native test executable is missing' }
foreach ($architecture in @('qwen-image', 'qwen-image-2512')) {
    $request = Join-Path $VerificationRoot ($architecture + '-import-request.json')
    $source = (Get-Content -LiteralPath $request -Raw | ConvertFrom-Json).sourcePath
    if (-not (Test-Path -LiteralPath (Join-Path $source 'source-manifest.json'))) {
        throw "Package preparation is incomplete: $architecture"
    }
    $record = @{ name = $architecture; state = 'running'; startedAt = [DateTime]::UtcNow.ToString('o') }
    $status.state = 'running'
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
