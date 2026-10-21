import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
previous = Path('D:/Models/machdoch/verification/2026-10-11/image-engines')
addons = json.loads((previous / 'sdxl-style-addons.json').read_text(encoding='utf-8'))
addon = next(addon for addon in addons if addon['digest'].startswith('8e001761'))
addon['modelStrength'] = 0.4
prompts = {
    144655944: '1woman, makima (chainsaw man), reaching towards viewer, foreshortening, white shirt, black tie, dark doorway, amber eyes, oil painting, chiaroscuro, golden backlight, detailed shading, masterpiece, best quality',
    144697438: '2b (nier automata), side profile on right, two rusty robots on left, overgrown ruined city, colored concentric glitch circles, oil painting, chaotic brushwork, dramatic chiaroscuro, masterpiece, best quality',
}
manifest = root / 'followup-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
for architecture in ('illustrious-xl', 'noobai-xl'):
    cases = json.loads((root / f'{architecture}-cases.json').read_text(encoding='utf-8'))
    cases = [case for case in cases if case['id'] in prompts]
    for case in cases:
        prompt = root / f"{architecture}-style-prompt-{case['id']}.txt"
        prompt.write_text(prompts[case['id']], encoding='utf-8')
        case.update(promptFile=str(prompt), negativePromptFile=str(root / f'{architecture}-refined-negative.txt'), addons=[addon], adaptationPurpose='Concise compositional tags and compatible Niji XL LoRA for painterly detail.')
    name = architecture + '-style-retry'
    cases_path = root / f'{name}-cases.json'
    cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    batches = [batch for batch in batches if batch['name'] != name]
    batches.append(dict(name=name, template=str(root / f'{architecture}-template.json'), cases=str(cases_path), outputRoot=str(root / name)))
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'styleRetryCases': 4, 'followupBatches': len(batches)}))
