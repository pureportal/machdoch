import argparse
import json
import os
from pathlib import Path
import socket
import sys
import wave


def forbid_network():
    sys.dont_write_bytecode = True
    def refuse(*args, **kwargs):
        raise RuntimeError("Speech inference cannot access the network.")

    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    for key in list(os.environ):
        if key.startswith("FERMION_"):
            del os.environ[key]
    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DO_NOT_TRACK": "1",
        "FERMION_DEVICE": "cpu",
        "FERMION_CPU_THREADS": "4",
        "FERMION_P2_PLANE_CACHE": "0",
        "FERMION_P2_PARAKEET": "vendored",
    })


def transcribe(resource_dir, audio, language, key_terms):
    language = (language or "en").replace("_", "-").split("-")[0].lower()
    if language not in ("en", "auto"):
        raise ValueError("Phonon-2 transcribes English. Choose Whistle or Whisper for other languages.")
    if len(key_terms) > 25:
        raise ValueError("Phonon-2 accepts up to 25 key terms. Remove extra terms in speech settings.")
    with wave.open(str(audio), "rb") as recording:
        if (recording.getnchannels(), recording.getframerate(), recording.getsampwidth()) != (1, 16000, 2):
            raise ValueError("Phonon-2 needs 16 kHz mono PCM WAV audio.")
        if recording.getnframes() == 0:
            raise ValueError("The recording is empty. Record again.")
    model_dir = resource_dir / "phonon2" / "model"
    if not all((model_dir / filename).is_file() for filename in ("config.json", "packed_manifest.json", "model.fermion")):
        raise RuntimeError("The Phonon-2 model is missing. Reinstall Machdoch.")
    forbid_network()
    from fermion import _compat
    from fermion._speech.engine_phonon2_cpu import load

    _compat.prepare_torch_stack()
    model = load(model_dir, profile="five-value", backend="phonon2-five-value", quiet=True)
    transcript = model.transcribe_detailed(audio, hotwords=key_terms)
    if transcript.truncated:
        raise RuntimeError("Phonon-2 could not transcribe the whole recording. Try shorter recordings.")
    return {
        "text": transcript.text,
        "detectedLanguage": "en",
        "words": transcript.words,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--language")
    parser.add_argument("--key-term", action="append", default=[])
    args = parser.parse_args()
    try:
        result = transcribe(args.resource_dir.resolve(), args.audio, args.language, args.key_term)
        print(json.dumps(result, ensure_ascii=True, allow_nan=False))
    except (Exception, SystemExit) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
