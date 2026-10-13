from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from media_krea_cache import select_cache_directory


class ImageCachePlacementTests(unittest.TestCase):
    def test_completed_cache_is_reused_without_requiring_free_space(self):
        with tempfile.TemporaryDirectory() as directory:
            primary = Path(directory) / 'system'
            storage = Path(directory) / 'storage'
            for completed_root in (primary, storage):
                with self.subTest(root=completed_root), patch('media_krea_cache.shutil.disk_usage') as usage:
                    chosen = select_cache_directory('digest', primary, storage, 1000, lambda path, _: path == completed_root / 'digest')
                    self.assertEqual(chosen, completed_root / 'digest')
                    usage.assert_not_called()

    def test_system_volume_is_preferred_when_it_has_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            primary = Path(directory) / 'system'
            storage = Path(directory) / 'storage'
            with patch('media_krea_cache.shutil.disk_usage', return_value=SimpleNamespace(free=1000)):
                self.assertEqual(select_cache_directory('digest', primary, storage, 1000, Mock(return_value=False)), primary / 'digest')

    def test_storage_volume_is_selected_when_system_volume_is_full(self):
        with tempfile.TemporaryDirectory() as system_directory, tempfile.TemporaryDirectory() as storage_directory:
            primary = Path(system_directory) / 'cache'
            storage = Path(storage_directory) / 'cache'
            def usage(path):
                return SimpleNamespace(free=100 if path == Path(system_directory) else 1000)
            with patch('media_krea_cache.shutil.disk_usage', side_effect=usage):
                self.assertEqual(select_cache_directory('digest', primary, storage, 1000, Mock(return_value=False)), storage / 'digest')

    def test_insufficient_capacity_explains_the_required_space(self):
        with tempfile.TemporaryDirectory() as directory, patch('media_krea_cache.shutil.disk_usage', return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(ValueError, '2.0 GiB free'):
                select_cache_directory('digest', Path(directory), Path(directory), 2 * 1024**3, Mock(return_value=False))

    def test_relative_cache_directory_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'absolute path'):
            select_cache_directory('digest', Path('relative'), Path('relative'), 1, Mock(return_value=False))


if __name__ == '__main__':
    unittest.main()
