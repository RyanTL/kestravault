/** A ULID string: 26 chars of Crockford base32, lexicographically sortable. */
export type Ulid = string;

/** A lowercase-hex SHA-256 digest. */
export type Sha256 = string;

/** An RFC 4122 UUID string — Supabase auth user ids (`auth.users.id`). */
export type Uuid = string;

/** An ISO 8601 timestamp, e.g. `2026-06-27T14:50:00.000Z`. */
export type IsoTimestamp = string;

/** A calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;
