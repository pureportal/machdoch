import json
from pathlib import Path
import urllib.error
import urllib.request


root = Path('docs/validation/image-engines/research-2026-10-13')
credentials = Path.home() / 'AppData/Roaming/machdoch/civitai.json'
key = json.loads(credentials.read_text(encoding='utf-8')).get('apiKey') if credentials.is_file() else None
records = []
for url in (
    'https://civitai.com/api/v1/model-versions/983611',
    'https://civitai.com/api/v1/model-versions/by-hash/fb64610bf8d73eb064b8d528eef85d062bf2b4b1204ff7bc73e57ad28b24489c',
    'https://civitai.com/api/download/models/983611',
    'https://huggingface.co/api/models/calcuis/sd3.5-large-turbo?blobs=true',
):
    headers = {'User-Agent': 'machdoch-media-verification/1.0'}
    if key and 'civitai.com/' in url:
        headers['Authorization'] = 'Bearer ' + key
    request = urllib.request.Request(url, headers=headers, method='HEAD' if '/download/' in url else 'GET')
    record = {'url': url}
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            record['status'] = response.status
            if request.method == 'GET':
                data = json.load(response)
                if 'sha' in data:
                    record.update(revision=data['sha'], files=data.get('siblings'), gated=data.get('gated'))
                else:
                    record['data'] = data
    except urllib.error.HTTPError as error:
        record['status'] = error.code
    except Exception as error:
        record['errorType'] = type(error).__name__
    records.append(record)
    print(json.dumps({'url': url, 'status': record.get('status'), 'errorType': record.get('errorType')}), flush=True)
root.joinpath('sd35-turbo-direct-distribution-probe.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
