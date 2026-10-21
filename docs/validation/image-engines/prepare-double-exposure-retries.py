import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
previous = Path('D:/Models/machdoch/verification/2026-10-11/image-engines')
imported = json.loads((previous / 'sdxl-double-exposure-native-import/native-imports.json').read_text(encoding='utf-8'))[0]
model = imported['imported']
inspection = imported['inspection']
addon = dict(kind='lora', enabled=True, addonId=model['addonId'], digest=model['digest'], path=str(Path('D:/Models/machdoch') / model['targetLabel']), architecture=model['architecture'], targetComponents=inspection['targetComponents'], loraProfile=inspection['loraProfile'], modelStrength=0.8, triggerWords=['Double Exposure style of'])
prompt = root / 'double-exposure-xl-refinement.txt'
prompt.write_text('Double Exposure style of, adult woman facing viewer with arms raised overhead, Alpine valley and winding road visible inside her torso silhouette, thin white blouse outlines, blue jeans, pink sunset sky, detailed photographic collage', encoding='utf-8')
manifest = root / 'followup-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
for architecture in ('stable-diffusion-xl', 'illustrious-xl', 'noobai-xl', 'realvis-xl', 'dreamshaper-xl'):
    case = next(case for case in json.loads((root / f'{architecture}-cases.json').read_text(encoding='utf-8')) if case['id'] == 145095967)
    case.update(promptFile=str(prompt), addons=[addon], adaptationPurpose='Compatible Double Exposure XL LoRA for the transparent torso and photographic collage aesthetic.')
    name = architecture + '-double-exposure'
    cases_path = root / f'{name}-cases.json'
    cases_path.write_text(json.dumps([case], indent=2), encoding='utf-8')
    batches = [batch for batch in batches if batch['name'] != name]
    batches.append(dict(name=name, template=str(root / f'{architecture}-template.json'), cases=str(cases_path), outputRoot=str(root / name)))
juggernaut = root / 'juggernaut-xl-cases.json'
cases = json.loads(juggernaut.read_text(encoding='utf-8'))
for case in cases:
    if case['id'] == 145095967:
        case.update(promptFile=str(prompt), addons=[addon], adaptationPurpose='Compatible Double Exposure XL LoRA for the transparent torso and photographic collage aesthetic.')
juggernaut.write_text(json.dumps(cases, indent=2), encoding='utf-8')
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'collageRefinements': 6, 'followupBatches': len(batches)}))
