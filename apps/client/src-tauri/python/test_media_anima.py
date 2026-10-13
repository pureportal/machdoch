from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock

import media_anima
import media_image_sampling
import media_open_models


class AnimaTests(unittest.TestCase):
    def test_components_load_from_local_modular_package(self):
        pipeline = Mock()
        constructor = Mock(return_value=pipeline)
        diffusers = SimpleNamespace(AnimaModularPipeline=SimpleNamespace(from_pretrained=constructor))
        with tempfile.TemporaryDirectory() as directory:
            media_anima.load_pipeline(diffusers, Path(directory), 'bf16')
            constructor.assert_called_once_with(directory, local_files_only=True)
            pipeline.load_components.assert_called_once_with(dtype='bf16', pretrained_model_name_or_path=directory, local_files_only=True, use_safetensors=True)

    def test_guidance_updates_the_guider_and_images_are_returned(self):
        class Guider:
            config = {'guidance_scale': 4}
            from_config = Mock(return_value=object())

        image = object()
        pipeline = Mock(return_value=[image])
        pipeline.guider = Guider()
        arguments = {'prompt': 'city lights', 'negative_prompt': 'blur', 'guidance_scale': 5, 'num_inference_steps': 30}
        result = media_anima.generate_image(pipeline, arguments)
        Guider.from_config.assert_called_once_with(Guider.config, guidance_scale=5)
        pipeline.update_components.assert_called_once_with(guider=Guider.from_config.return_value)
        pipeline.assert_called_once_with(output='images', prompt='city lights', negative_prompt='blur', num_inference_steps=30)
        self.assertEqual(result.images, [image])
        self.assertEqual(arguments['guidance_scale'], 5)

    def test_scheduler_changes_update_registered_modular_components(self):
        scheduler = SimpleNamespace(config={'shift': 3})
        pipeline = SimpleNamespace(scheduler=scheduler, update_components=Mock())
        replacement = object()
        loader = Mock(return_value=replacement)
        diffusers = SimpleNamespace(FlowMatchEulerDiscreteScheduler=SimpleNamespace(from_config=loader))
        media_image_sampling.configure_sampler(pipeline, diffusers, 'anima', 'flow-euler')
        loader.assert_called_once_with(scheduler.config)
        pipeline.update_components.assert_called_once_with(scheduler=replacement)

    def test_turbo_guidance_and_unused_negative_prompt_are_rejected(self):
        for architecture in ('sdxl-turbo', 'sd-turbo', 'stable-diffusion-3.5-large-turbo'):
            with self.subTest(architecture=architecture):
                with self.assertRaisesRegex(ValueError, 'guidance'):
                    media_open_models.validate_sampling(architecture, 4, 7)
                with self.assertRaisesRegex(ValueError, 'negative prompts'):
                    media_open_models.image_arguments(architecture, {}, [], 'blur')


if __name__ == '__main__':
    unittest.main()
