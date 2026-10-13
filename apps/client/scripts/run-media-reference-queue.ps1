param(
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot,
    [Parameter(Mandatory)][string]$BatchesPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'reference-queue-current-status.json'
if (-not (Test-Path -LiteralPath $PythonExecutable) -or -not (Test-Path -LiteralPath $BatchesPath)) {
    throw 'The queue requires its Python runtime and batch manifest'
}
$resolvedVerificationRoot = (Resolve-Path -LiteralPath $VerificationRoot).Path
$resolvedModelRoot = (Resolve-Path -LiteralPath $ModelRoot).Path
$resolvedManifest = (Resolve-Path -LiteralPath $BatchesPath).Path
$activeBatches = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object {
    $_.CommandLine -match 'verify_media_reference_(batches|sweep)\.py' -and
    $_.CommandLine.Replace('/', '\').IndexOf($resolvedVerificationRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeBatches.Count -gt 0) { throw 'A reference generation is already running' }
$queueLock = [System.IO.File]::Open((Join-Path $checks 'reference-queue.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$status = @{
    processId = $PID
    manifest = $resolvedManifest
    verificationRoot = $resolvedVerificationRoot
    modelRoot = $resolvedModelRoot
    state = 'generating'
    startedAt = [DateTime]::UtcNow.ToString('o')
    operations = @()
}
function Save-QueueStatus {
    $temporaryStatus = "$statusPath.$PID.tmp"
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryStatus -Encoding utf8
    Move-Item -LiteralPath $temporaryStatus -Destination $statusPath -Force
}
try {
    Set-Location -LiteralPath $workspace
    $env:PYTHONUTF8 = '1'
    Save-QueueStatus
    $generationArguments = @('-B', (Join-Path $workspace 'apps/client/src-tauri/python/verify_media_reference_batches.py'), '--batches', $BatchesPath, '--results', (Join-Path $VerificationRoot 'reference-queue-current-results.json'), '--hip-device', '1')
    & $PythonExecutable @generationArguments 1> (Join-Path $checks 'reference-queue-current.stdout.log') 2> (Join-Path $checks 'reference-queue-current.stderr.log')
    $status.generationExitCode = $LASTEXITCODE
    $status.state = 'checking'
    Save-QueueStatus
    $gallery = Join-Path $workspace 'docs/validation/image-engines/comparison'
    $operations = @(
        @{ script = 'build-media-image-comparisons.mjs'; arguments = @($VerificationRoot, $gallery) },
        @{ script = 'audit-media-image-verification.mjs'; arguments = @($VerificationRoot, (Join-Path $checks 'reference-queue-current'), $ModelRoot) },
        @{ script = 'verify-media-image-comparisons.mjs'; arguments = @($gallery) }
    )
    foreach ($operation in $operations) {
        $operationArguments = @((Join-Path $PSScriptRoot $operation.script)) + $operation.arguments
        & (Get-Command node.exe).Source @operationArguments 1> (Join-Path $checks ($operation.script + '-queue-current.stdout.log')) 2> (Join-Path $checks ($operation.script + '-queue-current.stderr.log'))
        $verificationExitCode = $LASTEXITCODE
        $status.operations += @{ script = $operation.script; exitCode = $verificationExitCode }
        Save-QueueStatus
        if ($verificationExitCode -ne 0) { throw "Reference evidence check failed: $($operation.script)" }
    }
    if ($status.generationExitCode -ne 0) { throw 'Reference generation failed; inspect reference-queue-current logs' }
    $status.state = 'finished'
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    try { Save-QueueStatus } finally { $queueLock.Dispose() }
}
