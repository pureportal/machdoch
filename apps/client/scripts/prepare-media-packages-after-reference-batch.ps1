param(
    [Parameter(Mandatory)][int]$GenerationProcessId,
    [Parameter(Mandatory)][string]$VerificationRoot,
    [Parameter(Mandatory)][string]$ModelRoot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$statusPath = Join-Path $VerificationRoot 'postbatch-preparation-status.json'
if (Test-Path -LiteralPath $statusPath) { throw 'Preparation status already exists' }
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $GenerationProcessId"
if ($null -eq $target -or -not $target.CommandLine.Contains('verify_media_reference_batches.py')) {
    throw 'The selected reference-generation process is not running'
}
$python = Join-Path $ModelRoot 'runtime/environment/Scripts/python.exe'
$pythonScripts = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri/python'
$downloads = Join-Path $ModelRoot 'downloads'
$status = @{ state = 'waiting'; processId = $PID; generationProcessId = $GenerationProcessId; operations = @() }
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
Wait-Process -Id $GenerationProcessId
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$operations = @(
    @{ name = 'rocm-4bit'; script = 'verify_media_rocm_nf4.py'; arguments = @('--output', (Join-Path $VerificationRoot 'rocm-4bit-inference.json')) },
    @{ name = 'sd2'; script = 'prepare_sd2_verification_package.py'; arguments = @(
        '--checkpoint', (Join-Path $downloads 'civitai/15303/46259/rmadaMergeSD21768_v70.safetensors'),
        '--components', (Join-Path $downloads 'components-sd2-1'),
        '--publisher', (Join-Path $VerificationRoot 'sd2-community-publisher-current.json'),
        '--license', (Join-Path $VerificationRoot 'sd2-LICENSE-MODEL'),
        '--output', (Join-Path $downloads 'prepared-sd2-rmada')) },
    @{ name = 'flux-klein'; script = 'prepare_flux2_klein_verification_package.py'; arguments = @(
        '--checkpoint', (Join-Path $downloads 'civitai/2341785/2634080/flux2Klein4BClear_bf16.safetensors'),
        '--components', (Join-Path $downloads 'components-flux-2-klein-4b'),
        '--publisher', (Join-Path $VerificationRoot 'flux-2-klein-4b-publisher-current.json'),
        '--license', (Join-Path $VerificationRoot 'flux-2-klein-4b-publisher-LICENSE.md'),
        '--output', (Join-Path $downloads 'prepared-flux-2-klein-4b')) },
    @{ name = 'flux-klein-base'; script = 'prepare_flux2_klein_verification_package.py'; arguments = @(
        '--checkpoint', (Join-Path $downloads 'civitai/2322332/2612552/flux2Klein_4bBase.safetensors'),
        '--components', (Join-Path $downloads 'components-flux-2-klein-base-4b'),
        '--publisher', (Join-Path $VerificationRoot 'flux-2-klein-base-4b-publisher-current.json'),
        '--license', (Join-Path $downloads 'components-flux-2-klein-base-4b/LICENSE.md'),
        '--output', (Join-Path $downloads 'prepared-flux-2-klein-base-4b')) },
    @{ name = 'flux-schnell'; script = 'prepare_flux1_verification_package.py'; arguments = @(
        '--architecture', 'flux-1-schnell',
        '--t5-license', (Join-Path $VerificationRoot 'flux-1-schnell-LICENSE'),
        '--checkpoint', (Join-Path $downloads 'civitai/618692/699279/flux_schnell.sft'),
        '--components', (Join-Path $downloads 'components-flux-1-schnell'),
        '--publisher', (Join-Path $VerificationRoot 'flux-1-schnell-publisher-current.json'),
        '--license', (Join-Path $VerificationRoot 'flux-1-schnell-LICENSE'),
        '--clip-license', (Join-Path $VerificationRoot 'flux-1-clip-LICENSE'),
        '--output', (Join-Path $downloads 'prepared-flux-1-schnell')) }
)
foreach ($operation in $operations) {
    $record = @{ name = $operation.name; state = 'running'; startedAt = [DateTime]::UtcNow.ToString('o') }
    $status.state = 'running'
    $status.operations += $record
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    $script = Join-Path $pythonScripts $operation.script
    $log = Join-Path $VerificationRoot ($operation.name + '-postbatch.log')
    $arguments = $operation.arguments
    & $python -B $script @arguments *> $log
    $record.exitCode = $LASTEXITCODE
    $record.state = if ($LASTEXITCODE -eq 0) { 'passed' } else { 'failed' }
    $record.finishedAt = [DateTime]::UtcNow.ToString('o')
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
$status.state = 'finished'
$status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
