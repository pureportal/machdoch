use super::{BuiltinModelManifest, ManifestFile};

pub(super) const SVG_MANIFEST: BuiltinModelManifest = BuiltinModelManifest {
    model_id: "local-svg:IntroSVG-Qwen2.5-VL-7B",
    slug: "intro-svg-7b",
    display_name: "IntroSVG 7B",
    revision: "5da60d628d226361fb0a8210dc021782e5ee484a",
    source_url: "https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B",
    download_root: "https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B/resolve",
    license_digest: "c3398d7993803aa2771f1f1c8ca692b29706860b2e4f15a10171c7c463da7363",
    license_name: "Apache License 2.0",
    license_spdx_id: Some("Apache-2.0"),
    license_source_url: "https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B/resolve/5da60d628d226361fb0a8210dc021782e5ee484a/README.md",
    license_requires_acceptance: false,
    package_description: "IntroSVG Transformers package",
    excluded_paths: &["repository documentation and examples"],
    files: &[
        ManifestFile {
            path: "README.md",
            byte_size: 8967,
            sha256: "c3398d7993803aa2771f1f1c8ca692b29706860b2e4f15a10171c7c463da7363",
        },
        ManifestFile {
            path: "added_tokens.json",
            byte_size: 605,
            sha256: "58b54bbe36fc752f79a24a271ef66a0a0830054b4dfad94bde757d851968060b",
        },
        ManifestFile {
            path: "chat_template.json",
            byte_size: 1049,
            sha256: "94174d7176c52a7192f96fc34eb2cf23c7c2059d63cdbfadca1586ba89731fb7",
        },
        ManifestFile {
            path: "config.json",
            byte_size: 1490,
            sha256: "7574be7c19493d20df6fe061c7e9dd73d5bc698d3a1bf7c24b70036479798086",
        },
        ManifestFile {
            path: "generation_config.json",
            byte_size: 214,
            sha256: "bd06fb24f9dacf0fdbff8d4b27dca476f0aa6cffe153bc884698244927faff52",
        },
        ManifestFile {
            path: "merges.txt",
            byte_size: 1671853,
            sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        },
        ManifestFile {
            path: "model-00001-of-00004.safetensors",
            byte_size: 4968243304,
            sha256: "9b7e68f40aa1b9e213ead8c4e71e042c8eee60b1ac43807f6e91a3bd7b01a347",
        },
        ManifestFile {
            path: "model-00002-of-00004.safetensors",
            byte_size: 4991495816,
            sha256: "2aa1bfd6c37a412e18b75fbcaea4c4dc67784d5df119ffdeff77ddb12bef1312",
        },
        ManifestFile {
            path: "model-00003-of-00004.safetensors",
            byte_size: 4932751040,
            sha256: "14617c4434c1bbb749f552d889ae68aa7ae947a38e939938e3518d460f0e2b39",
        },
        ManifestFile {
            path: "model-00004-of-00004.safetensors",
            byte_size: 1691924384,
            sha256: "3eaac5aed72c32abcb07dcc0c2d2e68bda8eae4b653f6f1a557483b2090fde15",
        },
        ManifestFile {
            path: "model.safetensors.index.json",
            byte_size: 57619,
            sha256: "3067e9b0f35596ff3426a0d0ec8c982a51fa1e110c4fc30dcf3be9ea37409df6",
        },
        ManifestFile {
            path: "preprocessor_config.json",
            byte_size: 575,
            sha256: "549c158011407dfb750d9ec578047cf76f5bfe365cd0aa069a50137d3f98d9dd",
        },
        ManifestFile {
            path: "special_tokens_map.json",
            byte_size: 613,
            sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
        },
        ManifestFile {
            path: "tokenizer.json",
            byte_size: 11421896,
            sha256: "9c5ae00e602b8860cbd784ba82a8aa14e8feecec692e7076590d014d7b7fdafa",
        },
        ManifestFile {
            path: "tokenizer_config.json",
            byte_size: 5801,
            sha256: "78a7e0903cd3964daf17c4ee5c4de4341d02ccd269eca36e4af44050320b207c",
        },
        ManifestFile {
            path: "vocab.json",
            byte_size: 2776833,
            sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        },
    ],
};
