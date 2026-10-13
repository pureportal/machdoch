function Get-OwnedMediaReferenceProcesses {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$QueueProcesses,
        [Parameter(Mandatory)][string]$VerificationPath,
        [Parameter(Mandatory)][string]$PythonPath
    )

    $byId = @{}
    foreach ($process in $Processes) { $byId[[int]$process.ProcessId] = $process }
    $rootPattern = [regex]::Escape($VerificationPath.TrimEnd('\')) + '(?=[\\\s"'']|$)'
    $queues = @($QueueProcesses | Where-Object {
        $current = $byId[[int]$_.ProcessId]
        $current -and $current.CreationDate -eq $_.CreationDate -and $current.Name -eq 'pwsh.exe' -and
            $current.CommandLine.Replace('/', '\') -match '(?:^|[\\\s"''])(?:run|continue)-media-reference-queue\.ps1(?=[\s"'']|$)' -and
            $current.CommandLine.Replace('/', '\') -match $rootPattern
    })
    $queueIds = @($queues | ForEach-Object { [int]$_.ProcessId })
    $workers = foreach ($process in $Processes) {
        if ($process.ExecutablePath -ne $PythonPath -or
            $process.CommandLine.Replace('/', '\') -notmatch '(?:^|[\\\s"''])verify_media_reference_sweep\.py(?=[\s"'']|$)' -or
            $process.CommandLine.Replace('/', '\') -notmatch $rootPattern) { continue }
        $parentId = [int]$process.ParentProcessId
        $childCreation = $process.CreationDate
        $ancestors = [System.Collections.Generic.HashSet[int]]::new()
        while ($byId.ContainsKey($parentId) -and $ancestors.Add($parentId)) {
            $parent = $byId[$parentId]
            if ($parent.CreationDate -gt $childCreation) { break }
            if ($parentId -in $queueIds) {
                $process
                break
            }
            $childCreation = $parent.CreationDate
            $parentId = [int]$parent.ParentProcessId
        }
    }
    return @{ queues = $queues; workers = @($workers); byId = $byId }
}
