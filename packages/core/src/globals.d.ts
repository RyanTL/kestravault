export {};

declare global {
  // Minimal Web Crypto surface used by @kestravault/core. The standard `crypto`
  // global is available on every target we run on — browsers, Node 20+, and
  // React Native (with a polyfill) — so we declare just what we use rather than
  // pulling in the DOM or Node lib and breaking the package's platform-agnostic
  // contract (see AGENTS.md).
  const crypto: {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    // SubtleCrypto digest, used by utils/hash.ts to fingerprint file content.
    subtle: {
      digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
    };
  };

  // UTF-8 encoder used by utils/hash.ts. Present on browsers, Node 11+, and RN
  // (with the standard polyfill) — declared minimally for the same reason as
  // `crypto` above.
  class TextEncoder {
    encode(input?: string): Uint8Array;
  }

  // Minimal `process.env` surface used only by the optional env-loading helper
  // in data/client.ts. Declared structurally (rather than pulling in @types/node)
  // so the package stays platform-agnostic; the env source is always injectable,
  // so hosts without a `process` global pass their own record instead.
  const process:
    | {
        env: Record<string, string | undefined>;
      }
    | undefined;

  // Structured deep clone, used by the in-memory repos to hand back copies rather
  // than internal references. Available on every target we run on (Node 17+,
  // modern browsers, RN with a polyfill) — declared here to avoid pulling in the
  // DOM or Node lib (see the `crypto` note above).
  function structuredClone<T>(value: T): T;
}
