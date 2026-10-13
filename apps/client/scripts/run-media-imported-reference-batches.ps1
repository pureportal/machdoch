param(
    [Parameter(Mandatory)][int]$NativeVerificationProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot,
    [Parameter(Mandatory)][string]$PythonExecutable
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'imported-reference-ssd-queue-status.json'
if (Test-Path -LiteralPath $statusPath) { throw 'The reference queue already exists' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $NativeVerificationProcessId"
if ($null -eq $target -or $null -eq $target.CommandLine -or -not $target.CommandLine.Contains('verify-media-qwen-prepared-packages.ps1')) {
    throw 'The selected native verifier is not running'
}
$probe = Get-Content -LiteralPath (Join-Path $VerificationRoot 'image-group-offload-gpu-probe-desktop.json') -Raw | ConvertFrom-Json
if ($probe.passed -ne $true) { throw 'The selected runtime GPU probe did not pass' }
if (-not (Test-Path -LiteralPath $PythonExecutable)) { throw 'The selected Python executable is missing' }
$status = @{ state = 'waiting'; processId = $PID; nativeProcessId = $NativeVerificationProcessId; python = $PythonExecutable }
$status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
try {
    Wait-Process -Id $NativeVerificationProcessId
    foreach ($file in @('native-package-verification-status.json', 'native-qwen-package-verification-status.json')) {
        $native = Get-Content -LiteralPath (Join-Path $checks $file) -Raw | ConvertFrom-Json
        if ($native.state -ne 'finished' -or @($native.operations | Where-Object { $_.state -ne 'passed' }).Count -gt 0) {
            throw "Native verification is incomplete: $file"
        }
    }
    Set-Location -LiteralPath $workspace
    $scripts = Join-Path $workspace 'apps/client/src-tauri/python'
    $manifest = Join-Path $VerificationRoot 'imported-and-refined-reference-batches.json'
    $status.state = 'preparing'
    $status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
    & $PythonExecutable -B (Join-Path $scripts 'prepare_imported_reference_batches.py') --root $VerificationRoot --model-root $ModelRoot --checks $checks --output $manifest *> (Join-Path $checks 'imported-reference-preparation.log')
    if ($LASTEXITCODE -ne 0) { throw 'Reference request preparation failed' }
    $status.state = 'generating'
    $status.startedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
    & $PythonExecutable -B (Join-Path $scripts 'verify_media_reference_batches.py') --batches $manifest --results (Join-Path $VerificationRoot 'imported-and-refined-reference-results.json') --hip-device 1 *> (Join-Path $checks 'imported-and-refined-reference-runner.log')
    $status.exitCode = $LASTEXITCODE
    $status.state = if ($LASTEXITCODE -eq 0) { 'finished' } else { 'failed' }
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}
