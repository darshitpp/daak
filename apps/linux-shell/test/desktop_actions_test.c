// Assert-based, no framework: this file is compiled by a bare clang -std=c11
// line in the task report, and Task 10 wires it into CMake. The thing it exists
// to prove is that the C template in src/desktop_actions.c and the SHIPPED
// extensions/linux-desktop/daak.desktop are the same entry. Those two are
// byte-identical today only by hand, and a hand-maintained duplicate with no
// committed checker is a duplicate that silently diverges on the next edit.

// Run:
//   clang -std=c11 -Wall -Wextra -Werror -o /tmp/daak_desktop_actions_test \
//     apps/linux-shell/src/desktop_actions.c \
//     apps/linux-shell/test/desktop_actions_test.c && /tmp/daak_desktop_actions_test

// The .desktop path is resolved relative to the repository root, so the binary
// must be run from there.
#include "../src/desktop_actions.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

#define CHECK(cond, ...)                    \
  do {                                      \
    checks++;                               \
    if (!(cond)) {                          \
      failures++;                           \
      fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      fprintf(stderr, __VA_ARGS__);         \
      fputc('\n', stderr);                  \
    }                                       \
  } while (0)

#define SHIPPED_DESKTOP "extensions/linux-desktop/daak.desktop"
#define EXEC "/usr/bin/daak-shell"
// Spelled once because the assertions below embed newlines in expected values.
#define NL "\n"

// Read a whole file. Caller frees. NULL on any failure.
static char *read_file(const char *path, size_t *length) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long size = ftell(f);
  if (size < 0) { fclose(f); return NULL; }
  rewind(f);
  char *buf = (char *)malloc((size_t)size + 1);
  if (buf == NULL) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, (size_t)size, f);
  fclose(f);
  buf[got] = '\0';
  if (length != NULL) *length = got;
  return buf;
}

// Write `peers` to a scratch path and return the produced file's contents.
static char *render(const DaakPeer *peers, size_t count, const char *scratch_path) {
  if (daak_write_desktop_actions(scratch_path, EXEC, peers, count) < 0) return NULL;
  return read_file(scratch_path, NULL);
}

static void scratch(char *buf, size_t size, const char *tag) {
  snprintf(buf, size, "/tmp/daak_actions_%s.desktop", tag);
  remove(buf);
}

// ---- N0: the C template IS the shipped entry ---------------------------

static void test_matches_shipped_entry(void) {
  char path[256];
  scratch(path, sizeof(path), "shipped");
  char *produced = render(NULL, 0, path);
  CHECK(produced != NULL, "zero-peer render failed");
  if (produced == NULL) return;
  char *shipped = read_file(SHIPPED_DESKTOP, NULL);
  CHECK(shipped != NULL, "cannot read %s (run from the repo root)", SHIPPED_DESKTOP);
  if (shipped != NULL) {
    // A byte compare, not a field-by-field one: the whole point is that a
    // comment line dropped from either copy fails here, which is the Icon /
    // StartupWMClass / Categories reasoning the shipped file carries.
    CHECK(strcmp(produced, shipped) == 0,
          "C template and %s differ:\n--- C ---\n%s\n--- shipped ---\n%s",
          SHIPPED_DESKTOP, produced, shipped);
    free(shipped);
  }
  free(produced);
  remove(path);
}

// ---- one peer, two peers, and the Actions= / group-set agreement --------

static void fill(DaakPeer *peer, const char *id, const char *name) {
  memset(peer, 0, sizeof(*peer));
  snprintf(peer->device_id, sizeof(peer->device_id), "%s", id);
  snprintf(peer->name, sizeof(peer->name), "%s", name);
}

static int contains(const char *haystack, const char *needle) {
  return strstr(haystack, needle) != NULL;
}

