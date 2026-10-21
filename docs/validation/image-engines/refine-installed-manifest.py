import json
from pathlib import Path

root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
previous = Path('D:/Models/machdoch/verification/2026-10-11/image-engines')
audit = json.loads(Path('docs/validation/image-engines/current-checks/raw-beach-audit-current/engine-coverage-audit-current.json').read_text(encoding='utf-8'))
manifest = root / 'installed-engine-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
regressions = []
for architecture, reference in [('z-image-turbo', 145177887), ('qwen-image-2.1-turbo', 144655944), ('krea-2-turbo', 144594528)]:
    coverage = next(c for c in audit['coverage'] if c['architecture'] == architecture)
    record = next(r for r in reversed(coverage['realRuns']) if r.get('qualityVerdict') == 'near-reference' and r.get('passed') and r['referenceId'] == reference)
    request = json.loads((Path(record['directory']) / 'request.json').read_text(encoding='utf-8'))
    request.pop('outputDirectory', None)
    name = architecture + '-accepted-regression'
    prompt, negative = root / f'{name}-prompt.txt', root / f'{name}-negative.txt'
    prompt.write_text(request['prompt'], encoding='utf-8')
    negative.write_text(request.get('negativePrompt', ''), encoding='utf-8')
    case = dict(id=reference, modelName=record['name'], originalPrompt=False, promptFile=str(prompt), negativePromptFile=str(negative), aspectRatio=request['aspectRatio'], seed=request['seed'], sampling=request['sampling'], addons=request.get('addons', []), priorAcceptedImage=record['image'], priorAcceptedImageSha256=record['sha256'])
    template_path, cases_path = root / f'{name}-template.json', root / f'{name}-cases.json'
    template_path.write_text(json.dumps(request, indent=2), encoding='utf-8')
    cases_path.write_text(json.dumps([case], indent=2), encoding='utf-8')
    regressions.append(dict(name=name, template=str(template_path), cases=str(cases_path), outputRoot=str(root / name)))
    batches = [batch for batch in batches if batch['name'] != architecture]

raw_cases = json.loads((previous / 'krea-2-raw-refined-reference-cases.json').read_text(encoding='utf-8'))
raw_cases = [case for case in raw_cases if case['id'] in [144655944, 144697438, 145095967, 145177887]]
raw_path = root / 'krea-2-raw-followup-cases.json'
raw_path.write_text(json.dumps(raw_cases, indent=2), encoding='utf-8')
raw = dict(name='krea-2-raw', template=str(previous / 'krea-2-raw-refined-request-template.json'), cases=str(raw_path), outputRoot=str(root / 'krea-2-raw'))

sd3 = next(batch for batch in batches if batch['name'] == 'stable-diffusion-3')
sd3['cases'] = str(previous / 'stable-diffusion-3-six-reference-cases.json')
batches = regressions + [b for b in batches if b['name'] not in [r['name'] for r in regressions] and b['name'] != 'krea-2-raw'] + [raw]
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'batches': len(batches), 'cases': sum(len(json.loads(Path(b['cases']).read_text(encoding='utf-8'))) for b in batches), 'priorCompleteFamiliesRegressionOnly': len(regressions)}))
