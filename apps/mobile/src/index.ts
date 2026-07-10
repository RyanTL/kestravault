import { slugify, ulid } from "@kestravault/core";

/**
 * Placeholder entrypoint for the KestraVault mobile app.
 *
 * The real app — React Native (Expo) with the CodeMirror 6 editor running inside
 * a react-native-webview (bridged to native for content and toolbar actions) —
 * is a follow-up task. See ./README.md and plan/architecture.md. For now this
 * only proves the monorepo wiring: the app resolves and imports @kestravault/core.
 */
export function describeScaffold(): string {
  return `@kestravault/mobile scaffold — example id=${ulid()} slug=${slugify("Hello KestraVault")}`;
}
