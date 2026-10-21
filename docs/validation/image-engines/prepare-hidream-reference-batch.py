import json
from pathlib import Path
import sqlite3

storage = Path('D:/Models/machdoch')
root = storage / 'verification/2026-10-13/image-engines'
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT m.id,m.display_name,i.relative_path,i.revision,i.manifest_digest FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed' AND m.architecture='hidream-i1-full'").fetchone()
    if row is None:
        raise ValueError('HiDream native import is not complete')
    model = dict(row)
package = storage / 'models' / model['relative_path']
template = json.loads((root / 'anima-template.json').read_text(encoding='utf-8'))
template['model'] = dict(id=model['id'], architecture='hidream-i1-full', packageKind='diffusers-directory', path=str(package), configPath=None, revision=model['revision'], digest=model['manifest_digest'])
template['sampling'] = dict(sampler='unipc', numInferenceSteps=50, guidanceScale=5)
cases = json.loads((root / 'anima-cases.json').read_text(encoding='utf-8'))
for case in cases:
    case['modelName'] = model['display_name']
    case['sampling'].update(template['sampling'])
    case['promptFile'] = str(root / f"sd-turbo-concise-{case['id']}.txt")
template_path, cases_path = root / 'hidream-i1-full-template.json', root / 'hidream-i1-full-cases.json'
template_path.write_text(json.dumps(template, indent=2), encoding='utf-8')
cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
smoke = [{**cases[0], 'sampling': {**template['sampling'], 'width': 256, 'height': 256, 'numInferenceSteps': 1}}]
smoke_path = root / 'hidream-i1-full-smoke-cases.json'
smoke_path.write_text(json.dumps(smoke, indent=2), encoding='utf-8')
batches = [dict(name='hidream-smoke', template=str(template_path), cases=str(smoke_path), outputRoot=str(root / 'hidream-smoke')), dict(name='hidream-i1-full', template=str(template_path), cases=str(cases_path), outputRoot=str(root / 'hidream-i1-full'))]
(root / 'hidream-reference-batches.json').write_text(json.dumps(batches, indent=2), encoding='utf-8')
(root / 'hidream-smoke-batches.json').write_text(json.dumps(batches[:1], indent=2), encoding='utf-8')
(root / 'hidream-full-reference-batches.json').write_text(json.dumps(batches[1:], indent=2), encoding='utf-8')
print(json.dumps({'modelId': model['id'], 'cases': 7, 'smokeIsQualityEvidence': False}))
