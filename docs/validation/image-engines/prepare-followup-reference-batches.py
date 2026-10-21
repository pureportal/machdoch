import json
from pathlib import Path
import sqlite3

storage = Path('D:/Models/machdoch')
root = storage / 'verification/2026-10-13/image-engines'
profile = next(p for p in json.loads(Path('apps/client/src-tauri/python/open_media_models.json').read_text(encoding='utf-8')) if p['architecture'] == 'juggernaut-xl')
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    model = dict(db.execute("SELECT m.id,m.architecture,m.display_name,i.relative_path,i.revision,i.manifest_digest FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed' AND m.architecture='juggernaut-xl'").fetchone())
template = json.loads((root / 'realvis-xl-template.json').read_text(encoding='utf-8'))
package = storage / 'models' / model['relative_path']
template['model'] = dict(id=model['id'], architecture=model['architecture'], packageKind='single-file', path=str(package / 'checkpoint.safetensors'), configPath=str(package / 'config'), revision=model['revision'], digest=model['manifest_digest'])
template['sampling'] = dict(sampler='dpmpp-2m-karras', numInferenceSteps=profile['steps'], guidanceScale=profile['guidance'])
cases = json.loads((root / 'realvis-xl-cases.json').read_text(encoding='utf-8'))
for case in cases:
    case['modelName'] = model['display_name']
    case['sampling'].update(template['sampling'])
template_path, cases_path = root / 'juggernaut-xl-template.json', root / 'juggernaut-xl-cases.json'
template_path.write_text(json.dumps(template, indent=2), encoding='utf-8')
cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
batches = [dict(name='juggernaut-xl', template=str(template_path), cases=str(cases_path), outputRoot=str(root / 'juggernaut-xl'))]
refinements = {
    145095967: ('Photographic double exposure collage, front view of one adult woman with shoulder-length dark hair and visible downturned face, arms raised overhead. Her translucent torso reveals a sharp Alpine valley and a winding road. Thin white line drawing of a button-up blouse over the transparent landscape, blue jeans and brown belt. Pink cloudy sunset, dark mountain valley, fine fabric and landscape detail.', 'back view, faceless, solid black silhouette, opaque torso, multiple people, flat illustration, plain background, extra arms'),
    145177887: ('Full-length horror photograph of one fully clothed child standing centered and filling most of the frame, white long-sleeved ruffled dress, white stockings and black shoes. Long black hair hides her face. She holds a worn teddy bear at her side. Dim overhead light illuminates her dress and worn wooden floorboards; the room behind her is almost black. Fine photographic cloth texture, desaturated.', 'small distant figure, extra eyes in background, multiple people, cartoon, anime, bright room, picture frame, text, watermark'),
    144599398: ('Photographic medium shot of one adult woman seated sideways on weathered cream stone steps beside a white seaside wall. Brown ponytail, head turned toward camera, one bent knee and one hand resting on stone. Pink and white chevron two-piece swimsuit with coral straps. Soft warm afternoon sunlight, neutral skin color, detailed pores and subtle film grain.', 'black border, photo frame, orange color cast, illustration, doll, malformed hands, text, watermark'),
}
cases = [case for case in json.loads((root / 'anima-cases.json').read_text(encoding='utf-8')) if case['id'] in refinements]
for case in cases:
    prompt, negative = refinements[case['id']]
    prompt_path, negative_path = root / f"anima-refined-{case['id']}.txt", root / f"anima-refined-negative-{case['id']}.txt"
    prompt_path.write_text(prompt, encoding='utf-8')
    negative_path.write_text(negative, encoding='utf-8')
    case.update(promptFile=str(prompt_path), negativePromptFile=str(negative_path))
    case['sampling'].update(numInferenceSteps=50, guidanceScale=4.5)
refined_path = root / 'anima-refined-cases.json'
refined_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
batches.append(dict(name='anima-refinement', template=str(root / 'anima-template.json'), cases=str(refined_path), outputRoot=str(root / 'anima-refinement')))
(root / 'followup-reference-batches.json').write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'batches': len(batches), 'cases': sum(len(json.loads(Path(batch['cases']).read_text(encoding='utf-8'))) for batch in batches)}))
