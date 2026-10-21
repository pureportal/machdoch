import json
import os
from pathlib import Path

os.environ.update(HIP_VISIBLE_DEVICES='1', MACHDOCH_MEDIA_CUDA_DEVICE='0', MIOPEN_FIND_MODE='2')
import torch
import bitsandbytes as bnb

result = {'torch': torch.__version__, 'bitsandbytes': bnb.__version__, 'device': torch.cuda.get_device_name(0), 'passed': False}
try:
    layer = bnb.nn.Linear4bit(64, 64, bias=False, compute_dtype=torch.bfloat16, quant_type='nf4').to('cuda')
    with torch.inference_mode():
        output = layer(torch.randn(2, 64, dtype=torch.bfloat16, device='cuda'))
    result['passed'] = bool(torch.isfinite(output).all())
    result['shape'] = list(output.shape)
except Exception as error:
    result['error'] = f'{type(error).__name__}: {error}'
Path('docs/validation/image-engines/research-2026-10-13/hidream-nf4-kernel-probe.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