static void test_one_and_two_peers(void) {
  const char *id_a = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const char *id_b = "ffeeddccbbaa99887766554433221100";
  char path[256];

  DaakPeer one[1];
  fill(&one[0], id_a, "Pixel 9");
  scratch(path, sizeof(path), "one");
  char *out = render(one, 1, path);
  CHECK(out != NULL, "one-peer render failed");
  if (out != NULL) {
    CHECK(contains(out, "Actions=SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9;\n"),
          "one peer: missing Actions token, got:\n%s", out);
    CHECK(contains(out, "[Desktop Action SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9]\n"),
          "one peer: missing action group, got:\n%s", out);
    CHECK(contains(out, "Name=Send to Pixel 9\n"),
          "one peer: wrong Name, got:\n%s", out);
    CHECK(contains(out, "Exec=/usr/bin/daak-shell --send-to=0a1b2c3d4e5f60718293a4b5c6d7e8f9 %F\n"),
          "one peer: wrong Exec, got:\n%s", out);
    free(out);
  }
  remove(path);

  DaakPeer two[2];
  fill(&two[0], id_a, "Pixel 9");
  fill(&two[1], id_b, "ThinkPad");
  scratch(path, sizeof(path), "two");
  out = render(two, 2, path);
  CHECK(out != NULL, "two-peer render failed");
  if (out != NULL) {
    CHECK(contains(out, "Actions=SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9;SendTo_ffeeddccbbaa99887766554433221100;\n"),
          "two peers: wrong Actions line, got:\n%s", out);
    CHECK(contains(out, "[Desktop Action SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9]\n"),
          "two peers: missing group A, got:\n%s", out);
    CHECK(contains(out, "[Desktop Action SendTo_ffeeddccbbaa99887766554433221100]\n"),
          "two peers: missing group B, got:\n%s", out);
    // The Actions= token set and the [Desktop Action ...] group set must be
    // the same set. A token with no group renders an action that does nothing;
    // a group with no token is invisible. Only exact equality is correct.
    // Count the two sets separately, because the invariant is that they are
    // EQUAL, not merely that both are non-empty: a token with no group renders
    // an action that does nothing, and a group with no token is invisible. A
    // SendTo_ occurrence is a token when its line starts with "Actions=" and a
    // group when its line starts with "[Desktop Action ". This is the same job
    // a desktop-file-validate parser would do, using only stdio.
    size_t n_tokens = 0, n_groups = 0;
    for (const char *p = out; *p != 0;) {
      const char *eol = strchr(p, '\n');
      size_t len = (eol != NULL) ? (size_t)(eol - p) : strlen(p);
      if (len > 8 && memcmp(p, "Actions=", 8) == 0) n_tokens++;
      if (len > 23 && memcmp(p, "[Desktop Action SendTo_", 23) == 0) n_groups++;
      if (eol == NULL) break;
      p = eol + 1;
    }
    CHECK(n_tokens == 1, "expected one Actions= line carrying 2 tokens, saw %zu line(s)", n_tokens);
    CHECK(n_groups == 2, "expected 2 action groups, saw %zu", n_groups);
    free(out);
  }
  remove(path);
}

// ---- N1: the device id must be exactly 32 lowercase hex bytes ------------

