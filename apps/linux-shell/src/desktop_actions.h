#pragma once

#include <stddef.h>

// device_id is 32 lowercase hex chars plus NUL (hex::encode of a [u8; 16],
// crates/daakd/src/lib.rs:193). name is a peer-supplied display name and is
// therefore UNTRUSTED: the writer sanitises it rather than assuming a C string
// from another host is well behaved in an ini file.
typedef struct {
  char device_id[33];
  char name[128];
} DaakPeer;

// Rewrites `desktop_path` with one `Actions=` entry per paired device, then
// returns the number of actions written. The file is written atomically via a
// temporary sibling followed by rename.
//
// Returns the action count, or -1 on any I/O failure. A peer earns an action
// only if its device_id is EXACTLY 32 lowercase hex bytes ([0-9a-f]) followed by
// a NUL, and its name is non-empty; anything else is SKIPPED, not fatal, so one
// malformed peer must not cost the user the rest of the menu. Uppercase, a
// different length, a non-hex byte, or a missing terminator are all rejected --
// see is_safe_id in desktop_actions.c for why the length and case are part of
// the rule and not just of the sanitiser.
int daak_write_desktop_actions(const char *desktop_path,
                               const char *exec_path,
                               const DaakPeer *peers,
                               size_t count);
