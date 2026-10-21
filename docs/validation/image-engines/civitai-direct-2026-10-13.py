import json
from pathlib import Path
import urllib.request

destination = Path('docs/validation/image-engines/research-2026-10-13')
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey') if credentials.exists() else None
headers = {'User-Agent': 'machdoch-media-studio/1.0'}
if key:
    headers['Authorization'] = f'Bearer {key}'
for model_id in [2458426, 833294, 139562, 112902, 878645]:
    try:
        with urllib.request.urlopen(urllib.request.Request(f'https://civitai.com/api/v1/models/{model_id}', headers=headers), timeout=30) as response:
            model = json.load(response)
        (destination / f'civitai-model-{model_id}.json').write_text(json.dumps(model, indent=2), encoding='utf-8')
        print(json.dumps({'id': model_id, 'name': model['name'], 'versions': [{'id': version['id'], 'name': version['name'], 'files': [file['name'] for file in version['files']]} for version in model['modelVersions']]}), flush=True)
    except Exception as error:
        print(json.dumps({'id': model_id, 'error': str(error)}), flush=True)
