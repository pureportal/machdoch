param(
    [Parameter(Mandatory)][int[]]$QueueProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$ProcDumpExecutable,
    [Parameter(Mandatory)][string]$DiagnosticsDirectory
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'media-reference-processes.ps1')
$verificationPath = (Resolve-Path -LiteralPath $VerificationRoot).Path
$pythonPath = (Resolve-Path -LiteralPath $PythonExecutable).Path
$procDumpPath = (Resolve-Path -LiteralPath $ProcDumpExecutable).Path
$signature = Get-AuthenticodeSignature -LiteralPath $procDumpPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw 'Use the signed Microsoft ProcDump executable.'
}
New-Item -ItemType Directory -Path $DiagnosticsDirectory -Force | Out-Null
$diagnosticsPath = (Resolve-Path -LiteralPath $DiagnosticsDirectory).Path
$observed = [System.Collections.Generic.HashSet[string]]::new()
$queues = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in $QueueProcessId })
$monitors = @()
$statusPath = Join-Path $diagnosticsPath 'monitor-status.json'
$status = @{ startedAt = [DateTime]::UtcNow.ToString('o'); queueProcessIds = $QueueProcessId; targets = @(); phase = 'monitoring' }
$firstPoll = $true

try {
    while ($true) {
        $processes = @(Get-CimInstance Win32_Process)
        $ownership = Get-OwnedMediaReferenceProcesses -Processes $processes -QueueProcesses $queues -VerificationPath $verificationPath -PythonPath $pythonPath
        $byId = $ownership.byId
        $liveQueues = @($ownership.queues)
        if ($firstPoll -and $liveQueues.Count -ne $QueueProcessId.Count) {
            throw 'Every selected queue must be a live reference runner for this verification root.'
        }
        $firstPoll = $false
        if ($liveQueues.Count -eq 0) { break }
        foreach ($process in $ownership.workers) {
            $targetId = [int]$process.ProcessId
            $createdAt = $process.CreationDate.ToUniversalTime()
            $targetIdentity = "$targetId-$($createdAt.ToString('o'))"
            if ($observed.Contains($targetIdentity)) { continue }
            $existingMonitor = $processes | Where-Object {
                $_.ExecutablePath -eq $procDumpPath -and $_.CommandLine -match " -e $targetId(?: |$)"
            } | Select-Object -First 1
            if ($existingMonitor) {
                $monitorId = [int]$existingMonitor.ProcessId
                $monitorCreation = $existingMonitor.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
            } else {
                $monitor = Start-Process -FilePath $procDumpPath -ArgumentList @('-accepteula', '-mm', '-e', $targetId, ('"' + $diagnosticsPath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $diagnosticsPath "$targetId.stdout.log") -RedirectStandardError (Join-Path $diagnosticsPath "$targetId.stderr.log")
                $monitorId = $monitor.Id
                $monitorCreation = $monitor.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')
                $monitors += @{ targetId = $targetId; targetCreatedAt = $createdAt; monitorId = $monitorId; monitorCreatedAt = $monitorCreation }
            }
            $observed.Add($targetIdentity) | Out-Null
            $status.targets += @{ processId = $targetId; createdAt = $createdAt; monitorProcessId = $monitorId; monitorCreatedAt = $monitorCreation; command = $process.CommandLine; attachedAt = [DateTime]::UtcNow.ToString('o'); reusedMonitor = [bool]$existingMonitor }
            $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding utf8
        }
        foreach ($target in $status.targets) {
            $currentTarget = $byId[[int]$target.processId]
            $currentMonitor = $byId[[int]$target.monitorProcessId]
            $target.targetAlive = $null -ne $currentTarget -and $currentTarget.CreationDate.ToUniversalTime() -eq $target.createdAt
            $target.monitorAlive = $null -ne $currentMonitor -and $currentMonitor.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -eq $target.monitorCreatedAt
        }
        $status.checkedAt = [DateTime]::UtcNow.ToString('o')
        $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding utf8
        Start-Sleep -Seconds 5
    }
    $status.phase = 'finished'
} catch {
    $status.phase = 'failed'
    $status.error = $_.Exception.Message
    throw
} finally {
    foreach ($monitor in $monitors) {
        $target = Get-CimInstance Win32_Process -Filter "ProcessId=$($monitor.targetId)"
        $debugger = Get-CimInstance Win32_Process -Filter "ProcessId=$($monitor.monitorId)"
        if ($null -ne $target -and $null -ne $debugger -and $target.ExecutablePath -eq $pythonPath -and $debugger.ExecutablePath -eq $procDumpPath -and
            $target.CreationDate.ToUniversalTime() -eq $monitor.targetCreatedAt -and
            $debugger.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -eq $monitor.monitorCreatedAt -and
            $debugger.CommandLine -match " -e $($monitor.targetId)(?: |$)") {
            & $procDumpPath -cancel $monitor.targetId | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "ProcDump could not detach from owned worker $($monitor.targetId)." }
        }
    }
    $status.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
