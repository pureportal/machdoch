import json
from pathlib import Path


root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
previous = Path('D:/Models/machdoch/verification/2026-10-11/image-engines')
addons = json.loads((previous / 'additional-style-addons.json').read_text(encoding='utf-8'))
styles = {addon['digest']: addon for addon in addons if addon['architecture'] == 'stable-diffusion-1'}
cases_path = root / 'dreamshaper-8-followup-cases.json'
cases = json.loads(cases_path.read_text(encoding='utf-8'))
for case in cases:
    if case['id'] == 144655944:
        addon = next(addon for digest, addon in styles.items() if digest.startswith('53de8574'))
        addon['modelStrength'] = 0.5
        case['addons'] = [addon]
        prompt = root / 'dreamshaper-8-niji-portrait.txt'
        prompt.write_text('niji, red-haired adult woman, amber eyes, white shirt, black necktie, hand reaching towards viewer, dark doorway, dramatic golden backlight, detailed painterly shading', encoding='utf-8')
        case['promptFile'] = str(prompt)
    elif case['id'] == 144697438:
        addon = next(addon for digest, addon in styles.items() if digest.startswith('3fb6a3c0'))
        addon['modelStrength'] = 0.6
        case['addons'] = [addon]
        prompt = root / 'dreamshaper-8-2b-ruins.txt'
        prompt.write_text('yorha no. 2 type b, white bob hair, blindfold, black dress, side profile on right, two rusty robots on left, overgrown city ruins, colored concentric circles, textured oil painting', encoding='utf-8')
        case['promptFile'] = str(prompt)
cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
print(json.dumps({'finetunedStyleCases': 2}))
