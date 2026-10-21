import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
previous = Path('D:/Models/machdoch/verification/2026-10-11/image-engines')
addon = next(addon for addon in json.loads((previous / 'sdxl-style-addons.json').read_text(encoding='utf-8')) if addon['architecture'] == 'pony')
addon['modelStrength'] = 0.35
prompts = {
    144655944: 'score_9, score_8_up, score_7_up, source_anime, ncpy43 style, makima, amber eyes, white shirt, black tie, reaching towards viewer, foreshortening, golden backlight, dark doorway, painted shadows',
    144697438: 'score_9, score_8_up, score_7_up, source_anime, ncpy43 style, 2b (nier automata) on right, two rusty robots on left, overgrown city ruins, concentric colorful circles, textured oil painting',
    145177887: 'score_9, score_8_up, score_7_up, ncpy43 style, fully clothed child in ruffled white dress, holding teddy bear, black room, shadowed face, dimly lit wooden floor, horror, tall composition',
}
cases = json.loads((root / 'pony-cases.json').read_text(encoding='utf-8'))
cases = [case for case in cases if case['id'] in prompts]
negative = root / 'pony-style-negative.txt'
negative.write_text('score_4, score_5, score_6, source_furry, source_pony, watermark, extra limbs, malformed hands', encoding='utf-8')
for case in cases:
    prompt = root / f"pony-style-prompt-{case['id']}.txt"
    prompt.write_text(prompts[case['id']], encoding='utf-8')
    case.update(promptFile=str(prompt), negativePromptFile=str(negative), addons=[addon], adaptationPurpose='Concise subject conditioning and compatible watercolor LoRA for painterly depth.')
    case['sampling'].update(numInferenceSteps=25, guidanceScale=7)
cases_path = root / 'pony-style-retry-cases.json'
cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
manifest = root / 'followup-reference-batches.json'
name = 'pony-style-retry'
batches = [batch for batch in json.loads(manifest.read_text(encoding='utf-8')) if batch['name'] != name]
batches.append(dict(name=name, template=str(root / 'pony-template.json'), cases=str(cases_path), outputRoot=str(root / name)))
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'retryCases': len(cases), 'followupBatches': len(batches)}))
