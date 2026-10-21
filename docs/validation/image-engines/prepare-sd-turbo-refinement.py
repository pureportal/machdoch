import json
from pathlib import Path

root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
prompts = {
    144655944: 'Detailed anime painting, adult red-haired woman with amber eyes, white collared shirt and black tie, leaning through a dark doorway, open hand reaching toward viewer, fisheye perspective, golden backlight.',
    144697438: 'Textured oil painting, two rusty round-headed robots on left, white-haired blindfolded woman in black dress on right, ruined overgrown city, concentric colored glitch circles in sky, teal and ochre.',
    144594528: 'Candid photograph, smiling adult Japanese woman moving beside colorful flower graffiti, blue off-shoulder blouse, flowing white skirt, white sneakers, windblown dark hair, natural daylight, realistic skin texture.',
    145095967: 'Photographic double exposure, one adult woman facing camera with arms raised, transparent blouse outlined in white, Alpine valley and winding road visible through torso, blue jeans, pink sunset.',
    144599398: 'Editorial photograph, adult woman seated sideways on cream stone steps, brown ponytail, pink chevron two-piece swimsuit, looking at camera, warm sunlight, detailed natural skin.',
    145177887: 'Horror photograph, fully clothed child standing with teddy bear, white long-sleeved dress, stockings and black shoes, long hair hiding face, black room, dim light on wooden floorboards.',
}
cases = json.loads((root / 'sd-turbo-cases.json').read_text(encoding='utf-8'))
for case in cases:
    path = root / f"sd-turbo-concise-{case['id']}.txt"
    path.write_text(prompts[case['id']], encoding='utf-8')
    case.update(promptFile=str(path), aspectRatio='1:1', adaptationPurpose='Published 512-square working canvas and concise CLIP conditioning.')
    case['sampling'].update(width=512, height=512, numInferenceSteps=4)
    case.pop('negativePromptFile', None)
street = next(case for case in cases if case['id'] == 144594528)
cases.append({**street, 'sampling': {**street['sampling'], 'numInferenceSteps': 1}})
path = root / 'sd-turbo-concise-square-cases.json'
path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
manifest = root / 'followup-reference-batches.json'
batches = [batch for batch in json.loads(manifest.read_text(encoding='utf-8')) if batch['name'] != 'sd-turbo-concise-square']
batches.append(dict(name='sd-turbo-concise-square', template=str(root / 'sd-turbo-template.json'), cases=str(path), outputRoot=str(root / 'sd-turbo-concise-square')))
manifest.write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'refinementCases': len(cases)}))
