import json
from pathlib import Path
import urllib.parse
import urllib.request

headers = {'User-Agent': 'machdoch-media-studio/1.0'}
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
if credentials.exists():
    key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey')
    if key:
        headers['Authorization'] = 'Bearer ' + key
results = []
for base in ['SD3.5 Large', 'SD3']:
    url = 'https://civitai.com/api/v1/models?' + urllib.parse.urlencode({'types': 'Checkpoint', 'baseModels': base, 'limit': 100})
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        data = json.load(response)
    results.append({'baseModel': base, 'data': data})
    print(json.dumps({'baseModel': base, 'models': len(data['items']), 'nextPage': bool(data.get('metadata', {}).get('nextPage')), 'turboCandidates': [{'modelId': model['id'], 'name': model['name'], 'versionId': version['id'], 'version': version['name'], 'files': [file['name'] for file in version['files']]} for model in data['items'] for version in model['modelVersions'] if 'turbo' in (model['name'] + version['name'] + ' '.join(file['name'] for file in version['files'])).lower()]}))
Path('docs/validation/image-engines/research-2026-10-13/sd35-large-distributions.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
