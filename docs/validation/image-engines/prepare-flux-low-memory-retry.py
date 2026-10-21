import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
cases = json.loads((root / 'flux-1-dev-cases.json').read_text(encoding='utf-8'))
for case in cases:
    case.pop('negativePromptFile', None)
    case['modelName'] = 'FLUX.1 Dev NF4 runtime · Black Forest Labs'
cases_path = root / 'flux-1-dev-nf4-cases.json'
cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
smoke = [{**cases[0], 'sampling': {**cases[0]['sampling'], 'width': 256, 'height': 256, 'numInferenceSteps': 1}}]
smoke_path = root / 'flux-1-dev-nf4-smoke-cases.json'
smoke_path.write_text(json.dumps(smoke, indent=2), encoding='utf-8')
batches = [dict(name='flux-1-dev-nf4-smoke', template=str(root / 'flux-1-dev-template.json'), cases=str(smoke_path), outputRoot=str(root / 'flux-1-dev-nf4-smoke'))]
(root / 'flux-nf4-smoke-batches.json').write_text(json.dumps(batches, indent=2), encoding='utf-8')
remaining = json.loads((root / 'installed-engine-reference-batches.json').read_text(encoding='utf-8'))
remaining = [batch for batch in remaining if batch['name'] in {'z-image', 'qwen-image', 'krea-2', 'qwen-image-2.1', 'krea-2-raw'}]
remaining.insert(0, dict(name='flux-1-dev-nf4', template=str(root / 'flux-1-dev-template.json'), cases=str(cases_path), outputRoot=str(root / 'flux-1-dev-nf4')))
(root / 'remaining-reference-batches.json').write_text(json.dumps(remaining, indent=2), encoding='utf-8')
print(json.dumps({'remainingBatches': len(remaining), 'smokeIsQualityEvidence': False}))
