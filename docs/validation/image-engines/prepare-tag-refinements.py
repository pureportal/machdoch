import json
from pathlib import Path

root = Path('D:/Models/machdoch/verification/2026-10-13/image-engines')
prompts = {
    144655944: '1woman, adult, solo, red hair, amber eyes, white collared shirt, black necktie, leaning forward, reaching towards viewer, open hand in foreground, black nails, foreshortening, fisheye perspective, dark doorway, golden backlight, deep shadows, cinematic light, painterly, detailed fabric folds',
    144697438: '2robots, round rusty robots on left, 1woman on right, 2b (nier automata), white bob hair, blindfold, black dress, side view, looking left, ruined city, overgrown ruins, abandoned machinery, tall grass, concentric colorful circles in sky, glitch art, oil painting, impasto, brush strokes, chiaroscuro, teal, ochre, magenta, wide shot',
    144594528: 'photograph, adult woman, solo, black ponytail, smiling, looking at viewer, leaning forward, walking towards viewer, light blue off shoulder blouse, flowing white skirt, white sneakers, wind, watercolor flower graffiti on concrete wall, sunlit street, shallow depth of field, natural skin texture',
    145095967: 'double exposure, solo adult woman, black shoulder length hair, head tilted down, arms raised overhead, blue jeans, brown belt, transparent blouse outlined in thin white lines, Alpine landscape visible through torso, winding road inside silhouette, pink sunset sky, photographic collage, surreal, intricate landscape detail',
    144599398: 'photograph, adult woman, solo, seated sideways, head turned towards viewer, one knee bent, brown ponytail, pink and white chevron two piece swimsuit, coral straps, weathered cream stone steps, white wall, seaside, warm sunlight, natural skin texture, subtle film grain, fashion editorial',
    145177887: 'solo, child, fully clothed, long black hair, white long sleeved ruffled dress, white stockings, black shoes, holding teddy bear, standing facing viewer, extremely dark room, deep black background, dim overhead spotlight on wooden floorboards, face concealed in shadow, horror photograph, desaturated, detailed fabric',
}
negative = 'worst quality, low quality, lowres, bad anatomy, bad hands, extra limbs, extra fingers, duplicate people, multiple views, watermark, signature, text'
manifest = root / 'installed-engine-reference-batches.json'
batches = json.loads(manifest.read_text(encoding='utf-8'))
refined = []
for architecture in ['illustrious-xl', 'noobai-xl']:
    cases = json.loads((root / f'{architecture}-cases.json').read_text(encoding='utf-8'))
    for case in cases:
        path = root / f"{architecture}-tags-{case['id']}.txt"
        prefix = 'masterpiece, best quality, newest, highres, ' if architecture == 'noobai-xl' else 'masterpiece, best quality, '
        path.write_text(prefix + prompts[case['id']], encoding='utf-8')
        negative_path = root / f'{architecture}-refined-negative.txt'
        negative_path.write_text(negative, encoding='utf-8')
        case['promptFile'] = str(path)
        case['negativePromptFile'] = str(negative_path)
        case['adaptationPurpose'] = 'Publisher tag prompting; restore missing subjects, lighting and transparent collage.'
    cases_path = root / f'{architecture}-tag-cases.json'
    cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    refined.append(dict(name=architecture + '-tag-refinement', template=str(root / f'{architecture}-template.json'), cases=str(cases_path), outputRoot=str(root / (architecture + '-tag-refinement'))))
manifest.write_text(json.dumps(refined + [b for b in batches if not b['name'].endswith('-tag-refinement')], indent=2), encoding='utf-8')
print(json.dumps({'refinementCases': 12, 'totalBatches': len(refined + batches)}))
