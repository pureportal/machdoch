import { spawn } from "node:child_process";
import { existsSync, createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import { prepareWindowsVulkanToolchain } from "../../../apps/client/scripts/windows-vulkan-toolchain.mjs";

const environment = { ...process.env };
const pathKey = Object.keys(environment).find(key => key.toLowerCase() === "path") ?? "PATH";
const visualStudio="C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools";
const compiler=path.join(visualStudio,"VC/Tools/MSVC/14.50.35717");
const sdk="C:/Program Files (x86)/Windows Kits/10";
const sdkVersion="10.0.26100.0";
const llvm="C:/Program Files/LLVM/bin";
for(const file of [path.join(compiler,"bin/Hostx64/x64/cl.exe"),path.join(sdk,`bin/${sdkVersion}/x64/rc.exe`),path.join(llvm,"libclang.dll")]){
  if(!existsSync(file))throw new Error(`Required verification toolchain file is missing: ${file}`);
}
environment[pathKey]=[path.join(compiler,"bin/Hostx64/x64"),path.join(sdk,`bin/${sdkVersion}/x64`),path.join(visualStudio,"Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin"),"D:/Models/machdoch/speech/verification/ninja-1.13.2/bin",environment[pathKey]??""].join(path.delimiter);
environment.INCLUDE=[path.join(compiler,"include"),...["ucrt","shared","um","winrt"].map(part=>path.join(sdk,`Include/${sdkVersion}/${part}`))].join(path.delimiter);
environment.LIB=[path.join(compiler,"lib/x64"),...["ucrt","um"].map(part=>path.join(sdk,`Lib/${sdkVersion}/${part}/x64`))].join(path.delimiter);
environment.LIBPATH=path.join(compiler,"lib/x64");
environment.VCToolsInstallDir=compiler+path.sep;
environment.WindowsSdkDir=sdk+path.sep;
environment.WindowsSDKVersion=sdkVersion+path.sep;
environment.LIBCLANG_PATH=llvm;
environment.CMAKE_GENERATOR="Ninja";
environment._CL_="/FS /Z7";
delete environment.CMAKE_GENERATOR_INSTANCE;
prepareWindowsVulkanToolchain(environment);
environment.CARGO_TARGET_DIR = "D:/Models/machdoch/t";
environment.TAURI_CONFIG = JSON.stringify({bundle:{resources:[]}});
console.log("Checking Rust integration with packaged resources excluded. This does not verify application packaging.");
const cargo = path.join(process.env.USERPROFILE, ".cargo/bin/cargo.exe");
const logPath = "D:/Models/machdoch/speech/verification/desktop-check.log";
const log = createWriteStream(logPath);
const child = spawn(cargo, ["check", "--manifest-path", "apps/client/src-tauri/Cargo.toml", "--lib"], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("close", code => {
  log.end(() => {
    const lines = readFileSync(logPath, "utf8").split(/\r?\n/u);
    console.log(lines.filter(line => /error|FAILED|fatal|Finished|Checking machdoch|Compiling whisper/iu.test(line)).join("\n"));
    console.log(`Full log: ${logPath}`);
    process.exitCode = code ?? 1;
  });
});
