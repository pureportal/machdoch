import json
from pathlib import Path
import sqlite3

storage = Path('D:/Models/machdoch')
root = storage / 'verification/2026-10-13/image-engines'
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    models = [dict(row) for row in db.execute("SELECT m.id,m.architecture,m.display_name,i.relative_path,i.revision,i.manifest_digest FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed'")]
manifest = root / 'followup-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
for prefix, name, references, steps, guidance in [
    ('dreamshaper-8', 'DreamShaper 8', None, 30, 7),
    ('animagine-4', 'Animagine XL 4.0', [144655944, 144697438, 145177887], 28, 5),
]:
    model = next(model for model in models if model['display_name'].startswith(name))
    package = storage / 'models' / model['relative_path']
    template = json.loads((root / 'stable-diffusion-1-template.json').read_text(encoding='utf-8'))
    template['model'] = dict(id=model['id'], architecture=model['architecture'], packageKind='single-file', path=str(package / 'checkpoint.safetensors'), configPath=str(package / 'config'), revision=model['revision'], digest=model['manifest_digest'])
    template['sampling'] = dict(sampler='dpmpp-2m-karras' if prefix == 'dreamshaper-8' else 'euler-ancestral', numInferenceSteps=steps, guidanceScale=guidance)
    cases = json.loads((root / ('stable-diffusion-1-cases.json' if prefix == 'dreamshaper-8' else 'stable-diffusion-xl-cases.json')).read_text(encoding='utf-8'))
    cases = [case for case in cases if references is None or case['id'] in references]
    for case in cases:
        case['modelName'] = model['display_name']
        case['sampling'].update(template['sampling'])
        case['promptFile'] = str(root / f"sd-turbo-concise-{case['id']}.txt")
    template_path, cases_path = root / f'{prefix}-followup-template.json', root / f'{prefix}-followup-cases.json'
    template_path.write_text(json.dumps(template, indent=2), encoding='utf-8')
    cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    batches = [batch for batch in batches if batch['name'] != prefix]
    batches.append(dict(name=prefix, template=str(template_path), cases=str(cases_path), outputRoot=str(root / prefix)))
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'followupBatches': len(batches)}))
