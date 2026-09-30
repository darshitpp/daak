#include "desktop_actions.h"

#include <stdio.h>
#include <string.h>

// Portability, recorded because the plan used glib here: the only glib calls
// were g_strdup_printf / g_fopen / g_rename / g_free, and every one has a
// portable stdio equivalent. g_rename IS rename(2) and g_fopen is fopen; the
// path buffer below avoids the only call with no stdio equivalent. So this
// translation unit builds with the C standard library alone, which matters
// because apps/linux-shell has no CMakeLists yet (Task 10 creates it) and this
// file must not be the reason a future build needs glib headers. The real
// shell links glib for GTK regardless; this file deliberately does not.

// A device_id is EXACTLY 32 lowercase hex bytes: hex::encode of a [u8; 16]
// (crates/daakd/src/lib.rs:193). The length and the case are both load-bearing,
// not decoration:
//
//   - The id goes into the ini as BOTH a group name and an Actions= token. A ';'
//     or a newline in it would let a peer inject keys into the user's own
//     desktop file, so anything outside [0-9a-f] is rejected outright.
//   - 32 and lowercase is the only form the engine ever emits. Accepting
//     uppercase would accept an id that no peer can match, and accepting a
//     different LENGTH would let a 31-char id through to be silently truncated
//     by the char[33] field later on -- a link that resolves to the wrong
//     device, which is worse than no link.
//
// The field is char[33], so a caller can hand over 33 bytes with NO terminator.
// The loop is bounded to the field and the terminator is checked explicitly, so
// that case is REJECTED rather than read past the end of the array. Skipping a
// malformed peer is the rule throughout: one bad id must not cost the user the
// rest of the menu.
#define DAAK_DEVICE_ID_LEN 32
static int is_safe_id(const char id[DAAK_DEVICE_ID_LEN + 1]) {
  if (id == NULL) return 0;
  for (int i = 0; i < DAAK_DEVICE_ID_LEN; i++) {
    const char c = id[i];
    const int ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!ok) return 0;
  }
  // The 33rd byte must terminate. Without this a 33-byte unterminated field is
  // indistinguishable from a 32-byte one and the check above would pass it.
  return id[DAAK_DEVICE_ID_LEN] == '\0';
}

// A peer display name is arbitrary UTF-8 and lands in an ini Name= value. The
// Desktop Entry spec has no quoting for values, so a newline would start a new
// key or a new group. Dropping the control characters is the only correct
// action; sanitising beats rejecting because a name with a stray control char
// must not cost the user the whole Send To menu.
static void write_sanitised_name(FILE *file, const char *name) {
  for (const char *p = (name != NULL) ? name : ""; *p != '\0'; p++) {
    unsigned char c = (unsigned char)*p;
    if (c < 0x20 || c == 0x7f) continue;
    fputc(c, file);
  }
}

// The comment block below reproduces extensions/linux-desktop/daak.desktop
// verbatim, and that duplication is deliberate and recorded: the shipped
// .desktop is the source of truth for the AS-SHIPPED entry, and the runtime
// rewrite must not silently drop the Icon/StartupWMClass/Categories reasoning,
// or a user who reads the installed file after the first peer connects finds
// those decisions unexplained.
//
// Two copies of a file with no checker diverge on the next edit, so the
// equivalence is ASSERTED BY A COMMITTED TEST, not by a reader: the zero-peer
// output of this writer is byte-compared against the shipped file in
// apps/linux-shell/test/desktop_actions_test.c. That test is also where the id
// shape, the duplicate rule, the empty-name rule and the name-injection defence
// are pinned. Run it with:
//
//   clang -std=c11 -Wall -Wextra -Werror -o /tmp/daak_desktop_actions_test \
//     apps/linux-shell/src/desktop_actions.c \
//     apps/linux-shell/test/desktop_actions_test.c && /tmp/daak_desktop_actions_test
//
// from the repository root. If you edit one copy, that test fails until you
// edit the other. Task 10 wires it into CMake; it is run by hand until then.
static void write_desktop_entry(FILE *file, const char *exec_path) {
  fputs("[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Daak\n"
        "Comment=Send files over the LAN with Daak\n",
        file);
  fprintf(file, "Exec=%s %%F\n", exec_path);
  fprintf(file, "TryExec=%s\n", exec_path);
  fputs("# Icon is a THEME ICON NAME. \"dev.darshit.daak\" is the hicolor icon basename\n"
        "# Phase 8 installs to /usr/share/icons/hicolor/256x256/apps/, which is what the\n"
        "# freedesktop lookup resolves; a bare name is the correct form and an absolute\n"
        "# path would hardcode one size. (Not changed by this task.)\n"
        "Icon=dev.darshit.daak\n"
        "Terminal=false\n"
        "# Network;FileTransfer;Utility -- FileTransfer is the registered main category\n"
        "# for a file-sending app; the plan's Utility;Network; is kept because Task 7\n"
        "# rewrites this whole file from the C template and asserts these lines, so the\n"
        "# two must agree or Task 7's rewrite silently changes the categories.\n"
        "Categories=Utility;Network;\n"
        "# GTK4 sets this from g_set_prgname/g_set_application_name. The prgname is the\n"
        "# desktop id, so StartupWMClass must equal it, which it does. This is what makes\n"
        "# the window be matched to the .desktop entry for icon and focus handling.\n"
        "StartupWMClass=dev.darshit.daak\n"
        "MimeType=text/plain;image/png;image/jpeg;application/pdf;video/mp4;inode/directory;\n",
        file);
}

