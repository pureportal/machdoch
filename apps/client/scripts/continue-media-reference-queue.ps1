param(
    [Parameter(Mandatory)][int]$PrecedingProcessId,
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot,
    [Parameter(Mandatory)][string]$BatchesPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$workspace = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$checks = Join-Path $workspace 'docs/validation/image-engines/current-checks'
$statusPath = Join-Path $checks 'reference-queue-next-status.json'
$preceding = Get-CimInstance Win32_Process -Filter "ProcessId = $PrecedingProcessId"
if ($null -eq $preceding -or $preceding.Name -ne 'pwsh.exe' -or
    $preceding.CommandLine -notmatch 'run-media-reference-queue\.ps1') {
    throw 'The preceding reference queue is not running'
}
foreach ($path in @($PythonExecutable, $VerificationRoot, $ModelRoot, $BatchesPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "The continuation path is missing: $path" }
}
$status = @{
    processId = $PID
    precedingProcessId = $PrecedingProcessId
    manifest = (Resolve-Path -LiteralPath $BatchesPath).Path
    state = 'waiting'
    startedAt = [DateTime]::UtcNow.ToString('o')
}
function Save-ContinuationStatus {
    $temporary = "$statusPath.$PID.tmp"
    $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
try {
    Save-ContinuationStatus
    Wait-Process -Id $PrecedingProcessId
    $status.state = 'generating'
    Save-ContinuationStatus
    & (Join-Path $PSScriptRoot 'run-media-reference-queue.ps1') `
        -PythonExecutable $PythonExecutable -VerificationRoot $VerificationRoot `
        -ModelRoot $ModelRoot -BatchesPath $BatchesPath
    $status.state = 'finished'
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-ContinuationStatus
}