// Each case is (id bytes to place in the field, expected accept/reject).
static void test_id_shape(void) {
  char path[256];
  struct {
    const char *id;
    int accepted;
    const char *why;
  } cases[] = {
    {"0a1b2c3d4e5f60718293a4b5c6d7e8f9", 1, "32 lowercase hex"},
    {"00000000000000000000000000000000", 1, "all zeros"},
    {"ffffffffffffffffffffffffffffffff", 1, "all fs"},
    {"0A1B2C3D4E5F60718293A4B5C6D7E8F9", 0, "uppercase hex is not the wire form"},
    {"0a1b2c3d-4e5f60718293a4b5c6d7e8f9", 0, "a dash is not hex"},
    {"0a1b2c3d4e5f60718293a4b5c6d7e8f", 0, "31 chars is short"},
    // Placed byte-wise by the loop below, not through snprintf: a 33-char id
    // needs 34 bytes and the field is 33, so snprintf would silently
    // truncate it into a VALID 32-char id and the case would pass for the
    // wrong reason. That truncation is itself the hazard worth testing.
    {"0a1b2c3d4e5f60718293a4b5c6d7e8f90", 0, "33 bytes is long"},
    {"0a1b2c3d4e5f60718293a4b5c6d7e8f;", 0, "semicolon would inject a key"},
    {"0a1b2c3d4e5f60718293a4b5c6d7e8f\n", 0, "newline would inject a group"},
    {"", 0, "empty"},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    DaakPeer p;
    memset(&p, 0, sizeof(p));
    // memcpy, not snprintf: the point of the over-long case is an id whose 33rd
    // byte is NOT a terminator, and snprintf cannot express that -- it would
    // truncate to 32 valid bytes and manufacture a peer that is fine.
    size_t id_len = strlen(cases[i].id);
    if (id_len > sizeof(p.device_id)) id_len = sizeof(p.device_id);
    memcpy(p.device_id, cases[i].id, id_len);
    snprintf(p.name, sizeof(p.name), "%s", "Peer");
    scratch(path, sizeof(path), "id");
    int written = daak_write_desktop_actions(path, EXEC, &p, 1);
    CHECK((written == 1) == (cases[i].accepted != 0),
          "id %-34s expected %s (%s), got %d action(s)",
          cases[i].id, cases[i].accepted ? "accept" : "reject", cases[i].why, written);
    remove(path);
  }
}

// A device_id filled with 32 hex bytes and NO terminator must be rejected, not
// read past. The struct is char[33] and DaakPeer is filled from a C string, so
// the field is expected to be NUL-terminated; a caller that hands over an
// unterminated one is a caller bug, and walking off the end of the array to
// discover that is a second bug. The test builds a 33-byte lowercase-hex
// buffer with its NUL one byte PAST the field and casts the start of it, so the
// old unbounded scan would have accepted it -- no undefined behaviour needed to
// demonstrate the difference, just a buffer that is legal to look at.
static void test_unterminated_id(void) {
  // Storage shaped like the real struct, with the device_id field filled to its
  // full 33 bytes and NO terminator anywhere in the first 34. Two things are
  // being asserted at once and both are needed:
  //
  //   1. written == 0. The field is 32 hex bytes plus room for a NUL; 33 hex
  //      bytes with no terminator is not a device id any peer can have.
  //   2. byte 33 is untouched. A scan that ignores the field bound walks off
  //      device_id into name, finds a NUL in the middle of a NAME, and accepts
  //      the id off the end of the field. Leaving a NUL at byte 33 would hide
  //      exactly that bug: the unbounded scan would stop there and behave like a
  //      bounded one. So byte 33 stays 0x61, the same filler as the field.
  //
  // _Alignas gives the cast DaakPeer alignment, so nothing here is a misaligned
  // access. The test measures the WRITER's decision, not undefined behaviour of
  // its own.
  _Alignas(DaakPeer) unsigned char backing[sizeof(DaakPeer)];
  memset(backing, 0x61, 33);          // device_id fully filled, no NUL
  memset(backing + 33, 0, sizeof(backing) - 33);
  backing[33] = 0x61;                 // and byte 33 is NOT a terminator either
  DaakPeer *peer = (DaakPeer *)backing;
  // Deliberately NO name write here: byte 33 is the FIRST BYTE OF THE NAME
  // (offsetof(DaakPeer, name) == 33, verified -- there is no padding), so any
  // name write would clobber the very canary byte this test reads afterwards.
  // The field is already 0x61 filler, so the name reads as "aaa..." and the
  // writer rejects the id long before the name is ever rendered.

  char path[256];
  scratch(path, sizeof(path), "unterminated");
  int written = daak_write_desktop_actions(path, EXEC, peer, 1);
  CHECK(written == 0,
        "a device_id with no NUL in its 33 bytes must be rejected, got %d", written);
  // A WRITE to byte 33, not a read: the writer must never reach past the field at
  // all, and a read cannot be observed after the fact. Byte 33 is the first
  // byte of the name padding, so the writer touching it is the observable
  // signal.
  CHECK(backing[33] == 0x61,
        "the writer wrote past the end of the 33-byte device_id field");
  remove(path);
}

