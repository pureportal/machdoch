import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
cases = json.loads((root / 'flux-2-cases.json').read_text(encoding='utf-8'))
retries = []
for case in cases:
    if case.pop('negativePromptFile', None) is not None:
        case['adaptationPurpose'] = 'Distilled Klein sampling without unsupported negative conditioning.'
        retries.append(case)
if not retries:
    raise ValueError('No incompatible negative conditioning cases found')
cases_path = root / 'flux-2-negative-retry-cases.json'
cases_path.write_text(json.dumps(retries, indent=2), encoding='utf-8')
manifest = root / 'followup-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
name = 'flux-2-negative-retry'
batches = [batch for batch in batches if batch['name'] != name]
batches.append(dict(name=name, template=str(root / 'flux-2-template.json'), cases=str(cases_path), outputRoot=str(root / name)))
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'retryCases': len(retries), 'followupBatches': len(batches)}))
