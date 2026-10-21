import json
from pathlib import Path
import urllib.request
import urllib.parse

headers = {'User-Agent': 'machdoch-media-studio/1.0'}
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
if credentials.exists():
    key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey')
    if key:
        headers['Authorization'] = f'Bearer {key}'
results = []
for family in ['SD3.5 Large Turbo', 'HiDream']:
    url = 'https://civitai.com/api/v1/models?' + urllib.parse.urlencode({'types': 'Checkpoint', 'baseModels': family, 'limit': 15})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            data = json.load(response)
        results.append({'family': family, 'items': data['items']})
        print(json.dumps({'family': family, 'models': [{'id': item['id'], 'name': item['name'], 'bases': list({version['baseModel'] for version in item['modelVersions']})} for item in data['items']]}), flush=True)
    except Exception as error:
        results.append({'family': family, 'error': str(error)})
        print(json.dumps({'family': family, 'error': str(error)}), flush=True)
Path('docs/validation/image-engines/research-2026-10-13/civitai-filtered-candidates.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