// ---- N3: a repeated id must not produce two actions ---------------------

static void test_duplicate_ids(void) {
  const char *id = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
  DaakPeer peers[2];
  fill(&peers[0], id, "Pixel 9");
  fill(&peers[1], id, "Pixel 9 (again)");
  char path[256];
  scratch(path, sizeof(path), "dupe");
  int written = daak_write_desktop_actions(path, EXEC, peers, 2);
  CHECK(written == 1, "a duplicate id must write one action, wrote %d", written);
  char *out = read_file(path, NULL);
  if (out != NULL) {
    int groups = 0;
    for (const char *p = out; (p = strstr(p, "[Desktop Action SendTo_")) != NULL; p++) groups++;
    CHECK(groups == 1, "expected 1 action group for a duplicate id, saw %d", groups);
    CHECK(contains(out, "[Desktop Action SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9]\n"),
          "missing the single action group, got:\n%s", out);
    free(out);
  }
  remove(path);
}

// ---- N4: a nameless peer must not produce "Name=Send to " ----------------

static void test_empty_name(void) {
  DaakPeer peers[2];
  fill(&peers[0], "0a1b2c3d4e5f60718293a4b5c6d7e8f9", "");
  fill(&peers[1], "ffeeddccbbaa99887766554433221100", "ThinkPad");
  char path[256];
  scratch(path, sizeof(path), "noname");
  // Skipped, not fatal: one unusable peer must not cost the user the rest of
  // the menu. That is the same rule the id check follows.
  int written = daak_write_desktop_actions(path, EXEC, peers, 2);
  CHECK(written == 1, "a nameless peer must be skipped, wrote %d", written);
  char *out = read_file(path, NULL);
  if (out != NULL) {
    CHECK(!contains(out, "Name=Send to \n"),
          "produced an empty Name=, got:\n%s", out);
    CHECK(contains(out, "Name=Send to ThinkPad\n"),
          "the nameless peer cost the user the good one, got:\n%s", out);
    CHECK(!contains(out, "[Desktop Action SendTo_0a1b2c3d4e5f60718293a4b5c6d7e8f9]"),
          "the nameless peer still produced an action group, got:\n%s", out);
    free(out);
  }
  remove(path);
}

// ---- injection and negative controls ------------------------------------

