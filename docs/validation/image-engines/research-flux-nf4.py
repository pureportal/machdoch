import json
from pathlib import Path
import urllib.error
import urllib.request


root = Path('docs/validation/image-engines/research-2026-10-13')
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey') if credentials.is_file() else None
for model_id in (638187, 630820):
    url = f'https://civitai.com/api/v1/models/{model_id}'
    headers = {'User-Agent': 'machdoch-image-verification/1.0'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            data = json.load(response)
        root.joinpath(f'flux-nf4-civitai-{model_id}.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
        print(json.dumps({'id': model_id, 'name': data['name'], 'versions': [{'id': version['id'], 'name': version['name'], 'baseModel': version['baseModel'], 'files': [{'name': file['name'], 'sizeKB': file['sizeKB'], 'sha256': file.get('hashes', {}).get('SHA256')} for file in version.get('files', [])]} for version in data['modelVersions']]}), flush=True)
    except urllib.error.HTTPError as error:
        print(json.dumps({'id': model_id, 'status': error.code}), flush=True)
