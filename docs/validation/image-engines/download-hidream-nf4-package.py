import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.request

evidence = Path('docs/validation/image-engines/research-2026-10-13')
storage = Path('D:/Models/machdoch/downloads')
package = storage / 'hidream-nf4-prepared'
candidate = json.loads((evidence / 'szwagros--HiDream-I1-Full-4bit-candidate.json').read_text(encoding='utf-8'))
candidates = json.loads((evidence / 'civitai-filtered-candidates.json').read_text(encoding='utf-8'))
model = next(model for row in candidates if row['family'] == 'HiDream' for model in row['items'] if model['id'] == 1457126)
version = next(version for version in model['modelVersions'] if version['id'] == 1647676)
checkpoint = next(file for file in version['files'] if file['type'] == 'Model')
headers = {'User-Agent': 'machdoch-media-studio/1.0'}
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
if credentials.exists():
    key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey')
    if key:
        headers['Authorization'] = 'Bearer ' + key
records = []

def acquire(url, target, byte_size, expected_digest, request_headers):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        with target.open('rb') as file:
            digest = hashlib.file_digest(file, 'sha256').hexdigest()
        if target.stat().st_size == byte_size and (expected_digest is None or digest == expected_digest.lower()):
            return digest
        raise ValueError('Existing download differs from its published digest: ' + target.name)
    partial = target.with_suffix(target.suffix + '.partial')
    count = partial.stat().st_size if partial.exists() else 0
    hasher = hashlib.sha256()
    if count:
        with partial.open('rb') as file:
            while block := file.read(4 * 1024 * 1024):
                hasher.update(block)
    download_headers = dict(request_headers)
    if count:
        download_headers['Range'] = f'bytes={count}-'
    last_progress = time.monotonic()
    with urllib.request.urlopen(urllib.request.Request(url, headers=download_headers), timeout=120) as response:
        if count and response.status != 206:
            raise ValueError('Server did not resume the requested range: ' + target.name)
        with partial.open('ab' if count else 'wb') as file:
            while block := response.read(4 * 1024 * 1024):
                file.write(block)
                hasher.update(block)
                count += len(block)
                if time.monotonic() - last_progress >= 20:
                    print(json.dumps({'file': target.name, 'downloadedBytes': count, 'totalBytes': byte_size}), flush=True)
                    last_progress = time.monotonic()
    digest = hasher.hexdigest()
    if count != byte_size or (expected_digest is not None and digest != expected_digest.lower()):
        raise ValueError('Download failed published size/digest verification: ' + target.name)
    partial.replace(target)
    return digest

checkpoint_path = storage / 'civitai/1457126/1647676' / checkpoint['name']
required = int(checkpoint['sizeKB'] * 1024) + sum(file.get('size', 0) for file in candidate['siblings'] if not file['rfilename'].startswith('transformer/') and file['rfilename'] != '.gitattributes')
if shutil.disk_usage(storage).free < required * 1.1:
    raise ValueError('The model volume cannot hold the prepared package')
digest = acquire(checkpoint['downloadUrl'], checkpoint_path, round(checkpoint['sizeKB'] * 1024), checkpoint['hashes']['SHA256'], headers)
records.append({'source': f"https://civitai.com/models/{model['id']}?modelVersionId={version['id']}", 'path': str(checkpoint_path), 'sha256': digest})
print(json.dumps({'verified': checkpoint_path.name, 'sha256': digest}), flush=True)
for file in candidate['siblings']:
    name = file['rfilename']
    if name == '.gitattributes' or name.startswith('transformer/'):
        continue
    target = package / name
    url = f"https://huggingface.co/{candidate['id']}/resolve/{candidate['sha']}/{name}"
    digest = acquire(url, target, file['size'], file.get('lfs', {}).get('sha256'), {'User-Agent': headers['User-Agent']})
    records.append({'source': url, 'path': str(target), 'sha256': digest})
    (evidence / 'hidream-package-download-provenance.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
    print(json.dumps({'verified': name, 'sha256': digest}), flush=True)
transformer = package / 'transformer'
transformer.mkdir(exist_ok=True)
linked = transformer / 'diffusion_pytorch_model.safetensors'
if not linked.exists():
    os.link(checkpoint_path, linked)
shutil.copy2(evidence / 'hidream-civitai-transformer-config.json', transformer / 'config.json')
tokenizer = package / 'tokenizer_4'
tokenizer.mkdir(exist_ok=True)
for name in ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']:
    shutil.copy2(package / 'text_encoder_4' / name, tokenizer / name)
licences = {
    'LICENSE-HiDream.txt': 'https://raw.githubusercontent.com/HiDream-ai/HiDream-I1/main/LICENSE',
    'LICENSE-Llama-3.1.txt': 'https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama3_1/LICENSE',
}
for name, url in licences.items():
    with urllib.request.urlopen(url, timeout=30) as response:
        (package / name).write_bytes(response.read())
(package / 'NOTICE.txt').write_text('HiDream-I1 is by HiDream.ai. NF4 checkpoint conversion is by hykilpikonna. Quantized companion layout is by szwagros. Llama 3.1 is licensed under the Llama 3.1 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. Built with Llama.\nThe Civitai checkpoint weights are unchanged; the package is assembled for the Diffusers file layout.\n', encoding='utf-8')
print(json.dumps({'prepared': str(package), 'files': len(records)}), flush=True)