// A peer-supplied NAME is the injection surface. The Desktop Entry spec has no
// quoting for values, so a newline in a name would start a new key or a new
// group. Dropping control characters is the only correct action: rejecting the
// whole entry would cost the user the peer.
static void test_name_injection(void) {
  DaakPeer peer;
  memset(&peer, 0, sizeof(peer));
  snprintf(peer.device_id, sizeof(peer.device_id), "%s",
           "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  // A name carrying a newline and an = that would become its own key.
  //
  // Named array-of-char, NOT a bare literal: the size then comes from sizeof so
  // it cannot drift from the text. A bare "...", 28 against a 26-char literal
  // is a one-byte global-buffer over-read (ASan: global-buffer-overflow READ of
  // size 28 in test_name_injection), and the constant NUL of a named array is
  // not copied by sizeof(x) - 1 -- hence the explicit terminator below.
  static const char evil_name[] = "Evil\nExec=/bin/sh -c 'x'\n#";
  memcpy(peer.name, evil_name, sizeof(evil_name) - 1);
  peer.name[sizeof(evil_name) - 1] = '\0';
  char path[256];
  scratch(path, sizeof(path), "inject");
  int written = daak_write_desktop_actions(path, EXEC, &peer, 1);
  CHECK(written == 1, "a control-char name must still write its action, wrote %d", written);
  char *out = read_file(path, NULL);
  if (out != NULL) {
    // The defence is that the injected text cannot START A LINE, not that it
    // cannot contain the letters. A sanitised name that happened to be called
    // "Exec=/bin/sh" is still one inert Name= value, so the assertion has to be
    // about line position, not about a substring being absent.
    size_t exec_keys = 0, name_keys = 0;
    for (const char *p = out; *p != 0;) {
      const char *eol = strchr(p, '\n');
      size_t len = (eol != NULL) ? (size_t)(eol - p) : strlen(p);
      if (len > 5 && memcmp(p, "Exec=", 5) == 0) exec_keys++;
      if (len > 5 && memcmp(p, "Name=", 5) == 0) name_keys++;
      if (eol == NULL) break;
      p = eol + 1;
    }
    // Exactly the entry's own Exec= and the action's Exec=. An injected one
    // would make three. Line-prefix counting also excludes TryExec=, which is a
    // DIFFERENT key and contains the substring but not the prefix.
    CHECK(exec_keys == 2, "expected 2 Exec= keys, saw %zu", exec_keys);
    // Two Name= keys: the entry Name=Daak and the action Name=Send to .... The
    // entry itself carries exactly one, the action exactly one, so a third is
    // the injection.
    CHECK(name_keys == 2, "expected 2 Name= keys, saw %zu", name_keys);
    CHECK(!contains(out, NL "Exec=/bin/sh"),
          "a peer name started a new Exec= line, got:%s", out);
    // The injected text is on ONE line, with the control characters dropped.
    CHECK(contains(out, "Name=Send to EvilExec=/bin/sh -c 'x'#" NL),
          "control characters were not dropped, got:%s", out);
    free(out);
  }
  remove(path);
}

static void test_negative_controls(void) {
  char path[256];
  scratch(path, sizeof(path), "neg");

  CHECK(daak_write_desktop_actions(NULL, EXEC, NULL, 0) == -1, "NULL path accepted");
  CHECK(daak_write_desktop_actions(path, NULL, NULL, 0) == -1, "NULL exec accepted");
  CHECK(daak_write_desktop_actions(path, "", NULL, 0) == -1, "empty exec accepted");
  CHECK(daak_write_desktop_actions(path, EXEC, NULL, 1) == -1,
        "count>0 with a NULL peer array accepted");
  CHECK(daak_write_desktop_actions(path, EXEC, NULL, 0) == 0,
        "zero peers must succeed, not fail");

  // A peer array of nothing valid still yields a usable, action-free entry
  // rather than no file at all: the user's .desktop must not vanish because
  // one peer was malformed.
  DaakPeer bad;
  memset(&bad, 0, sizeof(bad));
  snprintf(bad.device_id, sizeof(bad.device_id), "%s", "nope");
  scratch(path, sizeof(path), "neg2");
  CHECK(daak_write_desktop_actions(path, EXEC, &bad, 1) == 0,
        "an all-invalid roster must write a zero-action entry");
  char *shipped = read_file(SHIPPED_DESKTOP, NULL);
  char *produced = read_file(path, NULL);
  if (shipped != NULL && produced != NULL) {
    CHECK(strcmp(produced, shipped) == 0,
          "a fully-skipped roster must reproduce the shipped entry byte for byte");
  }
  free(shipped);
  free(produced);
  remove(path);
}

// ---- the atomic write leaves nothing behind -----------------------------

static void test_temp_file_is_cleaned_up(void) {
  char path[256];
  scratch(path, sizeof(path), "tmp");
  char leftover[260];
  snprintf(leftover, sizeof(leftover), "%s.tmp", path);
  CHECK(daak_write_desktop_actions(path, EXEC, NULL, 0) == 0, "render failed");
  char *tmp = read_file(leftover, NULL);
  CHECK(tmp == NULL, "the .tmp sibling survived a successful rename: %s", leftover);
  free(tmp);
  remove(path);
}

int main(void) {
  test_matches_shipped_entry();
  test_one_and_two_peers();
  test_id_shape();
  test_unterminated_id();
  test_duplicate_ids();
  test_empty_name();
  test_name_injection();
  test_negative_controls();
  test_temp_file_is_cleaned_up();
  printf("desktop_actions_test: %d checks, %d failure(s)\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
