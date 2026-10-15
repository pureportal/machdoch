import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from prepare_flux2_dev_verification_package import prepare


class Flux2DevPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.components = self.root / "components"
        self.output = self.root / "prepared"
        self.checkpoint = self.root / "model.gguf"
        self.checkpoint.write_bytes(b"unchanged quantized transformer")
        self.digest = hashlib.sha256(self.checkpoint.read_bytes()).hexdigest()
        self.source = {"modelId": 2167454, "versionId": 2441386, "sha256": self.digest}
        self.checkpoint.with_suffix(".provenance.json").write_text(json.dumps(self.source))
        values = {
            "model_index.json": {"_class_name": "Flux2Pipeline"},
            "transformer/config.json": {"num_attention_heads": 48, "joint_attention_dim": 15360,
                                        "quantization_config": {"quant_method": "bitsandbytes"},
                                        "_name_or_path": "/publisher/private/path"},
            "text_encoder/config.json": {"quantization_config": {"bnb_4bit_quant_type": "nf4"}},
            "text_encoder/model.safetensors": {"test": "unchanged encoder weight bytes"},
            "vae/config.json": {"latent_channels": 32},
            "vae/diffusion_pytorch_model.safetensors": {"test": "unchanged decoder weight bytes"},
        }
        siblings = []
        for name, value in values.items():
            path = self.components / name
            path.parent.mkdir(parents=True, exist_ok=True)
            data = json.dumps(value).encode()
            path.write_bytes(data)
            siblings.append({"rfilename": name, "size": len(data),
                             "blobId": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()})
        self.publisher = self.root / "publisher.json"
        self.publisher.write_text(json.dumps({"id": "diffusers/FLUX.2-dev-bnb-4bit", "sha": "1" * 40, "siblings": siblings}))
        self.gguf_publisher = self.root / "gguf-publisher.json"
        self.gguf_publisher.write_text(json.dumps({
            "id": "city96/FLUX.2-dev-gguf", "sha": "2" * 40,
            "siblings": [{"rfilename": "flux2-dev-Q4_K_M.gguf", "size": self.checkpoint.stat().st_size,
                          "lfs": {"sha256": self.digest}}],
        }))
        (self.root / "LICENSE-FLUX-DEV.txt").write_text("FLUX.2 [dev] license test fixture")
        (self.root / "LICENSE-Mistral.txt").write_text("Apache License test fixture")

    def prepare(self):
        prepare(self.checkpoint, self.components, self.publisher, self.gguf_publisher, self.root, self.output)

    def test_assembly_changes_transformer_metadata_and_preserves_weight_and_encoder_bytes(self):
        self.prepare()
        self.assertEqual(hashlib.sha256((self.output / "transformer/model.gguf").read_bytes()).hexdigest(), self.digest)
        self.assertEqual((self.output / "text_encoder/config.json").read_bytes(), (self.components / "text_encoder/config.json").read_bytes())
        transformer = json.loads((self.output / "transformer/config.json").read_text())
        self.assertNotIn("quantization_config", transformer)
        self.assertNotIn("_name_or_path", transformer)
        index = json.loads((self.output / "model_index.json").read_text())
        self.assertEqual(index["machdoch_quantization"], {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}})
        self.assertIn("Black Forest Labs", (self.output / "NOTICE.txt").read_text())
        self.assertFalse(json.loads((self.output / "provenance.json").read_text())["weightChanges"])

    def test_changed_component_bytes_fail_before_creating_output(self):
        path = self.components / "text_encoder/model.safetensors"
        path.write_bytes(b"x" * path.stat().st_size)
        with self.assertRaisesRegex(ValueError, "digest"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_mismatched_checkpoint_identity_and_unsafe_component_paths_are_rejected(self):
        self.source["versionId"] = 1
        self.checkpoint.with_suffix(".provenance.json").write_text(json.dumps(self.source))
        with self.assertRaisesRegex(ValueError, "reviewed Civitai"):
            self.prepare()
        self.source["versionId"] = 2441386
        self.checkpoint.with_suffix(".provenance.json").write_text(json.dumps(self.source))
        publisher = json.loads(self.publisher.read_text())
        publisher["siblings"].insert(0, {"rfilename": "../outside"})
        self.publisher.write_text(json.dumps(publisher))
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.prepare()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
