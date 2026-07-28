import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: ["dist/**"],
  },
  {
    // The seam: raw Postgres access is confined to src/native/ (NativeStore's
    // own layer) plus the test files that probe a real Postgres for
    // reachability before running their own Postgres-backed suite —
    // everything else depends on the GntStore interface (src/core/store.ts),
    // never the `postgres` package directly. Same enforcement mechanism as
    // the isolation contract this codebase has always had for its storage
    // adapter, just narrower now that there's only one adapter.
    files: ["**/*.ts"],
    ignores: [
      "src/native/**",
      "test/native-store.test.ts",
      "test/http-server.test.ts",
      "test/log-decision.test.ts",
      "test/network-exposure.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "postgres",
              message:
                "raw Postgres access is confined to src/native/ — depend on the GntStore interface (src/core/store.ts) instead.",
            },
          ],
        },
      ],
    },
  },
);
