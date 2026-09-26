$ErrorActionPreference = "Stop"

$llvmDirectory = Join-Path $env:ProgramFiles "LLVM\bin"
if (-not (Test-Path -LiteralPath (Join-Path $llvmDirectory "libclang.dll"))) {
    throw "libclang.dll is missing from $llvmDirectory. Install the full LLVM Windows package."
}

if (-not (rustc -vV | Select-String "^host: x86_64-pc-windows-msvc$")) {
    throw "The Windows desktop build requires the x86_64-pc-windows-msvc Rust toolchain."
}

if (-not ((cmake --help | Out-String).Contains("Visual Studio 18 2026"))) {
    throw "CMake 4.2 or newer is required for the Visual Studio 2026 generator."
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "Visual Studio Build Tools are required for the Windows desktop build."
}

$installations = & $vswhere -all -products "*" -format json | ConvertFrom-Json
$msvc = $installations | Where-Object {
    $versionFile = Join-Path $_.installationPath "VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt"
    if (-not (Test-Path -LiteralPath $versionFile)) {
        return $false
    }
    $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    $compiler = Join-Path $_.installationPath "VC\Tools\MSVC\$version\bin\Hostx64\x64\cl.exe"
    $msbuild = Join-Path $_.installationPath "MSBuild\Current\Bin\MSBuild.exe"
    (Test-Path -LiteralPath $compiler) -and (Test-Path -LiteralPath $msbuild)
}
if (-not $msvc) {
    throw "The Visual Studio C++ x64 compiler is required for the Windows desktop build."
}

Add-Content -LiteralPath $env:GITHUB_ENV -Value "LIBCLANG_PATH=$llvmDirectory"
