from collections import Counter
import json
from pathlib import Path
import struct
import urllib.parse
import urllib.request


root = Path('docs/validation/image-engines/research-2026-10-13')


class DownloadRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, response_headers, new_url):
        redirected = super().redirect_request(request, file_pointer, code, message, response_headers, new_url)
        if urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(new_url).netloc:
            redirected.remove_header('Authorization')
        return redirected


model = json.loads(root.joinpath('flux-nf4-civitai-638187.json').read_text(encoding='utf-8'))
version = next(version for version in model['modelVersions'] if version['id'] == 721627)
file = next(file for file in version['files'] if file['type'] == 'Model')
headers = {'User-Agent': 'machdoch-media-verification/1.0', 'Range': 'bytes=0-4194303'}
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
if credentials.is_file():
    key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey')
    if key:
        headers['Authorization'] = 'Bearer ' + key
with urllib.request.build_opener(DownloadRedirect()).open(urllib.request.Request(file['downloadUrl'], headers=headers), timeout=30) as response:
    length = struct.unpack('<Q', response.read(8))[0]
    if length > 4 * 1024 * 1024:
        raise ValueError('Header exceeds the bounded probe')
    header = json.loads(response.read(length))
root.joinpath('flux-dev-nf4-civitai-full-header.json').write_text(json.dumps(header), encoding='utf-8')
tensors = {name: value for name, value in header.items() if name != '__metadata__'}
summary = dict(modelId=model['id'], versionId=version['id'], sha256=file['hashes']['SHA256'], headerBytes=length, tensors=len(tensors), dtypes=dict(Counter(tensor['dtype'] for tensor in tensors.values())), prefixes=dict(Counter(name.split('.')[0] for name in tensors)), sampleKeys=list(tensors)[:12], quantizationKeys=[name for name in tensors if 'quant_state' in name][:8])
root.joinpath('flux-dev-nf4-civitai-header-summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary))
