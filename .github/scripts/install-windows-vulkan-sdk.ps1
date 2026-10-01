$ErrorActionPreference = "Stop"

$sdkVersion = "1.4.341.1"
$sdkDirectory = Join-Path $env:RUNNER_TEMP "vulkan-sdk"
$installerPath = Join-Path $env:RUNNER_TEMP "vulkansdk-windows-X64-$sdkVersion.exe"
Invoke-WebRequest "https://sdk.lunarg.com/sdk/download/$sdkVersion/windows/vulkansdk-windows-X64-$sdkVersion.exe" -OutFile $installerPath
if ((Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash -ne "BCF2D75AA9556889AB974858666E20B3655B6055A0DB704CCB47279FF33B5BFE") {
    throw "Vulkan SDK download failed its integrity check."
}
$installer = Start-Process -FilePath $installerPath -ArgumentList @(
    "--root", "`"$sdkDirectory`"", "--accept-licenses", "--default-answer",
    "--confirm-command", "install", "copy_only=1"
) -WindowStyle Hidden -Wait -PassThru
if ($installer.ExitCode -ne 0) {
    throw "Vulkan SDK installation failed with exit code $($installer.ExitCode)."
}
Add-Content -LiteralPath $env:GITHUB_ENV -Value "VULKAN_SDK=$sdkDirectory"
