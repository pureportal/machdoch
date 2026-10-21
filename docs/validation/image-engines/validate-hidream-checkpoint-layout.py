import json
from pathlib import Path
import struct

from accelerate import init_empty_weights
from diffusers import HiDreamImageTransformer2DModel
import torch

evidence = Path('docs/validation/image-engines/research-2026-10-13')
directory = Path('D:/Models/machdoch/downloads/civitai/1457126/1647676')
source = next(directory.glob('*.safetensors*'))
with source.open('rb') as file:
    header_size = struct.unpack('<Q', file.read(8))[0]
    header = json.loads(file.read(header_size))
header.pop('__metadata__', None)
config_path = evidence / 'hidream-4bit-transformer-config.json'
config = json.loads(config_path.read_text(encoding='utf-8'))
with init_empty_weights(include_buffers=True):
    model = HiDreamImageTransformer2DModel.from_config({key: value for key, value in config.items() if key != 'quantization_config'})
expected = model.state_dict()
missing = sorted(set(expected) - set(header))
packed = {name for name, tensor in header.items() if name.endswith('.weight') and tensor['dtype'] == 'U8'}
wrong_shapes = []
for name, tensor in expected.items():
    if name not in header:
        continue
    shape = header[name]['shape']
    if name in packed:
        if torch.Size(shape).numel() != (tensor.numel() + 1) // 2:
            wrong_shapes.append(name)
    elif shape != list(tensor.shape):
        wrong_shapes.append(name)
skip_modules = [name for name, module in model.named_modules() if isinstance(module, torch.nn.Linear) and name + '.weight' not in packed]
result = {'source': str(source), 'expectedTensors': len(expected), 'packedLinearWeights': len(packed), 'missing': missing, 'wrongShapes': wrong_shapes, 'nonQuantizedLinearModules': skip_modules, 'passed': not missing and not wrong_shapes}
(evidence / 'hidream-civitai-layout-validation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
if not result['passed']:
    raise ValueError('Civitai HiDream checkpoint does not match the published Full transformer configuration')
config['quantization_config']['llm_int8_skip_modules'] = skip_modules
(evidence / 'hidream-civitai-transformer-config.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'expectedTensors': len(expected), 'packedLinearWeights': len(packed), 'unquantizedLinearModules': len(skip_modules)}))
