$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$encoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $encoding
[Console]::InputEncoding = $encoding
$OutputEncoding = $encoding

function Assert-OrdinaryPath([string]$path, [bool]$directory) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $directory) { throw 'Storage paths cannot be redirected.' }
}

function Read-Record([string]$path) {
    Assert-OrdinaryPath $path $false
    if ((Get-Item -LiteralPath $path -Force).Length -gt 16384) { throw 'Storage record exceeds its limit.' }
    return [IO.File]::ReadAllText($path) | ConvertFrom-Json
}

function Save-Record {
    $temporary = Join-Path $directory ('record-' + [guid]::NewGuid().ToString('D') + '.tmp')
    $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $encoding.GetBytes(($script:record | ConvertTo-Json -Compress))
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
    if (Test-Path -LiteralPath $recordPath) {
        Assert-OrdinaryPath $recordPath $false
        [IO.File]::Replace($temporary, $recordPath, [NullString]::Value)
    } else { [IO.File]::Move($temporary, $recordPath) }
}

function Invoke-Disk([string]$action) {
    $request = @{ action=$action; image=$image; id=$inputRecord.id; bytes=$inputRecord.bytes; volumeId=$script:record.volumeId } | ConvertTo-Json -Compress
    $raw = $request | & $inputRecord.helper
    $code = $LASTEXITCODE
    $reply = $raw | ConvertFrom-Json
    if ($code -ne 0 -or -not $reply.ok) { throw $reply.error }
    return $reply.volume
}

function Get-OwnedDisk {
    $native = Invoke-Disk 'inspect'
    if (-not $native.physicalPath) { throw 'The owned image is not attached.' }
    $diskImage = Get-DiskImage -ImagePath $image
    $disks = @($diskImage | Get-Disk)
    if ($disks.Count -ne 1) { throw 'The image does not identify exactly one disk.' }
    $disk = $disks[0]
    if ($diskImage.ImagePath -ne $image -or -not $diskImage.Attached -or $diskImage.DevicePath -ne $native.physicalPath -or
        $disk.IsBoot -or $disk.IsSystem -or $disk.BusType -ne 'File Backed Virtual' -or $disk.Size -ne $inputRecord.bytes) {
        throw 'The virtual disk failed identity validation.'
    }
    return $disk
}

function Get-OwnedPartition {
    $disk = Get-OwnedDisk
    if ($disk.PartitionStyle -ne 'GPT') { throw 'The owned partition layout changed.' }
    $partitions = @($disk | Get-Partition | Where-Object { $_.GptType -eq '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}' })
    if ($partitions.Count -ne 1) { throw 'The owned data partition changed.' }
    $volume = $partitions[0] | Get-Volume
    if ($volume.UniqueId -ne $script:record.volumeId -or $volume.FileSystem -ne 'NTFS' -or $volume.Size -gt $inputRecord.bytes) {
        throw 'The owned filesystem identity changed.'
    }
    return $partitions[0]
}

function Assert-MountedVolume {
    Get-OwnedPartition | Out-Null
    if ((Invoke-Disk 'inspect').mountVolumeId -ine $script:record.volumeId) { throw 'The owned mount path changed.' }
    $marker = Read-Record (Join-Path $mount 'owner.json')
    if ($marker.id -ne $inputRecord.id -or $marker.attemptId -ne $inputRecord.attemptId -or $marker.bytes -ne $inputRecord.bytes) {
        throw 'The mounted volume belongs to another task.'
    }
}

function Assert-Stopped {
    $receipt = Read-Record (Join-Path $directory 'stopped.json')
    if ($receipt.version -ne 1 -or $receipt.environmentId -cne $inputRecord.id -or $receipt.processTreeStopped -isnot [bool] -or
        -not $receipt.processTreeStopped -or $receipt.supervisorPid -le 0 -or
        $receipt.reason -notin @('completed', 'canceled', 'lease_expired', 'parent_closed', 'control_error', 'start_expired')) {
        throw 'The task has no matching native stop receipt. Preserve its volume for recovery.'
    }
}

