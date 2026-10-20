param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$speechArchive = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $speechTotalBytes = 0L
  foreach ($speechEntry in $speechArchive.Entries) {
    $speechName = $speechEntry.FullName.Replace('\','/')
    if ($speechName.StartsWith('/') -or $speechName.Contains(':') -or ($speechName.Split('/') -contains '..')) { throw 'Unsafe encoder archive path.' }
    $speechTotalBytes += $speechEntry.Length
    if ($speechTotalBytes -gt 1GB -or $speechEntry.Length -gt 256MB) { throw 'Encoder archive exceeds the extraction guard.' }
  }
} finally { $speechArchive.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
