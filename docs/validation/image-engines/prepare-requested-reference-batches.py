import json
from pathlib import Path
import sqlite3

storage = Path('D:/Models/machdoch')
root = storage / 'verification/2026-10-13/image-engines'
root.mkdir(parents=True, exist_ok=True)
previous = storage / 'verification/2026-10-11/image-engines'
references = json.loads((previous / 'six-reference-adapted-generation-cases.json').read_text(encoding='utf-8'))
profiles = {profile['architecture']: profile for profile in json.loads(Path('apps/client/src-tauri/python/open_media_models.json').read_text(encoding='utf-8'))}
sampling_profiles = {profile['architecture']: profile for profile in json.loads(Path('apps/client/src-tauri/python/image_sampling_profiles.json').read_text(encoding='utf-8'))}
requested = ['dreamshaper-xl', 'illustrious-xl', 'noobai-xl', 'realvis-xl', 'sdxl-turbo', 'sd-turbo', 'anima']
batches = []
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as database:
    database.row_factory = sqlite3.Row
    models = [dict(row) for row in database.execute("SELECT m.id,m.architecture,m.display_name,i.relative_path,i.revision,i.manifest_digest FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed'")]
for architecture in requested:
    model = next((model for model in models if model['architecture'] == architecture), None)
    if model is None:
        print(json.dumps({'pendingImport': architecture}))
        continue
    profile = profiles[architecture]
    package = storage / 'models' / model['relative_path']
    checkpoint = package / 'checkpoint.safetensors'
    template = dict(schemaVersion=5, model=dict(id=model['id'], architecture=architecture,
                    packageKind='single-file' if checkpoint.is_file() else 'diffusers-directory',
                    path=str(checkpoint if checkpoint.is_file() else package),
                    configPath=str(package / 'config') if checkpoint.is_file() else None,
                    revision=model['revision'], digest=model['manifest_digest']),
                    prompt='', negativePrompt='', outputCount=1, outputFormat='png', modelPolicy='quality',
                    aspectRatio='1:1', seed=41791, addons=[], referenceImages=[],
                    modelCacheDirectory=str(storage / 'models/cache'),
                    sampling=dict(sampler=sampling_profiles[architecture]['recommendedSamplers'][0],
                                  numInferenceSteps=profile['steps'], guidanceScale=profile['guidance']))
    cases = []
    for reference in references:
        width, height = reference['width'], reference['height']
        if architecture in ('sdxl-turbo', 'sd-turbo'):
            scale = (512 * 512 / (width * height)) ** 0.5
            width, height = max(256, round(width * scale / 32) * 32), max(256, round(height * scale / 32) * 32)
        elif width * height > 1_200_000:
            scale = (1024 * 1024 / (width * height)) ** 0.5
            width, height = max(256, round(width * scale / 32) * 32), max(256, round(height * scale / 32) * 32)
        case = {**reference, 'modelName': model['display_name'], 'sampling': {**template['sampling'], 'width': width, 'height': height}, 'addons': []}
        if profile.get('negativePrompt') is False:
            case.pop('negativePromptFile', None)
        cases.append(case)
    template_path = root / f'{architecture}-template.json'
    cases_path = root / f'{architecture}-cases.json'
    template_path.write_text(json.dumps(template, indent=2), encoding='utf-8')
    cases_path.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    batches.append(dict(name=architecture, template=str(template_path), cases=str(cases_path), outputRoot=str(root / architecture)))
(root / 'new-engine-reference-batches.json').write_text(json.dumps(batches, indent=2), encoding='utf-8')
print(json.dumps({'batches': len(batches), 'cases': sum(6 for batch in batches)}))
