param([Parameter(Mandatory)][int[]]$WaitProcessIds)

$evidence = 'docs/validation/image-engines/research-2026-10-13'
$fixture = "$evidence/native-sd-turbo-fixture.json"
Wait-Process -Id $WaitProcessIds -ErrorAction SilentlyContinue
python docs/validation/image-engines/prepare-hidream-reference-batch.py
$hidreamReady = $LASTEXITCODE -eq 0
node apps/client/scripts/verify-native-media-image-generation.mjs http://127.0.0.1:9228 $fixture docs/validation/image-engines/native-basic-sd-turbo-2026-10-13 basic *> "$evidence/native-basic-sd-turbo-generation.log"
node apps/client/scripts/verify-native-media-image-generation.mjs http://127.0.0.1:9228 $fixture docs/validation/image-engines/native-advanced-sd-turbo-2026-10-13 advanced *> "$evidence/native-advanced-sd-turbo-generation.log"
$native = Get-Process -Id 31244 -ErrorAction SilentlyContinue
if ($native) {
    $expectedPath = (Resolve-Path '.cache/image-engine-native-final-artifact/machdoch.exe').Path
    if ($native.Path -ne $expectedPath) { throw 'The isolated desktop process changed' }
    Stop-Process -Id $native.Id
    Wait-Process -Id $native.Id -ErrorAction SilentlyContinue
}
if ($hidreamReady) {
    & .cache/image-verification-runtime/Scripts/python.exe apps/client/src-tauri/python/verify_media_reference_batches.py --batches D:/Models/machdoch/verification/2026-10-13/image-engines/hidream-smoke-batches.json --results D:/Models/machdoch/verification/2026-10-13/image-engines/hidream-smoke-batch-results.json --hip-device 1 *> "$evidence/hidream-smoke-batches.log"
    if ($LASTEXITCODE -eq 0) {
        & .cache/image-verification-runtime/Scripts/python.exe apps/client/src-tauri/python/verify_media_reference_batches.py --batches D:/Models/machdoch/verification/2026-10-13/image-engines/hidream-full-reference-batches.json --results D:/Models/machdoch/verification/2026-10-13/image-engines/hidream-reference-batch-results.json --hip-device 1 *> "$evidence/hidream-reference-batches.log"
    }
}
& .cache/image-verification-runtime/Scripts/python.exe apps/client/src-tauri/python/verify_media_reference_batches.py --batches D:/Models/machdoch/verification/2026-10-13/image-engines/followup-reference-batches.json --results D:/Models/machdoch/verification/2026-10-13/image-engines/followup-reference-batch-results.json --hip-device 1 *> "$evidence/followup-reference-batches.log"
