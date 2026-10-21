from collections import Counter
import json
from pathlib import Path
import struct
import urllib.request

source = Path('docs/validation/image-engines/research-2026-10-13/civitai-filtered-candidates.json')
models = next(row['items'] for row in json.loads(source.read_text(encoding='utf-8')) if row['family'] == 'HiDream')
model = next(model for model in models if model['id'] == 1457126)
version = next(version for version in model['modelVersions'] if version['id'] == 1647676)
file = next(file for file in version['files'] if file['type'] == 'Model')
headers = {'User-Agent': 'machdoch-media-studio/1.0', 'Range': 'bytes=0-4194303'}
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
if credentials.exists():
    key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey')
    if key:
        headers['Authorization'] = 'Bearer ' + key
request = urllib.request.Request(file['downloadUrl'], headers=headers)
with urllib.request.urlopen(request, timeout=30) as response:
    length = struct.unpack('<Q', response.read(8))[0]
    if length > 4 * 1024 * 1024:
        raise ValueError('Header exceeds the bounded probe')
    header = json.loads(response.read(length))
tensors = {name: value for name, value in header.items() if name != '__metadata__'}
result = {'modelId': model['id'], 'versionId': version['id'], 'fileName': file['name'], 'publisherSha256': file['hashes']['SHA256'], 'headerBytes': length, 'tensors': len(tensors), 'dtypes': dict(Counter(tensor['dtype'] for tensor in tensors.values())), 'sampleKeys': list(tensors)[:20], 'quantizationKeys': [key for key in tensors if 'quant_state' in key or 'quant_map' in key][:20]}
Path('docs/validation/image-engines/research-2026-10-13/hidream-civitai-nf4-header.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
