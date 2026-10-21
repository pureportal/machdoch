import json
from pathlib import Path

root = Path('D:/Models/machdoch/downloads/civitai')
output = Path('docs/validation/image-engines/research-2026-10-13')
entries = [
    (795765, 889818, 'illustrious-xl', 'Illustrious XL v0.1 · OnomaAI Research'),
    (833294, 1022833, 'noobai-xl', 'NoobAI XL Epsilon 1.0 · Laxhar Dream Lab'),
    (139562, 789646, 'realvis-xl', 'RealVisXL V5.0 · SG161222'),
    (112902, 126688, 'dreamshaper-xl', 'DreamShaper XL Alpha 2 · Lykon'),
    (215478, 242797, 'sdxl-turbo', 'SDXL Turbo · Stability AI'),
    (220609, 248781, 'sd-turbo', 'SD-Turbo · Stability AI'),
]
for model, version, architecture, name in entries:
    folder = root / str(model) / str(version)
    provenance_file = next(folder.glob('*.provenance.json'))
    provenance = json.loads(provenance_file.read_text(encoding='utf-8'))
    fixture = {'request': {'sourcePath': str(folder / provenance['filename']), 'architecture': architecture,
                          'displayName': name, 'sourceUrl': provenance['sourceUrl'], 'commercialUse': 'review-required',
                          'licenseName': None, 'reviewToken': ''}, 'expectedDigest': provenance['sha256']}
    (output / f'import-{architecture}.json').write_text(json.dumps(fixture, indent=2), encoding='utf-8')
print(json.dumps({'fixtures': len(entries)}))
