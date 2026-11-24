if ($global:__MachdochShellIntegration) { return }
$global:__MachdochShellIntegration = $true
$global:__MachdochLastHistoryId = -1
$global:__MachdochOriginalPrompt = $function:prompt

function global:__MachdochEscape([string]$Value) {
  $Value.Replace('\', '\\').Replace(';', '\x3b').Replace("`n", '\x0a').Replace("`r", '\x0d')
}

function global:__MachdochSequence([string]$Body) {
  "$([char]27)]633;$Body$([char]7)"
}

function global:prompt {
  $succeeded = $global:?
  $exitCode = $global:LASTEXITCODE
  $output = ""
  $history = Get-History -Count 1
  if ($history -and $history.Id -ne $global:__MachdochLastHistoryId) {
    $global:__MachdochLastHistoryId = $history.Id
    $code = if ($succeeded) { 0 } elseif ($exitCode) { $exitCode } else { 1 }
    $output += __MachdochSequence "D;$code"
  }
  $location = $executionContext.SessionState.Path.CurrentLocation
  if ($location.Provider.Name -eq "FileSystem") {
    $output += __MachdochSequence "P;Cwd=$(__MachdochEscape $location.ProviderPath)"
  }
  $output += __MachdochSequence "A"
  $output += & $global:__MachdochOriginalPrompt
  $output += __MachdochSequence "B"
  $output
}

if (Get-Module -Name PSReadLine) {
  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
    $line = $null
    $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    [Console]::Write((__MachdochSequence "E;$(__MachdochEscape $line)") + (__MachdochSequence "C"))
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
  }
}
