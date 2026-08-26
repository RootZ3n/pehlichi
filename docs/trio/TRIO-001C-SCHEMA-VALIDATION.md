# TRIO-001C Schema Validation

TRIO scaffolding now uses Ajv 8.20.0, pinned in the isolated development-only `scripts/trio/package.json` and `scripts/trio/package-lock.json`. Ajv validates JSON Schema Draft 2020-12. No root or TUI production package manifest or lockfile was changed.

The validator is loaded by the parity verifier itself. The boundary manifest is strict-parsed and schema-validated before repository identity, classification, or hashing can use its values. The same validator directly validates capsule, deployment, capability-pack, and runtime-manifest instances.

## Parsing limits before schema validation

- maximum JSON bytes: 1,048,576;
- maximum nesting depth: 32;
- maximum members/items in one collection: 4,096;
- maximum decoded string length: 65,536 characters;
- duplicate object keys: rejected by the strict parser before an ordinary parse can discard the first value;
- non-finite or syntactically invalid numbers: rejected.

All closed schemas use `additionalProperties: false`. Version constants reject unsupported schema versions. The boundary schema uses a closed `oneOf` selector union, and custom contract validation rejects duplicate/overlapping selectors, unsafe exclusions, inconsistent class semantics, and ambiguous paths before filesystem scanning.

## Exact dependency isolation

The identical verifier-only package metadata in all three repositories declares:

```json
{"devDependencies":{"ajv":"8.20.0"}}
```

The identical npm lockfile resolves Ajv and four transitive development dependencies. These exist only below the excluded `scripts/trio/node_modules` tree. Root `package.json`, root `pnpm-lock.yaml`, `tui/package.json`, and `tui/pnpm-lock.yaml` were not edited. `npm audit` reports zero known vulnerabilities for the isolated toolchain after upgrading from the initially tested 8.17.1 pin.

## Validation evidence

`node --test scripts/trio/schema-validation.test.mjs` passes nine tests covering:

- exact validator/draft metadata;
- the real boundary manifest;
- every real capsule and capability-pack instance;
- the real untrusted runtime characterization manifest;
- deployment rejection of plaintext credentials, arbitrary roots, and safety-disable fields;
- unknown properties and unsupported versions;
- duplicate keys;
- all parser resource limits.

The same suite passed in Pehlichi, Loony-Luna, and Mad-Ptah. Schema validation is verifier enforcement only; it does not validate or improve production runtime safety.
