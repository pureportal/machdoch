use super::{BuiltinModelManifest, ManifestFile};

pub(super) const WAN_MANIFEST: BuiltinModelManifest = BuiltinModelManifest {
    model_id: "local:wan2.2-ti2v-5b",
    slug: "wan2.2-ti2v-5b",
    display_name: "Wan2.2 TI2V 5B",
    revision: "b8fff7315c768468a5333511427288870b2e9635",
    source_url: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers",
    download_root: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers/resolve",
    license_digest: "b7120bb210ab14defe6cabd7ac4bf568d0f5fde42f88ea4ac3cfec9516dc2c0c",
    license_name: "Apache License 2.0",
    license_spdx_id: Some("Apache-2.0"),
    license_source_url: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers/resolve/b8fff7315c768468a5333511427288870b2e9635/README.md",
    license_requires_acceptance: false,
    package_description: "Wan 2.2 TI2V-5B Diffusers package",
    excluded_paths: &["repository documentation and examples"],
    files: &[
        ManifestFile {
            path: "README.md",
            byte_size: 17633,
            sha256: "b7120bb210ab14defe6cabd7ac4bf568d0f5fde42f88ea4ac3cfec9516dc2c0c",
        },
        ManifestFile {
            path: "model_index.json",
            byte_size: 499,
            sha256: "6a72faeb564b0e894aea8fc4ef27241106eb739e8584e869b61589a65473add7",
        },
        ManifestFile {
            path: "scheduler/scheduler_config.json",
            byte_size: 820,
            sha256: "571a3eed68bcd943a61b9fea8efa9e141472216ada59f928c8b5128ce24b32e0",
        },
        ManifestFile {
            path: "text_encoder/config.json",
            byte_size: 855,
            sha256: "a2bcb24699f6c009a2427432bdd483ef8b2b42a712abc9503759cdc77d171f07",
        },
        ManifestFile {
            path: "text_encoder/model-00001-of-00003.safetensors",
            byte_size: 4935812536,
            sha256: "a8e861969c7433e707cc5a74065d795d36cca07ec96eb6763eb4083df7248f58",
        },
        ManifestFile {
            path: "text_encoder/model-00002-of-00003.safetensors",
            byte_size: 4983103192,
            sha256: "d57d948ece4837d850b7a859a4415121d57cacf8b9ee1d4db200c67f592902d7",
        },
        ManifestFile {
            path: "text_encoder/model-00003-of-00003.safetensors",
            byte_size: 1442935480,
            sha256: "0da9ee284e21d1406df708788db1d502d95d75f69faa25cd26151bf8829b7c5f",
        },
        ManifestFile {
            path: "text_encoder/model.safetensors.index.json",
            byte_size: 22476,
            sha256: "31c4c7bcce679eaa0dd4667462394ddb013dc2f748e0bffc893dc9146a320dab",
        },
        ManifestFile {
            path: "tokenizer/special_tokens_map.json",
            byte_size: 7079,
            sha256: "456b58fd240a06c743a7c2cf8008bec501240d68ebd1fc4018ea569505fea270",
        },
        ManifestFile {
            path: "tokenizer/spiece.model",
            byte_size: 4548313,
            sha256: "e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458",
        },
        ManifestFile {
            path: "tokenizer/tokenizer.json",
            byte_size: 16837459,
            sha256: "20a46ac256746594ed7e1e3ef733b83fbc5a6f0922aa7480eda961743de080ef",
        },
        ManifestFile {
            path: "tokenizer/tokenizer_config.json",
            byte_size: 61758,
            sha256: "1d8d2a216bf8e70ac15b7ddcea566c4dd0433c024b39a58ca5e4c66bd78defbd",
        },
        ManifestFile {
            path: "transformer/config.json",
            byte_size: 495,
            sha256: "dc00d9866e72cf77db6b531aaa33be4dc7148fef9338442bd0ae9181f7075e9b",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model-00001-of-00005.safetensors",
            byte_size: 4978254344,
            sha256: "511bec832a201caa410d09c5ce7dbbf8ad2708c345d82038f684fc74cce982be",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model-00002-of-00005.safetensors",
            byte_size: 4846784976,
            sha256: "7c42724912b1911429125dc50c0e9a49ccbada5a601b657d4ed2e15e7597c193",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model-00003-of-00005.safetensors",
            byte_size: 4972658392,
            sha256: "e9c3d0c76de786566382f8258101fea973ae37681c6e9fe0e5fe1fb93b806424",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model-00004-of-00005.safetensors",
            byte_size: 4846785080,
            sha256: "a331121771790939678db6f585553fd5184609f7d02593c699a4d241b0d834c5",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model-00005-of-00005.safetensors",
            byte_size: 354751840,
            sha256: "78b655685c47efdb2349f36826bb101264e9f212a16325d584aeb5f53c88e719",
        },
        ManifestFile {
            path: "transformer/diffusion_pytorch_model.safetensors.index.json",
            byte_size: 73297,
            sha256: "d6c1f72d86fbddef8fb5ef1c03f5b56b2bfdb6ae58032db98c6019fd1dae9021",
        },
        ManifestFile {
            path: "vae/config.json",
            byte_size: 1701,
            sha256: "d996c340fe9a7df5d7371f76a7d8d6956f6c98256080074d8434fa5eeac11360",
        },
        ManifestFile {
            path: "vae/diffusion_pytorch_model.safetensors",
            byte_size: 2818777808,
            sha256: "62cd18f19438e35b32ac63020e2852f566e9b02f46b6cdbd87972a356e3c6f4b",
        },
    ],
};
