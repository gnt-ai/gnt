/**
 * Ambient shims for the engine's own transitive dependencies that don't
 * ship types (heic-decode, .wasm imports) or need a devDependency
 * (js-yaml). These modules are pulled in by the engine's image-import
 * feature, which apps/store never calls — this file exists purely so
 * `tsc --noEmit` can finish type-checking the transitive closure of the
 * engine's source.
 */
declare module "heic-decode";
declare module "*.wasm";
