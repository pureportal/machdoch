import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

root = Path('docs/validation/image-engines/research-2026-10-13')
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
civitai_key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey') if credentials.exists() else None
hf_token = os.environ.get('HF_TOKEN')
token_path = Path.home() / '.cache/huggingface/token'
if not hf_token and token_path.is_file():
    hf_token = token_path.read_text(encoding='utf-8').strip()

results = []
urls = [
    ('hidream', 'https://huggingface.co/api/models/HiDream-ai/HiDream-I1-Full?blobs=true'),
    ('juggernaut-xi', 'https://huggingface.co/api/models/RunDiffusion/Juggernaut-XI-v11'),
    ('llama-access', 'https://huggingface.co/meta-llama/Meta-Llama-3.1-8B-Instruct/resolve/main/config.json'),
    ('sd35-turbo-access', 'https://huggingface.co/stabilityai/stable-diffusion-3.5-large-turbo/resolve/main/model_index.json'),
    ('civitai-sd35-turbo', 'https://civitai.com/api/v1/models?' + urllib.parse.urlencode({'query': 'Stable Diffusion 3.5', 'types': 'Checkpoint', 'limit': 100})),
]
for name, url in urls:
    headers = {'User-Agent': 'machdoch-media-studio/1.0'}
    token = civitai_key if 'civitai.com/' in url else hf_token
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            data = json.load(response)
        (root / (name + '-acquisition.json')).write_text(json.dumps(data, indent=2), encoding='utf-8')
        record = {'name': name, 'url': url, 'status': 200}
        if 'items' in data:
            record['models'] = [{'id': item['id'], 'name': item['name'], 'versions': [{'id': v['id'], 'name': v['name'], 'baseModel': v['baseModel']} for v in item['modelVersions']]} for item in data['items']]
        if 'siblings' in data:
            record['revision'] = data['sha']
            record['files'] = len(data['siblings'])
            record['weightBytes'] = sum(f.get('size', 0) for f in data['siblings'] if f['rfilename'].endswith('.safetensors'))
        results.append(record)
    except urllib.error.HTTPError as error:
        results.append({'name': name, 'url': url, 'status': error.code})
    except Exception as error:
        results.append({'name': name, 'errorType': type(error).__name__})
    print(json.dumps(results[-1]), flush=True)
(root / 'remaining-acquisition-status.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