// A peer earns an action only if it can be RENDERED: a well-formed id AND a
// NON-EMPTY name. An empty name would produce the literal line "Name=Send to ",
// which a user reads as a truncated menu item rather than as a missing peer, so
// an empty name is skipped.
//
// The check is name[0] and nothing more, and that is the whole rule: a name made
// only of control characters (say bytes 01 02 1b) is NON-EMPTY, so it passes
// here and the sanitiser drops every byte, leaving a blank "Name=Send to " value
// and a live action for that peer. That is cosmetic, not a security or
// wrong-device defect -- the id still validated, the Exec= target is still that
// peer's id, and the Actions= token and the [Desktop Action <id>] group still
// agree, because both come from this one predicate. Scanning for a non-empty
// SANITISED result would fix the cosmetics and is deliberately NOT done.
//
// This is ONE predicate on purpose. The Actions= token list and the set of
// [Desktop Action ...] groups are emitted by two loops, and the only thing
// keeping them the same set is that both ask this question the same way. The
// first loop cannot be "more permissive" than the second by accident.
static int peer_is_admissible(const DaakPeer *peer) {
  if (!is_safe_id(peer->device_id)) return 0;
  if (peer->name[0] == '\0') return 0;
  return 1;
}

// Duplicate ids are rejected, keeping the FIRST. Two actions for one id would be
// two identical-looking menu entries pointing at the same peer, and the
// [Desktop Action <id>] group NAME is derived from the id, so the second would
// overwrite the first in any consumer that keys on group name. First-wins is
// the only rule that needs no ordering guarantee from the caller.
//
// ponytail: O(n^2) on purpose. A paired-peer roster is a handful of entries; a hash
// set here would be more code than the defect it fixes, and n is bounded by how
// many machines are on one LAN.
static int id_already_seen(const DaakPeer *peers, size_t self) {
  for (size_t i = 0; i < self; i++) {
    if (memcmp(peers[i].device_id, peers[self].device_id, DAAK_DEVICE_ID_LEN + 1) == 0) {
      return 1;
    }
  }
  return 0;
}

// THE single admission test every write path uses. Returns 1 when peers[self]
// should appear in BOTH the Actions= line and the group list.
static int peer_is_written(const DaakPeer *peers, size_t self) {
  return peer_is_admissible(&peers[self]) && !id_already_seen(peers, self);
}

static void write_action_group(FILE *file, const DaakPeer *peer, const char *exec_path) {
  fprintf(file, "\n[Desktop Action SendTo_%s]\n", peer->device_id);
  fputs("Name=Send to ", file);
  write_sanitised_name(file, peer->name);
  fputc('\n', file);
  fprintf(file, "Exec=%s --send-to=%s %%F\n", exec_path, peer->device_id);
}

int daak_write_desktop_actions(const char *desktop_path,
                               const char *exec_path,
                               const DaakPeer *peers,
                               size_t count) {
  if (desktop_path == NULL || exec_path == NULL || exec_path[0] == '\0') return -1;
  if (count > 0 && peers == NULL) return -1;

  // Count with the SAME predicate both write loops use, so the Actions= token
  // list and the set of [Desktop Action ...] groups cannot disagree. A token with
  // no group is an action that does nothing; a group with no token is invisible.
  size_t written = 0;
  for (size_t i = 0; i < count; i++) {
    if (peer_is_written(peers, i)) written++;
  }

  // Atomic: temp sibling, then rename. A crash or a full disk mid-write must
  // not leave a truncated entry in the user's applications directory. 5 == the
  // 4 chars of ".tmp" plus the NUL, appended past the path's own NUL.
  size_t path_len = strlen(desktop_path);
  char temporary[4096];
  if (path_len + 5 > sizeof(temporary)) return -1;
  memcpy(temporary, desktop_path, path_len + 1);
  memcpy(temporary + path_len, ".tmp", 5);

  FILE *file = fopen(temporary, "w");
  if (file == NULL) return -1;

  write_desktop_entry(file, exec_path);

  if (written > 0) {
    fputs("Actions=", file);
    size_t seen = 0;
    for (size_t i = 0; i < count; i++) {
      if (!peer_is_written(peers, i)) continue;
      fprintf(file, "%sSendTo_%s", seen == 0 ? "" : ";", peers[i].device_id);
      seen++;
    }
    fputs(";\n", file);
  }

  for (size_t i = 0; i < count; i++) {
    if (peer_is_written(peers, i)) write_action_group(file, &peers[i], exec_path);
  }

  // fclose flushes, and a flush failure means a full disk -- in which case the
  // truncated temp must NOT be renamed over a good file.
  if (fclose(file) != 0) {
    remove(temporary);
    return -1;
  }
  if (rename(temporary, desktop_path) != 0) {
    remove(temporary);
    return -1;
  }
  return (int)written;
}
