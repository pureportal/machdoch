import subprocess

from gi.repository import GObject, Nautilus


class MachdochMenuProvider(GObject.GObject, Nautilus.MenuProvider):
    def _launch(self, _item, action, paths):
        subprocess.Popen(
            ["/usr/bin/machdoch", "--ui", action, *paths],
            close_fds=True,
            start_new_session=True,
        )

    def _local_path(self, file_info):
        return file_info.get_location().get_path()

    def _menu_item(self, name, label, action, paths):
        item = Nautilus.MenuItem(
            name=f"Machdoch::{name}",
            label=label,
        )
        item.connect("activate", self._launch, action, paths)
        return item

    def get_file_items(self, files):
        paths = [self._local_path(file_info) for file_info in files]

        if any(path is None for path in paths):
            return []

        if len(files) == 1 and files[0].is_directory():
            return [
                self._menu_item(
                    "OpenFolder",
                    "Open in machdoch",
                    "--machdoch-open-folder",
                    paths,
                )
            ]

        if files and all(not file_info.is_directory() for file_info in files):
            return [
                self._menu_item(
                    "AttachFiles",
                    "Attach to machdoch",
                    "--machdoch-attach-files",
                    paths,
                )
            ]

        return []

    def get_background_items(self, folder):
        path = self._local_path(folder)

        if path is None:
            return []

        return [
            self._menu_item(
                "OpenBackgroundFolder",
                "Open in machdoch",
                "--machdoch-open-folder",
                [path],
            )
        ]
