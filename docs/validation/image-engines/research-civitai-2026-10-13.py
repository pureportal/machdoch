import json
from pathlib import Path
import urllib.request
import urllib.parse

destination = Path('docs/validation/image-engines/research-2026-10-13/civitai-candidates.json')
results = []
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey') if credentials.exists() else None
headers = {'User-Agent': 'machdoch-media-studio/1.0'}
if key:
    headers['Authorization'] = f'Bearer {key}'
for query in ['Anima', 'Illustrious', 'NoobAI', 'SDXL Turbo', 'SD Turbo', 'HiDream', 'RealVisXL', 'DreamShaper XL', 'Stable Diffusion 3.5 Large Turbo']:
    url = 'https://civitai.com/api/v1/models?' + urllib.parse.urlencode({'query': query, 'types': 'Checkpoint', 'limit': 5})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            data = json.load(response)
        records = [{'id': item['id'], 'name': item['name'], 'creator': item.get('creator', {}).get('username'), 'versions': [{'id': version['id'], 'name': version['name'], 'baseModel': version['baseModel'], 'files': [{'name': file['name'], 'sizeKB': file['sizeKB'], 'hashes': file.get('hashes'), 'downloadUrl': file['downloadUrl']} for file in version['files']]} for version in item['modelVersions'][:2]]} for item in data['items']]
        results.append({'query': query, 'models': records})
        print(json.dumps({'query': query, 'models': [{'id': item['id'], 'name': item['name']} for item in records]}), flush=True)
    except Exception as error:
        results.append({'query': query, 'error': str(error)})
        print(json.dumps({'query': query, 'error': str(error)}), flush=True)
    destination.write_text(json.dumps(results, indent=2), encoding='utf-8')
