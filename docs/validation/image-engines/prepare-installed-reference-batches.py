import json
from pathlib import Path
import sqlite3

storage = Path('D:/Models/machdoch')
root = storage / 'verification/2026-10-13/image-engines'
previous = storage / 'verification/2026-10-11/image-engines'
references = json.loads((previous / 'six-reference-adapted-generation-cases.json').read_text(encoding='utf-8'))
sampling = {p['architecture']: p for p in json.loads(Path('apps/client/src-tauri/python/image_sampling_profiles.json').read_text(encoding='utf-8'))}
profiles = {p['architecture']: p for p in json.loads(Path('apps/client/src-tauri/python/open_media_models.json').read_text(encoding='utf-8'))}
architectures = ['stable-diffusion-xl', 'stable-diffusion-1', 'pony', 'flux-2', 'flux-1-schnell', 'flux-1-dev', 'stable-diffusion-3', 'z-image', 'qwen-image', 'krea-2', 'krea-2-turbo', 'qwen-image-2.1', 'qwen-image-2.1-turbo', 'z-image-turbo']
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    models = [dict(r) for r in db.execute("SELECT m.id,m.architecture,m.display_name,i.relative_path,i.revision,i.manifest_digest FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed' AND m.id LIKE 'local:user:%'")]
batches = []
for architecture in architectures:
    options = [m for m in models if m['architecture'] == architecture]
    if architecture == 'pony':
        options = [m for m in options if 'Diffusion V6' in m['display_name']]
    if architecture == 'stable-diffusion-1':
        options = [m for m in options if m['display_name'] == 'Stable Diffusion 1.5']
    if architecture == 'stable-diffusion-xl':
        options = [m for m in options if m['display_name'] == 'Stable Diffusion XL 1.0 Base']
    if architecture == 'krea-2-turbo':
        options = [m for m in options if 'Official' in m['display_name']]
    model = options[0]
    package = storage / 'models' / model['relative_path']
    single = (package / 'checkpoint.safetensors').is_file()
    recipe = sampling[architecture]
    defaults = profiles.get(architecture, {})
    chosen = dict(sampler=recipe['recommendedSamplers'][0], numInferenceSteps=defaults.get('steps', sum(recipe['steps']) // 2), guidanceScale=defaults.get('guidance', recipe['defaultGuidance']))
    template = dict(schemaVersion=5, model=dict(id=model['id'], architecture=architecture, packageKind='single-file' if single else 'diffusers-directory', path=str(package / 'checkpoint.safetensors' if single else package), configPath=str(package / 'config') if single else None, revision=model['revision'], digest=model['manifest_digest']), prompt='', negativePrompt='', outputCount=1, outputFormat='png', modelPolicy='quality', aspectRatio='1:1', seed=41791, addons=[], referenceImages=[], memoryProfile='auto', modelCacheDirectory=str(storage / 'cache/image-models'), sampling=chosen)
    cases = []
    for ref in references:
        width, height = ref['width'], ref['height']
        area = 512 * 512 if architecture == 'stable-diffusion-1' else 1024 * 1024
        if width * height > area * 1.15:
            scale = (area / (width * height)) ** 0.5
            multiple = profiles.get(architecture, {}).get('spatialMultiple', 32)
            width, height = max(256, round(width * scale / multiple) * multiple), max(256, round(height * scale / multiple) * multiple)
        case = {**ref, 'modelName': model['display_name'], 'sampling': {**chosen, 'width': width, 'height': height}, 'addons': []}
        if architecture == 'pony':
            case['promptFile'] = ref['ponyPromptFile']
        if defaults.get('negativePrompt') is False or architecture in {'flux-2', 'flux-1-dev', 'flux-1-schnell'}:
            case.pop('negativePromptFile', None)
        cases.append(case)
    template_path, cases_path = root / f'{architecture}-template.json', root / f'{architecture}-cases.json'
    template_path.write_text(json.dumps(template, indent=2), encoding='utf-8')
    cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    batches.append(dict(name=architecture, template=str(template_path), cases=str(cases_path), outputRoot=str(root / architecture)))
(root / 'installed-engine-reference-batches.json').write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'batches': len(batches), 'cases': len(batches) * len(references)}))
