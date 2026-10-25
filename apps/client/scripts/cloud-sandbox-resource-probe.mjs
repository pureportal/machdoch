import assert from "node:assert/strict";
import { createRequire } from "node:module";

export function inspectSandboxJob(processId) {
  const require = createRequire(import.meta.resolve("@microsoft/mxc-sdk/v1"));
  const koffi = require("koffi");
  const basic = koffi.struct({
    processTime: "int64_t",
    jobTime: "int64_t",
    flags: "uint32_t",
    minimumWorkingSet: "size_t",
    maximumWorkingSet: "size_t",
    processes: "uint32_t",
    affinity: "uintptr_t",
    priority: "uint32_t",
    scheduling: "uint32_t",
  });
  const io = koffi.struct({
    readOperations: "uint64_t",
    writeOperations: "uint64_t",
    otherOperations: "uint64_t",
    readBytes: "uint64_t",
    writeBytes: "uint64_t",
    otherBytes: "uint64_t",
  });
  const extended = koffi.struct({
    basic,
    io,
    processMemory: "size_t",
    jobMemory: "size_t",
    peakProcessMemory: "size_t",
    peakJobMemory: "size_t",
  });
  const query = koffi
    .load("kernel32.dll")
    .func(
      "int32_t __stdcall QueryInformationJobObject(void *job, int32_t kind, void *information, uint32_t length, void *returned)",
    );
  const limits = Buffer.alloc(koffi.sizeof(extended));
  assert.notEqual(query(null, 9, limits, limits.length, null), 0);
  const value = koffi.decode(limits, extended);
  const cpu = Buffer.alloc(8);
  assert.notEqual(query(null, 15, cpu, cpu.length, null), 0);
  const processIds = Buffer.alloc(8 + 128 * 8);
  assert.notEqual(query(null, 3, processIds, processIds.length, null), 0);
  const count = processIds.readUInt32LE(4);
  assert.ok(count <= 128);
  return {
    memory: Number(value.jobMemory),
    processes: value.basic.processes,
    cpuFlags: cpu.readUInt32LE(0),
    cpuRate: cpu.readUInt32LE(4),
    sandboxIncluded: Array.from({ length: count }, (_, index) =>
      Number(processIds.readBigUInt64LE(8 + index * 8)),
    ).includes(processId),
  };
}
