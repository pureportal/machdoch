import ast
import json
from pathlib import Path
import unittest

PYTHON_ROOT = Path(__file__).resolve().parent
TAURI_CONFIG = PYTHON_ROOT.parent / "tauri.conf.json"


def _bundled_python_targets():
    resources = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))["bundle"]["resources"]
    return {Path(target).name for target in resources.values() if target.startswith("python/")}


def _imported_top_level_modules(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split(".")[0]


class BundledPythonResourcesTest(unittest.TestCase):
    def test_bundled_modules_only_import_bundled_local_modules(self):
        bundled = _bundled_python_targets()
        local_modules = {path.stem for path in PYTHON_ROOT.glob("*.py")}
        pending = [PYTHON_ROOT / name for name in bundled if name.endswith(".py") and (PYTHON_ROOT / name).is_file()]
        visited = set()
        missing = {}
        while pending:
            path = pending.pop()
            if path in visited:
                continue
            visited.add(path)
            for module in _imported_top_level_modules(path):
                if module not in local_modules:
                    continue
                if f"{module}.py" not in bundled:
                    missing.setdefault(module, set()).add(path.name)
                pending.append(PYTHON_ROOT / f"{module}.py")
        self.assertEqual({}, missing)


if __name__ == "__main__":
    unittest.main()
