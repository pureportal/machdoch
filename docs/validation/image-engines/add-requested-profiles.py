import json
from pathlib import Path

root = Path('apps/client/src-tauri/python')
profiles = json.loads((root / 'open_media_models.json').read_text())
sampling = json.loads((root / 'image_sampling_profiles.json').read_text())
research = Path('docs/validation/image-engines/research-2026-10-13')
classic_samplers = next(item['samplers'] for item in sampling if item['architecture'] == 'stable-diffusion-xl')
entries = [
    ('illustrious-xl', 'Illustrious XL', 'OnomaAIResearch/Illustrious-xl-early-release-v0', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 28, 7, [20, 40], [5, 7], ['euler-ancestral'], 'Fair AI Public License 1.0-SD'),
    ('noobai-xl', 'NoobAI XL', 'Laxhar/noobai-XL-1.0', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 28, 5.5, [25, 30], [5, 6], ['euler-ancestral'], 'Fair AI Public License 1.0-SD with NoobAI restrictions'),
    ('juggernaut-xl', 'Juggernaut XL', 'RunDiffusion/Juggernaut-XL-v9', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 35, 5, [30, 40], [3, 7], ['dpmpp-2m-karras'], 'CreativeML Open RAIL-M with publisher restrictions'),
    ('realvis-xl', 'RealVisXL', 'SG161222/RealVisXL_V5.0', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 50, 5, [30, 60], [5, 8], ['dpmpp-2m-karras'], 'CreativeML Open RAIL++-M'),
    ('dreamshaper-xl', 'DreamShaper XL', 'Lykon/dreamshaper-xl-1-0', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 25, 7.5, [25, 30], [5, 8], ['deis'], 'CreativeML Open RAIL++-M'),
    ('sdxl-turbo', 'SDXL Turbo', 'stabilityai/sdxl-turbo', 'stable-diffusion-xl', 'StableDiffusionXLPipeline', 4, 0, [1, 4], [0, 0], ['euler-ancestral'], 'Stability AI Community License'),
    ('sd-turbo', 'SD-Turbo', 'stabilityai/sd-turbo', 'stable-diffusion-2', 'StableDiffusionPipeline', 4, 0, [1, 4], [0, 0], ['euler'], 'Stability AI Community License'),
    ('stable-diffusion-3.5-large-turbo', 'Stable Diffusion 3.5 Large Turbo', 'stabilityai/stable-diffusion-3.5-large-turbo', 'stable-diffusion-3', 'StableDiffusion3Pipeline', 4, 0, [4, 4], [0, 0], ['flow-euler'], 'Stability AI Community License'),
    ('anima', 'Anima', 'circlestone-labs/Anima-Base-v1.0-Diffusers', None, 'AnimaModularPipeline', 40, 4, [30, 50], [4, 5], ['flow-euler'], 'CircleStone Labs Non-Commercial License and NVIDIA Open Model License'),
]
for architecture, name, repository, base, pipeline, steps, guidance, step_range, guidance_range, recommended, license_name in entries:
    metadata = json.loads((research / (repository.replace('/', '--') + '.json')).read_text(encoding='utf-8'))
    profile = dict(id='local:' + architecture, architecture=architecture, displayName=name,
                   family='Anima' if base is None else 'Stable Diffusion XL' if base == 'stable-diffusion-xl' else 'Stable Diffusion 3.5' if base == 'stable-diffusion-3' else 'Stable Diffusion 2.1',
                   repository=repository, revision=metadata['revision'], pipeline=pipeline,
                   capabilities=['text-to-image'], steps=steps, guidance=guidance,
                   guidanceParameter='guidance_scale', fixedSteps=architecture == 'stable-diffusion-3.5-large-turbo',
                   fixedGuidance='turbo' in architecture, negativePrompt='turbo' not in architecture,
                   spatialMultiple=8 if base in ('stable-diffusion-xl', 'stable-diffusion-2') else 16,
                   license=dict(name=license_name, spdxId=None, commercialUse='review-required',
                                sourceUrl='https://huggingface.co/' + ('circlestone-labs/Anima' if architecture == 'anima' else repository)))
    if base:
        profile['baseArchitecture'] = base
    if architecture in ('sd-turbo', 'sdxl-turbo'):
        profile['defaultResolution'] = 512
        profile['schedulerOptions'] = {'timestep_spacing': 'trailing'}
    profiles.append(profile)
    sampling.append(dict(architecture=architecture, steps=step_range, guidance=guidance_range, defaultGuidance=guidance,
                         samplers=classic_samplers if base in ('stable-diffusion-xl', 'stable-diffusion-2') else ['flow-euler'],
                         recommendedSamplers=recommended, sources=['https://huggingface.co/' + ('circlestone-labs/Anima' if architecture == 'anima' else repository)]))
for entry in sampling:
    if 'recommendedSamplers' not in entry:
        entry['recommendedSamplers'] = ['dpmpp-2m-karras'] if entry['architecture'] in ('stable-diffusion-1', 'stable-diffusion-2', 'stable-diffusion-xl') else ['euler-ancestral'] if entry['architecture'] == 'pony' else entry['samplers'][:1]
for filename, content in [('open_media_models.json', profiles), ('image_sampling_profiles.json', sampling)]:
    (root / filename).write_text(json.dumps(content, indent=2) + '\n', encoding='utf-8')
