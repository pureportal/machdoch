# Media Studio asset storage

Settings → Asset storage selects an empty directory on a local disk. The move includes the complete managed Media Studio directory: checkpoints, LoRAs, embeddings, downloaded components, imported/generated media, flow artifacts, staging files, and the library database. External workspace files and the Python runtime remain outside this directory.

The native process performs the move independently of the settings panel. A storage lease is retained by each `MediaRuntimePaths` instance and its clones. Shared OS file locks cover reads, downloads, imports, generation, and Fleet workers; an exclusive lock prevents migration from racing those operations. Existing work must finish before a move can start.

`media-storage.json` in the application data directory contains the selected root and the migration journal. It is atomically replaced and flushed. The journal records the source, destination, file inventory, verified SHA-256 hashes, and cleanup phase. A destination identity marker detects missing or replaced disks. There is no fallback to the original default directory when the configured disk is unavailable.

Files are copied into temporary siblings. After interruption, the worker compares the partial file against the original before appending. It syncs and hashes each completed copy before publishing it. The active root switches only after every file has been copied and verified. Destination verification runs again before cleanup; each original is checked before deletion. Cleanup removes only inventoried files and empty directories. Symlinks, junctions, special files, overlapping roots, and populated destinations are rejected.

Desktop and Fleet worker startup resume pending moves. Disk, permission, and verification errors leave the journal intact and expose Resume move in settings. Runtime recovery runs while storage remains exclusively locked, before normal operations resume.

Verification:

- Native tests cover partial/corrupt copies, copied files whose journal update was interrupted, partial cleanup, repeated moves, database integrity, missing disks, unsafe paths, capacity checks, and storage leases.
- Subprocess tests exit without destructors during copying, after file publication, and during cleanup, then recover using a new process's storage lock.
- The opt-in `moves_library_to_another_volume_and_back` test uses `MACHDOCH_STORAGE_TEST_DISK` to verify a round trip to another writable Windows volume with an isolated fixture.
- `node scripts/verify-asset-storage-ui.mjs` checks confirmation, progress, pause/resume, and layout at desktop/mobile widths using mocked IPC and an in-memory production bundle. It starts no server.

Physical power loss and live generation with a multi-gigabyte library require separate device testing.
