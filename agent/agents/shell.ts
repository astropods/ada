/**
 * POSIX shell quoting for values spliced into a command string.
 *
 * Every command here runs through `/bin/sh -c`, so anything interpolated into
 * one is shell SOURCE, not an argument. `JSON.stringify` looks like it quotes —
 * it returns a double-quoted string with inner quotes escaped — but a
 * double-quoted shell word still expands `$`, backticks and `\`. A file named
 * `$(id)`, `` `id` `` or `$HOME` is therefore EVALUATED rather than read, and
 * one named `a\b` loses its backslash. JSON escaping and shell escaping are
 * different languages that happen to agree on `"`.
 *
 * Single quotes are the only POSIX construct that suppresses every expansion.
 * There is no escape sequence *inside* them, so an embedded `'` is handled by
 * closing the quote, emitting an escaped one, and reopening:
 *
 *   a'b   ->   'a'\''b'   ->   sh reads  a'b
 *
 * Prefer passing arguments without a shell where the API allows it; this is for
 * the places that must build a command line.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
