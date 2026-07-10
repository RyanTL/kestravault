// First-run vault seed. When the vault folder doesn't exist yet, we create it
// and lay down a few example notes so the app has real content to open on the
// very first launch (mirrors the three-zone layout from plan/data-model.md).
//
// These are plain markdown files on disk — the user can edit, delete, or replace
// them freely. They are only written once, when the vault is first created.

export interface SeedFile {
  /** Vault-relative POSIX path. */
  path: string;
  content: string;
}

export const SEED_FILES: SeedFile[] = [
  {
    path: "index.md",
    content: `---
title: Index
type: index
---

# Index

Welcome to your KestraVault vault. This is a plain folder of markdown files on disk —
open it in Finder, edit it in Obsidian, or put it under git. Nothing is locked in.

## Concepts
- [[ownership]] — Rust's compile-time memory ownership model.

## Entities
- [[rust-lang]] — The Rust programming language.

## Topics
- [[memory-safety]] — Memory safety without a garbage collector.

> Tip: press \`⌘O\` to jump to any note, or \`⌘⇧F\` to search everything.
`,
  },
  {
    path: "notes/welcome.md",
    content: `---
title: Welcome
type: note
---

# Welcome 👋

This is a normal note you own. A few things to try:

- **Create a note** with the \`+\` button in the sidebar (or right-click a folder).
- **Link notes** by typing \`[[ownership]]\` — switch to *Reading* view (top-right)
  and the link becomes clickable.
- **Rename / delete** anything from the right-click menu in the sidebar.
- Everything autosaves to disk as you type.

Linked: [[ownership]], [[memory-safety]].
`,
  },
  {
    path: "sources/s-2026-06-27-rust-ownership.md",
    content: `---
title: "Intro to Rust ownership"
type: source
added: 2026-06-27
tags: [rust, programming]
---

Ownership is Rust's most distinctive feature. Each value has a single owner, and
when the owner goes out of scope the value is dropped. Moves transfer ownership;
borrows let you reference data without taking ownership.
`,
  },
  {
    path: "wiki/entities/rust-lang.md",
    content: `---
title: "Rust (language)"
type: entity
tags: [rust]
---

# Rust

A systems programming language focused on safety, speed, and concurrency. See
[[ownership]] and [[memory-safety]].
`,
  },
  {
    path: "wiki/concepts/ownership.md",
    content: `---
title: "Ownership (Rust)"
type: concept
tags: [rust]
---

# Ownership (Rust)

A set of compile-time rules governing how a Rust program manages memory:

- Each value has a single **owner**.
- A value is **dropped** when its owner leaves scope.
- **Moves** transfer ownership; **borrows** grant temporary access.

Related: [[memory-safety]], [[rust-lang]].
`,
  },
  {
    path: "wiki/topics/memory-safety.md",
    content: `---
title: "Memory safety"
type: topic
tags: [rust]
---

# Memory safety

Guaranteeing the absence of memory errors (use-after-free, data races) without a
garbage collector — achieved in Rust via [[ownership]] and the borrow checker.
`,
  },
];