function Initialize-OwnedVolume {
    if (@(Get-ChildItem -LiteralPath $mount -Force).Count) { throw 'The new mount directory is not empty.' }
    Assert-OrdinaryPath $mount $true
    $disk = Get-OwnedDisk
    if ($disk.PartitionStyle -ne 'RAW') { throw 'Only a newly created raw image can be initialized.' }
    $diskPath = $disk.Path
    $diskNumber = $disk.Number
    Initialize-Disk -InputObject $disk -PartitionStyle GPT -Confirm:$false | Out-Null
    $disk = Get-OwnedDisk
    if ($disk.Path -ne $diskPath -or $disk.Number -ne $diskNumber) { throw 'Disk identity changed before partitioning.' }
    $partition = New-Partition -InputObject $disk -UseMaximumSize
    $disk = Get-OwnedDisk
    if ($disk.Path -ne $diskPath -or $disk.Number -ne $diskNumber -or $partition.DiskNumber -ne $diskNumber) { throw 'Disk identity changed before formatting.' }
    $volume = Format-Volume -Partition $partition -FileSystem NTFS -AllocationUnitSize 4096 -NewFileSystemLabel ('mch-' + $inputRecord.id.Substring(0, 20)) -Force -Confirm:$false
    $script:record.volumeId = $volume.UniqueId
    Save-Record
    $partition = Get-OwnedPartition
    Add-PartitionAccessPath -InputObject $partition -AccessPath ($mount + '\')
    if ((Invoke-Disk 'inspect').mountVolumeId -ine $script:record.volumeId) { throw 'The new volume was not mounted.' }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $permissions = New-Object Security.AccessControl.DirectorySecurity
    $permissions.SetOwner($owner)
    $permissions.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    [IO.Directory]::SetAccessControl($volume.UniqueId, $permissions)
    $applied = [IO.Directory]::GetAccessControl($volume.UniqueId)
    if (-not $applied.AreAccessRulesProtected -or $applied.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw 'The volume ownership permissions were not applied.' }
    $marker = @{ id=$inputRecord.id; attemptId=$inputRecord.attemptId; bytes=$inputRecord.bytes } | ConvertTo-Json -Compress
    $file = [IO.File]::Open((Join-Path $mount 'owner.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = $encoding.GetBytes($marker); $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    [IO.Directory]::CreateDirectory((Join-Path $mount 'checkout')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $mount 'state')) | Out-Null
    Assert-MountedVolume
    $script:record.phase = 'ready'
    Save-Record
}

$lock = $null
try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -gt 16384) { throw 'Storage request exceeds its limit.' }
    $inputRecord = $raw | ConvertFrom-Json
    if ($inputRecord.action -notin @('create','inspect','attach','begin','detach') -or
        $inputRecord.id -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $inputRecord.attemptId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $inputRecord.bytes -lt 256MB -or $inputRecord.bytes -gt 16GB -or $inputRecord.bytes % 1MB -ne 0) { throw 'Invalid owned volume request.' }
    $directory = [IO.Path]::GetFullPath($inputRecord.directory).TrimEnd('\')
    if ($directory -cne $inputRecord.directory -or $directory -notmatch '^[A-Za-z]:\\.+') { throw 'Use an absolute local volume directory.' }
    $current = $directory
    while ($current) { Assert-OrdinaryPath $current $true; $current = [IO.Path]::GetDirectoryName($current) }
    Assert-OrdinaryPath $inputRecord.helper $false
    if ((Get-FileHash -LiteralPath $inputRecord.helper -Algorithm SHA256).Hash -ine $inputRecord.helperSha256) { throw 'The verified storage helper changed.' }
    $lockPath = Join-Path $directory 'operation.lock'
    if (Test-Path -LiteralPath $lockPath) { Assert-OrdinaryPath $lockPath $false }
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $recordPath = Join-Path $directory 'volume.json'
    $image = Join-Path $directory 'sandbox.vhdx'
    $mount = Join-Path $directory 'mount'
    if ($inputRecord.action -eq 'create') {
        $entries = @(Get-ChildItem -LiteralPath $directory -Force | Where-Object { $_.Name -ne 'operation.lock' })
        if ($entries.Count) { throw 'The volume directory is not empty. Preserve it for recovery.' }
        $script:record = [pscustomobject]@{ id=$inputRecord.id; attemptId=$inputRecord.attemptId; bytes=$inputRecord.bytes; phase='creating'; volumeId=$null }
        Save-Record
        Invoke-Disk 'create' | Out-Null
        $script:record.phase = 'formatting'
        Save-Record
        [IO.Directory]::CreateDirectory($mount) | Out-Null
        Invoke-Disk 'attach' | Out-Null
        Initialize-OwnedVolume
    } else {
        $script:record = Read-Record $recordPath
        if ($script:record.id -cne $inputRecord.id -or $script:record.attemptId -cne $inputRecord.attemptId -or
            $script:record.bytes -ne $inputRecord.bytes -or $script:record.phase -notin @('creating','formatting','ready','active','stopped')) {
            throw 'The volume record belongs to another task or is invalid.'
        }
        $native = Invoke-Disk 'inspect'
        switch ($inputRecord.action) {
            'begin' {
                if ($script:record.phase -ne 'ready' -or -not $native.physicalPath -or (Test-Path -LiteralPath (Join-Path $directory 'stopped.json'))) { throw 'This volume is not available for a new execution.' }
                Assert-MountedVolume
                $script:record.phase = 'active'
                Save-Record
            }
            'attach' {
                if ($script:record.phase -in @('creating','formatting')) { throw 'Volume setup was interrupted. Preserve it for recovery.' }
                if ($script:record.phase -in @('active','stopped')) { Assert-Stopped; $script:record.phase = 'stopped'; Save-Record }
                Invoke-Disk 'attach' | Out-Null
                $partition = Get-OwnedPartition
                $mounted = (Invoke-Disk 'inspect').mountVolumeId
                if ($mounted -and $mounted -ine $script:record.volumeId) { throw 'The mount point belongs to another volume. Preserve it for recovery.' }
                if (-not $mounted) {
                    Assert-OrdinaryPath $mount $true
                    if (@(Get-ChildItem -LiteralPath $mount -Force).Count) { throw 'The mount directory is not empty.' }
                    Add-PartitionAccessPath -InputObject $partition -AccessPath ($mount + '\')
                }
                Assert-MountedVolume
            }
            'detach' {
                if ($script:record.phase -in @('active','stopped')) { Assert-Stopped; $script:record.phase = 'stopped'; Save-Record }
                Invoke-Disk 'detach' | Out-Null
            }
        }
    }
    $native = Invoke-Disk 'inspect'
    if ($native.physicalPath -and $script:record.phase -in @('ready','active','stopped')) { Assert-MountedVolume }
    $result = @{ id=$script:record.id; attemptId=$script:record.attemptId; bytes=$script:record.bytes; phase=$script:record.phase; volumeId=$script:record.volumeId; physicalBytes=$native.physicalBytes; attached=[bool]$native.physicalPath }
    [Console]::WriteLine((@{ ok=$true; volume=$result } | ConvertTo-Json -Depth 4 -Compress))
} catch {
    [Console]::WriteLine((@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
} finally { if ($lock) { $lock.Dispose() } }
