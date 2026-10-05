# Supplemental licence texts

`../supplemental.json` maps each supplement to an exact package version, its source and a SHA-256 hash. These files supply legal texts omitted from published archives; they do not change the package's licence.

Where an archive declares a standard licence but its upstream repository provides no full licence text, the supplement supplies that licence's standard terms. Such entries are marked `standardTerms` and retain the publisher declaration as evidence. Original manifests and source notices retain the available attribution; this does not verify missing copyright provenance.

MIT standard terms omit the template's unfilled copyright line rather than invent a copyright holder. Upstream copyright notices must still be retained. The `fxhash` and `mac` supplements select Apache-2.0 from their declared permissive alternatives. MPL terms for `selectors` accompany its original source files.
