import hashlib
import json
from pathlib import Path
import sqlite3

workspace = Path.cwd()
storage = Path('D:/Models/machdoch')
current = storage / 'verification/2026-10-13/image-engines'
evidence = workspace / 'docs/validation/image-engines/research-2026-10-13'
required = [144655944, 144697438, 144594528, 145095967, 144599398, 145177887]
engines = [
    ('SDXL', ['stable-diffusion-xl']), ('Illustrious XL', ['illustrious-xl']),
    ('Anima', ['anima']), ('Pony', ['pony']), ('Stable Diffusion 1.5', ['stable-diffusion-1']),
    ('Z-Image Turbo', ['z-image-turbo']), ('FLUX.1', ['flux-1', 'flux-1-dev']),
    ('Krea 2', ['krea-2', 'krea-2-raw']), ('Krea 2 Turbo', ['krea-2-turbo']),
    ('Z-Image', ['z-image']), ('NoobAI XL', ['noobai-xl']), ('Juggernaut XL', ['juggernaut-xl']),
    ('FLUX.2', ['flux-2', 'flux-2-klein-base-4b']), ('SDXL Turbo', ['sdxl-turbo']),
    ('Qwen-Image 2.1', ['qwen-image-2.1']), ('Qwen-Image 2.1 Turbo', ['qwen-image-2.1-turbo']),
    ('RealVisXL', ['realvis-xl']), ('DreamShaper XL', ['dreamshaper-xl']),
    ('FLUX.1 Schnell', ['flux-1-schnell']), ('Qwen-Image', ['qwen-image']),
    ('Stable Diffusion 3.5', ['stable-diffusion-3']),
    ('Stable Diffusion 3.5 Large Turbo', ['stable-diffusion-3.5-large-turbo']),
    ('HiDream-I1', ['hidream-i1-full']), ('SD-Turbo', ['sd-turbo']),
]
sampling = {p['architecture']: p for p in json.loads((workspace / 'apps/client/src-tauri/python/image_sampling_profiles.json').read_text(encoding='utf-8'))}
with sqlite3.connect((storage / 'media.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    models = [dict(r) for r in db.execute("SELECT m.id,m.architecture,m.display_name FROM media_models m JOIN media_model_installations i ON i.model_id=m.id WHERE i.status='installed'")]
model_architectures = {m['id']: m['architecture'] for m in models}
prior = json.loads((workspace / 'docs/validation/image-engines/current-checks/raw-beach-audit-current/engine-coverage-audit-current.json').read_text(encoding='utf-8'))
historical = [r for c in prior['coverage'] for r in c['realRuns'] if r.get('qualityVerdict') == 'near-reference' and r.get('passed')]
reviews = json.loads((evidence / 'first-visual-review.json').read_text(encoding='utf-8'))['reviewed']
verified_historical = []
for record in historical:
    image = Path(record['image'])
    if image.is_file() and hashlib.file_digest(image.open('rb'), 'sha256').hexdigest() == record['sha256']:
        verified_historical.append({**record, 'architecture': model_architectures.get(record['id'], record['architecture'])})
current_runs = [r for p in current.glob('*/results.json') for r in json.loads(p.read_text(encoding='utf-8'))['models'] if r.get('passed')]
matrix = []
for name, architectures in engines:
    installed = [m for m in models if m['architecture'] in architectures]
    runs = [r for r in current_runs if r['architecture'] in architectures]
    historical_quality = [r for r in verified_historical if r['architecture'] in architectures]
    current_quality = [r for r in reviews if r['engine'] in architectures and r['verdict'] == 'near-reference']
    near = sorted({r['referenceId'] for r in historical_quality + current_quality})
    matrix.append({'engine': name, 'architectures': architectures, 'samplingProfiles': [sampling[a] for a in architectures if a in sampling], 'installedModels': installed, 'currentTechnicalReferences': sorted({r['referenceId'] for r in runs}), 'currentTechnicalRuns': len(runs), 'historicalQualityImagesHashVerified': len(historical_quality), 'referencesWithNearReferenceAssessment': near, 'remainingReferenceAssessments': sorted(set(required) - set(near)), 'allSixReferenceQualityVerified': set(required).issubset(near)})
result = {'checkedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(), 'requestedEngines': len(matrix), 'currentTechnicalRuns': len(current_runs), 'currentVisualReviews': len(reviews), 'historicalQualityImagesHashVerified': len(verified_historical), 'fullGoalComplete': all(m['allSixReferenceQualityVerified'] for m in matrix), 'matrix': matrix}
(evidence / 'requested-engine-coverage-current.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'matrix'}))
