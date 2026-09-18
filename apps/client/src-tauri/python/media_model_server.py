from __future__ import annotations

import json
import sys
import traceback

from media_model_memory import (
    GPU_MEMORY_ERROR,
    ImagePipelineCache,
    is_gpu_out_of_memory,
    memory_snapshot,
    release_allocator,
)


MAX_REQUEST_BYTES = 2 * 1024 * 1024


def serve(worker) -> int:
    cache = None
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                return 0
            if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
                raise ValueError("Invalid model worker request")
            envelope = json.loads(line)
            command = envelope["command"]
            if command == "probe":
                result = worker.probe()
            elif command == "memory":
                result = memory_snapshot(cache.torch, cache.device) if cache else {"pressure": False}
            elif command == "generate":
                if cache is None:
                    torch, _ = worker._runtime()
                    device, _, _ = worker._device(torch)
                    cache = ImagePipelineCache(torch, device, worker.PROCESS_STARTED_AT)
                result = worker.generate(envelope["request"], cache)
                release_allocator(cache.torch, cache.device)
            else:
                raise ValueError("Unknown model worker command")
            print(json.dumps({"result": result, "retentionSeconds": cache.retention if cache else 0}), flush=True)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        message = GPU_MEMORY_ERROR if is_gpu_out_of_memory(error) else str(error)
        print(json.dumps({"error": message}), flush=True)
        return 2
    finally:
        if cache is not None:
            cache.clear()
