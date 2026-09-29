import math
import re
import shutil
from collections import deque
from pathlib import Path


class LossRecorder:
    def __init__(self, window_size=100):
        if type(window_size) is not int or window_size <= 0:
            raise ValueError("window_size must be a positive integer")
        self._losses = deque(maxlen=window_size)
        self._total = 0.0

    def add(self, *, epoch, step, loss):
        value = float(loss)
        if not math.isfinite(value):
            raise ValueError("loss must be finite")
        if len(self._losses) == self._losses.maxlen:
            self._total -= self._losses[0]
        self._losses.append(value)
        self._total += value

    @property
    def moving_average(self):
        return self._total / len(self._losses) if self._losses else 0.0


def validate_output_name(output_name):
    if not isinstance(output_name, str) or not output_name or output_name.isspace():
        raise ValueError("output name must be a nonempty filename")
    if output_name in {".", ".."} or output_name[-1] in {" ", "."}:
        raise ValueError("output name must be a valid filename")
    if any(character in '<>:"/\\|?*' or ord(character) < 32 for character in output_name):
        raise ValueError("output name must be a valid filename")
    if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?",
                    output_name, re.IGNORECASE):
        raise ValueError("output name must be a valid filename")


def prune_state_dirs(output_dir, output_name, keep_last_n_states):
    if type(keep_last_n_states) is not int or keep_last_n_states < 0:
        raise ValueError("keep_last_n_states must be a nonnegative integer")
    validate_output_name(output_name)
    pattern = re.compile(rf"{re.escape(output_name)}-(\d{{6,}})-state\Z")
    completed = []
    for path in Path(output_dir).iterdir():
        match = pattern.fullmatch(path.name)
        if match is None or path.is_symlink() or not path.is_dir():
            continue
        if all((path / name).is_file() for name in (
                "lora.safetensors", "optimizer.pt", "training_state.json")):
            completed.append((int(match.group(1)), path))
    completed.sort(key=lambda item: (item[0], item[1].name))
    for _, path in completed[:max(0, len(completed) - keep_last_n_states)]:
        shutil.rmtree(path)
