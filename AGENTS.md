# Agent Coding Preferences

These preferences apply to code changes in this repository.

## Types

- Prefer object type aliases over interfaces for object shapes (for example, `type Foo = { ... }`).

- If an object type is used in only one place, and there's not a very compelling reason that someone would need to reference it separately, prefer to inline it at the usage site instead of defining a standalone named type. This ultimately makes the code more readable/maintainable, by preventing accidental coupling to one-off types and making it easier to see (e.g.) if some member is no longer needed, as you know there's only one implementation to check.

## Exports

- When re-exporting from a source file, keep value and type exports from that same source in a single export statement for visual clarity.
