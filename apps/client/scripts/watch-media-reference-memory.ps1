param(
    [Parameter(Mandatory)][int[]]$QueueProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$DiagnosticsDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'media-reference-processes.ps1')
$verificationPath = (Resolve-Path -LiteralPath $VerificationRoot).Path
$pythonPath = (Resolve-Path -LiteralPath $PythonExecutable).Path
New-Item -ItemType Directory -Path $DiagnosticsDirectory -Force | Out-Null
$diagnosticsPath = (Resolve-Path -LiteralPath $DiagnosticsDirectory).Path
$logPath = Join-Path $diagnosticsPath "$PID-memory.jsonl"
$statusPath = Join-Path $diagnosticsPath "$PID-memory-status.json"
$queues = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $QueueProcessId })
$status = @{ processId = $PID; startedAt = [DateTime]::UtcNow.ToString('o'); phase = 'monitoring'; samples = 0; log = $logPath }
$firstPoll = $true

try {
    while ($true) {
        $ownership = Get-OwnedMediaReferenceProcesses -Processes @(Get-CimInstance Win32_Process) -QueueProcesses $queues -VerificationPath $verificationPath -PythonPath $pythonPath
        if ($firstPoll -and $ownership.queues.Count -ne $QueueProcessId.Count) {
            throw 'Every selected queue must be a live reference runner for this verification root.'
        }
        $firstPoll = $false
        if ($ownership.queues.Count -eq 0) { break }
        $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        $adapters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory |
            Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted)
        $samples = foreach ($worker in $ownership.workers) {
            try {
                $target = Get-Process -Id $worker.ProcessId -ErrorAction Stop
            } catch {
                if ($null -eq (Get-CimInstance Win32_Process -Filter "ProcessId=$($worker.ProcessId)")) { continue }
                throw
            }
            if ($target.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne $worker.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) { continue }
            $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Filter "Name LIKE 'pid_$($worker.ProcessId)_%'")
            @{ processId = $worker.ProcessId; createdAt = $worker.CreationDate.ToUniversalTime().ToString('o');
               workingSetBytes = $target.WorkingSet64; privateBytes = $target.PrivateMemorySize64;
               virtualBytes = $target.VirtualMemorySize64; cpuSeconds = $target.CPU; gpuCounterCount = $gpu.Count;
               gpuDedicatedBytes = ($gpu | Measure-Object -Property DedicatedUsage -Sum).Sum;
               gpuSharedBytes = ($gpu | Measure-Object -Property SharedUsage -Sum).Sum;
               gpuCommittedBytes = ($gpu | Measure-Object -Property TotalCommitted -Sum).Sum }
        }
        $record = @{ recordedAt = [DateTime]::UtcNow.ToString('o'); systemAvailableBytes = $memory.AvailableBytes;
                     systemCommittedBytes = $memory.CommittedBytes; systemCommitLimitBytes = $memory.CommitLimit;
                     gpuAdapters = $adapters; workers = @($samples) }
        [System.IO.File]::AppendAllText($logPath, ($record | ConvertTo-Json -Depth 5 -Compress) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        $status.samples += 1
        $status.checkedAt = $record.recordedAt
        $status.targetProcessIds = @($ownership.workers | ForEach-Object { $_.ProcessId })
        $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
        Start-Sleep -Seconds 10
    }
    $status.phase = 'finished'
} catch {
    $status.phase = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
