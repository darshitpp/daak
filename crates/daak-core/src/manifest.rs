use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::hash::blake2b256_reader;

pub const MANIFEST_VERSION: u16 = 1;
pub const SCHEMA_MINOR: u16 = 0;
pub const CHUNK_SIZE_DEFAULT: u32 = 1024 * 1024;
pub const CHUNK_SIZE_MIN: u32 = 64 * 1024;
pub const CHUNK_SIZE_MAX: u32 = 4 * 1024 * 1024;

pub fn clamp_chunk_size(requested: u32) -> u32 {
    requested.clamp(CHUNK_SIZE_MIN, CHUNK_SIZE_MAX)
}

pub(crate) mod byte_array {
    use std::fmt;

    use serde::de::{Error, Visitor};
    use serde::{Deserializer, Serializer};

    pub fn serialize<const N: usize, S: Serializer>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(bytes)
    }

    pub fn deserialize<'de, const N: usize, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        struct ByteArrayVisitor<const N: usize>;

        impl<'de, const N: usize> Visitor<'de> for ByteArrayVisitor<N> {
            type Value = [u8; N];

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "a {N}-byte CBOR byte string")
            }

            fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                v.try_into().map_err(|_| E::invalid_length(v.len(), &self))
            }
        }

        deserializer.deserialize_bytes(ByteArrayVisitor)
    }

    pub mod option {
        use std::fmt;

        use serde::de::{Error, Visitor};
        use serde::{Deserializer, Serializer};

        pub fn serialize<const N: usize, S: Serializer>(
            value: &Option<[u8; N]>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(bytes) => serializer.serialize_bytes(bytes),
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, const N: usize, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<[u8; N]>, D::Error> {
            struct OptionalVisitor<const N: usize>;

            impl<'de, const N: usize> Visitor<'de> for OptionalVisitor<N> {
                type Value = Option<[u8; N]>;

                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    write!(f, "an optional {N}-byte CBOR byte string")
                }

                fn visit_none<E: Error>(self) -> Result<Self::Value, E> {
                    Ok(None)
                }

                fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
                    Ok(None)
                }

                fn visit_some<D2: Deserializer<'de>>(
                    self,
                    d: D2,
                ) -> Result<Self::Value, D2::Error> {
                    super::deserialize(d).map(Some)
                }

                fn visit_bytes<E: Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                    v.try_into()
                        .map(Some)
                        .map_err(|_| E::invalid_length(v.len(), &self))
                }
            }

            deserializer.deserialize_option(OptionalVisitor)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceRef {
    #[serde(with = "byte_array")]
    pub device_id: [u8; 16],
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadKind {
    Text,
    Media,
    Batch,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ItemType {
    #[default]
    Text,
    Image,
    Video,
    Document,
    Folder,
    Custom(String),
}

impl ItemType {
    pub fn as_str(&self) -> &str {
        match self {
            ItemType::Text => "text",
            ItemType::Image => "image",
            ItemType::Video => "video",
            ItemType::Document => "document",
            ItemType::Folder => "folder",
            ItemType::Custom(s) => s,
        }
    }
}

impl Serialize for ItemType {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ItemType {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Ok(match raw.as_str() {
            "text" => ItemType::Text,
            "image" => ItemType::Image,
            "video" => ItemType::Video,
            "document" => ItemType::Document,
            "folder" => ItemType::Folder,
            _ => ItemType::Custom(raw),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Item {
    pub index: u32,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub size: Option<u64>,
    #[serde(
        with = "byte_array::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub hash: Option<[u8; 32]>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chunk_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chunk_count: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<Item>,
    #[serde(
        with = "byte_array::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub reply_to: Option<[u8; 16]>,
    #[serde(default)]
    pub attrs: BTreeMap<String, ciborium::value::Value>,
}

impl Item {
    pub fn text(index: u32, text: impl Into<String>) -> Self {
        Self {
            index,
            item_type: ItemType::Text,
            text: Some(text.into()),
            ..Default::default()
        }
    }

    pub fn from_file(index: u32, path: &Path, chunk_size: u32) -> Result<Self> {
        let meta = std::fs::metadata(path)?;
        let size = meta.len();
        let f = std::fs::File::open(path)?;
        let hash = blake2b256_reader(f)?;
        let chunk_size = clamp_chunk_size(chunk_size);
        let chunk_count = size.div_ceil(chunk_size as u64);
        Ok(Self {
            index,
            item_type: ItemType::Document,
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()),
            mime: None,
            size: Some(size),
            hash: Some(hash),
            text: None,
            chunk_size: Some(chunk_size),
            chunk_count: Some(chunk_count),
            children: Vec::new(),
            reply_to: None,
            attrs: BTreeMap::new(),
        })
    }

    /// One binary item per REGULAR FILE under `root`, flattened, each
    /// carrying its share-root-relative path in `attrs["path"]`. `start_index`
    /// is the first item index to hand out, so a folder can follow other items
    /// in a mixed share and stay contiguous (Manifest::batch rejects a gap).
    pub fn from_folder(start_index: u32, root: &Path, chunk_size: u32) -> Result<Vec<Self>> {
        Ok(Self::from_folder_into(
            start_index,
            root,
            chunk_size,
            &mut HashSet::new(),
            &mut HashSet::new(),
        )?
        .into_iter()
        .map(|(item, _source)| item)
        .collect())
    }

    /// `used` is the MANIFEST-wide set of item names already taken. Staging is
    /// flat per payload, so it has to be shared across every folder and every
    /// loose file in one share; `from_folder` alone starts a fresh one, which is
    /// only correct for a share that is a single folder.
    ///
    /// `dests` is the matching set of RECEIVER DESTINATIONS already claimed, as
    /// out_dir-relative strings. Names are not destinations -- a folder child
    /// lands at its attrs["path"], a loose file at its bare name -- so the two
    /// sets are threaded separately, and it is their PAIR that must be unique.
    /// It starts empty here, so a lone folder share is unaffected;
    /// `from_picked_paths` seeds it with every loose file up front.
    ///
    /// Each item comes back with the file it is read from: the walked path, NOT
    /// `root.join(attrs["path"])` -- a deduplicated path carries a `~1` that no
    /// file on disk has.
    pub(crate) fn from_folder_into(
        start_index: u32,
        root: &Path,
        chunk_size: u32,
        used: &mut HashSet<String>,
        dests: &mut HashSet<String>,
    ) -> Result<Vec<(Self, PathBuf)>> {
        if !root.is_dir() {
            // A missing path, or a plain file handed to from_folder, is the
            // caller's error -- not an empty share that "succeeds".
            return Err(CoreError::Transfer(format!(
                "not a directory: {}",
                root.display()
            )));
        }
        let mut files = Vec::new();
        collect_files(root, &mut files)?;
        // Deterministic order: the manifest is user-visible (inbox summary,
        // item list) and a HashMap-order walk would shuffle the share every
        // time. Sorting the paths does it once, here.
        files.sort();
        let mut out = Vec::with_capacity(files.len());
        for (n, path) in files.iter().enumerate() {
            let index = start_index + n as u32;
            let mut item = Self::from_file(index, path, chunk_size)?;
            // attrs["path"] IS a folder child's receiver destination, so IT is
            // what has to be unique, not the name. The same unique_name
            // suffixing the names use works on a path: it appends to the last
            // component, so `sub/x.bin` becomes `sub/x.bin~1`.
            let rel = unique_name(dests, &relative_under(root, path)?);
            item.attrs
                .insert("path".into(), ciborium::value::Value::Text(rel));
            let name = item.name.clone().unwrap_or_else(|| format!("item_{index}"));
            item.name = Some(unique_name(used, &name));
            out.push((item, path.clone()));
        }
        Ok(out)
    }

    pub fn folder(index: u32, name: &str) -> Self {
        Self {
            index,
            item_type: ItemType::Folder,
            name: Some(name.into()),
            ..Self::default()
        }
    }

    /// Folders and unknown (custom) types carry no chunk series of their own and
    /// must not enter the binary path. B1: a picked folder never reaches the wire
    /// as a Folder item -- `from_folder_into` flattens it into one binary item
    /// per regular file, each carrying its share-root-relative `attrs["path"]`.
    /// The item list is flat on the wire; the tree is rebuilt by the receiver.
    pub fn is_binary(&self) -> bool {
        !matches!(
            self.item_type,
            ItemType::Text | ItemType::Folder | ItemType::Custom(_)
        )
    }
}

/// A folder child's path RELATIVE to the share root, which is the only form
/// allowed on the wire: an absolute path would rebuild the sender's local
/// directory layout on the receiver.
fn relative_under(root: &Path, path: &Path) -> Result<String> {
    path.strip_prefix(root)
        .map(|rel| rel.to_string_lossy().into_owned())
        .map_err(|_| {
            CoreError::Transfer(format!(
                "folder child {} is not under the share root {}",
                path.display(),
                root.display()
            ))
        })
}

/// The relative path a folder child carries. A MISSING or non-Text one is a
/// builder bug, not something to skip past: dropping the item here would shift
/// every later source index and misalign `sources` with item indices. Only the
/// tests read it now -- `from_folder_into` fills the attribute itself -- and it
/// stays as the one place that turns the wire value into a `&str`.
#[cfg(test)]
fn item_rel(item: &Item) -> Result<&str> {
    match item.attrs.get("path") {
        Some(ciborium::value::Value::Text(rel)) => Ok(rel.as_str()),
        other => Err(CoreError::Transfer(format!(
            "item {} has no textual relative path ({other:?})",
            item.index
        ))),
    }
}

/// Staging is a FLAT namespace keyed by name, so two "index.html" in
/// different folders would stage onto each other and ship one file's bytes
/// under the other's hash. Disambiguate on collision; attrs["path"] is what
/// the receiver uses to rebuild the tree.
fn unique_name(used: &mut HashSet<String>, name: &str) -> String {
    let mut unique = name.to_owned();
    for n in 1.. {
        if used.insert(unique.clone()) {
            break;
        }
        unique = format!("{name}~{n}");
    }
    unique
}

/// Depth-first walk collecting regular files. `symlink_metadata`, not
/// `metadata`: a symlink is never followed, so a link out of the share root
/// cannot smuggle a foreign file in and a symlinked directory cannot make the
/// walk recurse forever.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let entries = std::fs::read_dir(dir)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            // A dangling symlink or a file removed mid-walk is not the share's
            // failure; skip it the way a file browser would.
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_files(&path, out)?;
        } else if meta.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

/// B1: the one place a picked set of paths becomes a shareable manifest.
/// A picker hands over a MIX of files and folders; a directory expands into one
/// item per file under it. Returns the manifest and the source paths indexed by
/// ITEM index, which is what `outbox::enqueue` stages from and what
/// `send_secure` streams.
///
/// Before B1 every call site did `Item::from_file(i, p, ..)` per path, and a
/// directory made that fail with IsADirectory -- so a folder could not be
/// shared at all. Three call sites (daakd, daak-ffi, daak-cli) each inlined
/// that loop, so they are all routed here instead of being patched three times.
pub fn from_picked_paths(
    sender: DeviceRef,
    picked: &[PathBuf],
    chunk_size: u32,
) -> Result<(Manifest, Vec<PathBuf>)> {
    let mut items: Vec<Item> = Vec::new();
    let mut sources: Vec<PathBuf> = Vec::new();
    // B1/F2: item names are unique per MANIFEST, not per folder. Staging keys
    // every binary item by its manifest name inside one flat payload dir, so a
    // per-folder set let folder B's notes.txt reuse folder A's name: the second
    // staged file was hard-linked over the first and the sender streamed one
    // file's bytes against the other's hash. Loose files join the set too.
    let mut used: HashSet<String> = HashSet::new();
    // B1/F4: names are not destinations. A folder child lands at its
    // attrs["path"] and a loose file at its bare name, so the two resolve by
    // different routes and a shared NAME set cannot see the collision: a loose
    // `x.bin` beside a folder holding a top-level `x.bin` produced two
    // uniquely-named items that both landed on out_dir/x.bin, and the receiver
    // interleaved their chunks into one file. The invariant is distinct
    // DESTINATIONS. Two picked folders cannot collide -- the receiver puts
    // each under its own attrs["path"] root, so their children never share a
    // destination -- so seeding from the loose files is enough, and it makes
    // the outcome independent of pick order.
    // The claim is a PRE-PASS, and it has to claim BOTH sets. Doing it as the
    // walk reached each loose file made the outcome depend on pick order, so a
    // folder picked first handed the bare `x.bin` to its own child and the
    // loose file got `x.bin~1` instead of the other way round -- collision-free
    // both times, but the same share produced two different layouts depending
    // on how the picker ordered it, which the reverse-order test pins.
    //
    // Reserving only `dests` with the raw basename was wrong too, and in a way
    // that reintroduced the very collision this set exists to prevent: a flat
    // file's destination is its FINAL name, so if `used` then renamed it to
    // `x.bin~1` it landed on the same file the folder child had just claimed.
    // `used` and `dests` are therefore reserved together, before any folder is
    // walked, and the loop below reuses the reserved name verbatim instead of
    // deduping a second time.
    let mut dests: HashSet<String> = HashSet::new();
    let mut flat_names: Vec<Option<String>> = vec![None; picked.len()];
    for (slot, path) in flat_names.iter_mut().zip(picked) {
        if path.is_dir() {
            continue;
        }
        let Some(basename) = path.file_name() else {
            continue;
        };
        let name = unique_name(&mut used, &basename.to_string_lossy());
        dests.insert(name.clone());
        *slot = Some(name);
    }
    for (path, reserved) in picked.iter().zip(&flat_names) {
        let start = items.len() as u32;
        if path.is_dir() {
            for (item, source) in
                Item::from_folder_into(start, path, chunk_size, &mut used, &mut dests)?
            {
                items.push(item);
                sources.push(source);
            }
        } else {
            // A loose picked file is NOT given an attrs["path"] and so lands
            // FLAT under its bare name on the receiver, while a folder child
            // carries one and lands in a subdirectory. That asymmetry is
            // deliberate, not an oversight: a loose file has no tree to
            // preserve, and a peer that renames it into a subdirectory would be
            // inventing structure the sender never picked. Both paths still go
            // through the same `used` (name) and `dests` (destination) sets, so
            // the two builders can never emit a name that collides in the
            // receiver's flat staging namespace nor two items that claim one
            // file on disk.
            let mut item = Item::from_file(start, path, chunk_size)?;
            // Already reserved by the pre-pass under exactly this name, so it
            // is taken verbatim: re-running unique_name here would see its own
            // reservation and bump it to `x.bin~1`, colliding with the folder
            // child that holds that destination.
            item.name = reserved.clone();
            items.push(item);
            sources.push(path.clone());
        }
    }
    if items.is_empty() {
        return Err(CoreError::Transfer(
            "nothing to send: the picked paths hold no files".into(),
        ));
    }
    let manifest = Manifest::batch(sender, items)?;
    Ok((manifest, sources))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub v: u16,
    #[serde(with = "byte_array")]
    pub payload_id: [u8; 16],
    pub kind: PayloadKind,
    pub created_at: u64,
    pub sender: DeviceRef,
    pub items: Vec<Item>,
    #[serde(
        with = "byte_array::option",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub reply_to: Option<[u8; 16]>,
    #[serde(default)]
    pub meta: BTreeMap<String, ciborium::value::Value>,
    #[serde(default)]
    pub extensions: BTreeMap<String, ciborium::value::Value>,
}

impl Manifest {
    /// Same major version is required; minor differences are forward-compatible.
    /// The major version is the manifest's own `v` field (Phase 1's `MANIFEST_VERSION`).
    pub fn is_compatible(&self, peer_major: u16) -> bool {
        peer_major == crate::manifest::MANIFEST_VERSION
    }

    pub fn new(kind: PayloadKind, sender: DeviceRef, items: Vec<Item>) -> Self {
        let mut payload_id = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut payload_id);
        Self {
            v: MANIFEST_VERSION,
            payload_id,
            kind,
            created_at: now_ms(),
            sender,
            items,
            reply_to: None,
            meta: BTreeMap::new(),
            extensions: BTreeMap::new(),
        }
    }

    pub fn batch(sender: DeviceRef, items: Vec<Item>) -> Result<Self> {
        for (expected, item) in items.iter().enumerate() {
            if item.index as usize != expected {
                return Err(CoreError::Protocol(format!(
                    "batch item indices must be contiguous from 0; found {} at position {expected}",
                    item.index
                )));
            }
        }
        let kind = if items.len() > 1 {
            PayloadKind::Batch
        } else {
            PayloadKind::Media
        };
        Ok(Self::new(kind, sender, items))
    }

    pub fn text(text: &str) -> Self {
        let sender = DeviceRef {
            device_id: [0u8; 16],
            name: "local".into(),
        };
        Self::new(PayloadKind::Text, sender, vec![Item::text(0, text)])
    }

    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }

    pub fn binary_items(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|i| i.is_binary())
    }

    /// Top-level items whose `type` this build does not understand. Folder
    /// children are walked by consumers, not by this function.
    pub fn unsupported_items(&self) -> Vec<&Item> {
        self.items
            .iter()
            .filter(|i| matches!(&i.item_type, ItemType::Custom(_)))
            .collect()
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::blake2b256;

    #[test]
    fn cbor_roundtrip_preserves_fields() {
        let m = Manifest::text("hello daak");
        let bytes = m.to_cbor().unwrap();
        let back = Manifest::from_cbor(&bytes).unwrap();
        assert_eq!(m, back);
        assert_eq!(back.kind, PayloadKind::Text);
        assert_eq!(back.items[0].text.as_deref(), Some("hello daak"));
    }

    #[test]
    fn unknown_extension_fields_survive_roundtrip() {
        let mut m = Manifest::text("x");
        m.extensions.insert(
            "future_field".into(),
            ciborium::value::Value::Integer(42.into()),
        );
        let back = Manifest::from_cbor(&m.to_cbor().unwrap()).unwrap();
        assert!(back.extensions.contains_key("future_field"));
    }

    #[test]
    fn from_file_hashes_and_counts_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, vec![7u8; CHUNK_SIZE_DEFAULT as usize + 5]).unwrap();
        let item = Item::from_file(0, &path, CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(item.size, Some(CHUNK_SIZE_DEFAULT as u64 + 5));
        assert_eq!(item.chunk_count, Some(2));
        assert_eq!(item.item_type, ItemType::Document);
        assert_eq!(item.hash, Some(blake2b256(&std::fs::read(&path).unwrap())));
    }

    #[test]
    fn clamp_chunk_size_bounds() {
        assert_eq!(clamp_chunk_size(0), CHUNK_SIZE_MIN);
        assert_eq!(clamp_chunk_size(u32::MAX), CHUNK_SIZE_MAX);
        assert_eq!(clamp_chunk_size(CHUNK_SIZE_DEFAULT), CHUNK_SIZE_DEFAULT);
    }

    fn dev() -> DeviceRef {
        DeviceRef {
            device_id: [1u8; 16],
            name: "s".into(),
        }
    }

    /// F1: `path.strip_prefix(root).unwrap_or(path)` silently degraded to an
    /// ABSOLUTE attrs["path"] whenever the walked child was not a lexical
    /// descendant of the root, so the receiver rebuilt the sender's local
    /// directory layout. It has to be an error naming both paths.
    #[test]
    fn a_child_outside_the_root_is_an_error_not_an_absolute_path() {
        let err = relative_under(Path::new("/share/root"), Path::new("/elsewhere/secret.txt"))
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("/share/root") && msg.contains("/elsewhere/secret.txt"),
            "the error must name BOTH paths, got: {msg}"
        );
        assert!(matches!(err, CoreError::Transfer(_)));
    }

    /// F1, the invariant the hole broke: no attrs["path"] a folder share emits
    /// may be absolute, because the receiver would rebuild the sender's local
    /// directory layout. (The failure itself is pinned on `relative_under`
    /// above: `collect_files` builds every child path lexically from `root`, so
    /// from_folder cannot reach the branch itself -- the helper is where a
    /// future caller could, and it is now an error rather than a fallback.)
    #[test]
    fn a_folder_share_never_emits_an_absolute_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("album");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.txt"), b"fine").unwrap();
        for item in Item::from_folder(0, &root, CHUNK_SIZE_DEFAULT).unwrap() {
            let rel = item_rel(&item).unwrap();
            assert!(!rel.starts_with('/'), "attrs[path] must be relative: {rel}");
            assert_eq!(rel, "ok.txt");
        }
    }

    /// F2: the used-name set used to be per-from_folder, so two picked folders
    /// each holding notes.txt produced two items with the SAME name. Staging is
    /// flat per payload, so one item's staged file is hard-linked over the
    /// other's and the sender streams the wrong bytes against the wrong hash.
    #[test]
    fn two_folders_with_the_same_basename_get_unique_manifest_names() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        for root in [&a, &b] {
            std::fs::create_dir_all(root).unwrap();
            std::fs::write(root.join("notes.txt"), b"same basename").unwrap();
            std::fs::write(root.join("other.txt"), b"same basename").unwrap();
        }
        let (manifest, sources) = from_picked_paths(dev(), &[a, b], CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(manifest.items.len(), 4, "two files from each folder");

        let mut names: Vec<&str> = manifest
            .items
            .iter()
            .map(|i| i.name.as_deref().unwrap())
            .collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            total,
            "item names must be unique per manifest, got {names:?}"
        );
        assert_eq!(
            sources.len(),
            4,
            "one source per item, indexed by item index"
        );
    }

    /// F2b: the set is seeded with loose picked files too, so a picked
    /// notes.txt and a folder child notes.txt cannot share a staged name.
    #[test]
    fn a_loose_file_is_deduplicated_against_a_folder_child() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("album");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("shared.txt"), b"in the folder").unwrap();
        let loose = dir.path().join("shared.txt");
        std::fs::write(&loose, b"loose").unwrap();

        let (manifest, _sources) =
            from_picked_paths(dev(), &[loose, root], CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(manifest.items.len(), 2);
        let mut names: Vec<&str> = manifest
            .items
            .iter()
            .map(|i| i.name.as_deref().unwrap())
            .collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            total,
            "a loose file must not reuse a folder child's name, got {names:?}"
        );
    }

    /// F5: a non-Text attrs["path"] used to hit `_ => continue`, silently
    /// dropping the child and shifting every later source index by one, so
    /// `sources[i]` no longer named item i. It is an error.
    #[test]
    fn a_non_text_relative_path_is_an_error_not_a_silently_dropped_child() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("album");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"x").unwrap();

        let mut item = Item::from_file(0, &root.join("a.txt"), CHUNK_SIZE_DEFAULT).unwrap();
        item.attrs
            .insert("path".into(), ciborium::value::Value::Integer(7.into()));
        let err = item_rel(&item).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("item 0"),
            "the error must name the item, got: {msg}"
        );
        assert!(matches!(err, CoreError::Transfer(_)));
    }

    /// And the same for a child that carries no attrs["path"] at all.
    #[test]
    fn a_missing_relative_path_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        let item = Item::from_file(3, &f, CHUNK_SIZE_DEFAULT).unwrap();
        let err = item_rel(&item).unwrap_err();
        assert!(err.to_string().contains("item 3"), "got: {err}");
    }

    /// Where an item actually LANDS, straight from the receiver's own
    /// resolver, so these tests pin the invariant the builder owes rather
    /// than a re-implementation of it.
    fn destinations(manifest: &Manifest) -> Vec<std::path::PathBuf> {
        let out = std::path::Path::new("/out");
        manifest
            .binary_items()
            .map(|i| crate::transfer::receiver::item_destination(out, i).unwrap())
            .collect()
    }

    fn assert_distinct_and_accepted(manifest: &Manifest) {
        let dests = destinations(manifest);
        let total = dests.len();
        let mut sorted = dests.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            total,
            "destinations must be distinct, got {dests:?}"
        );
        // The proof that the fix is at the right layer: the receiver's
        // duplicate-destination backstop must not fire on anything the
        // builder produces.
        crate::transfer::receiver::validate_manifest(manifest)
            .expect("the receiver must accept a manifest from_picked_paths built");
    }

    /// F4, builder half: a loose picked file and a folder child of the same
    /// name resolve through DIFFERENT routes (bare name vs attrs["path"]), so
    /// deduplicating only the manifest name let them land on one file -- the
    /// receiver then interleaved both chunk series into it and failed the
    /// hash. The builder must guarantee distinct DESTINATIONS, not names.
    #[test]
    fn a_loose_file_naming_a_folder_child_gets_a_distinct_destination() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("album");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("x.bin"), b"in the folder").unwrap();
        let loose = dir.path().join("x.bin");
        std::fs::write(&loose, b"loose").unwrap();

        let (manifest, sources) =
            from_picked_paths(dev(), &[loose.clone(), root.clone()], CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(manifest.items.len(), 2);
        assert!(!manifest.items[0].attrs.contains_key("path"));
        assert_ne!(
            item_rel(&manifest.items[1]).unwrap(),
            "x.bin",
            "the folder child, not the loose file, yields the claim on the name"
        );
        assert_distinct_and_accepted(&manifest);
        // The dedup is a destination-only trick: sources[i] must still be the
        // file on disk that was actually picked, with its own content. This is
        // why from_folder_into hands the source back instead of the caller
        // rebuilding it as root.join(attrs["path"]): that name now carries a
        // `~1` that no file on disk has.
        assert_eq!(sources[0], loose);
        assert_eq!(sources[1], root.join("x.bin"));
        assert_eq!(std::fs::read(&sources[1]).unwrap(), b"in the folder");
    }

    /// The same share picked the other way round. Order must not matter, and it
    /// does not: the claim is reserved in a pre-pass, so in BOTH orders the
    /// loose file keeps the bare `x.bin` and the folder child yields to
    /// `x.bin~1`. The old version of this test accepted either claimant, which
    /// is what let the order-dependence hide.
    #[test]
    fn the_folder_first_pick_order_is_collision_free_too() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("album");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("x.bin"), b"in the folder").unwrap();
        let loose = dir.path().join("x.bin");
        std::fs::write(&loose, b"loose").unwrap();

        let (manifest, _sources) =
            from_picked_paths(dev(), &[root, loose], CHUNK_SIZE_DEFAULT).unwrap();
        assert_eq!(manifest.items.len(), 2);
        assert_eq!(item_rel(&manifest.items[0]).unwrap(), "x.bin~1");
        assert!(!manifest.items[1].attrs.contains_key("path"));
        assert_distinct_and_accepted(&manifest);
    }

    /// The receiver's backstop: a HAND-BUILT manifest claiming one destination
    /// twice is still refused, so a hostile or buggy peer cannot interleave
    /// chunks either. The builder tests above must not weaken it.
    #[test]
    fn a_hand_built_colliding_manifest_is_still_refused() {
        let dir = tempfile::tempdir().unwrap();
        let flat = dir.path().join("x.bin");
        std::fs::write(&flat, b"loose").unwrap();
        let mut carried = Item::from_file(1, &flat, CHUNK_SIZE_DEFAULT).unwrap();
        carried
            .attrs
            .insert("path".into(), ciborium::value::Value::Text("x.bin".into()));
        let manifest = Manifest::batch(
            dev(),
            vec![
                Item::from_file(0, &flat, CHUNK_SIZE_DEFAULT).unwrap(),
                carried,
            ],
        )
        .unwrap();
        assert!(crate::transfer::receiver::validate_manifest(&manifest).is_err());
    }

    fn map_get<'a>(value: &'a ciborium::value::Value, key: &str) -> &'a ciborium::value::Value {
        match value {
            ciborium::value::Value::Map(entries) => entries
                .iter()
                .find(|(k, _)| matches!(k, ciborium::value::Value::Text(t) if t == key))
                .map(|(_, v)| v)
                .unwrap_or_else(|| panic!("missing key {key}")),
            other => panic!("expected map, got {other:?}"),
        }
    }

    #[test]
    fn binary_fields_encode_as_cbor_byte_strings() {
        use ciborium::value::Value;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, [1u8, 2, 3, 4]).unwrap();

        let mut m = Manifest::text("hi");
        m.items
            .push(Item::from_file(1, &path, CHUNK_SIZE_DEFAULT).unwrap());
        let bytes = m.to_cbor().unwrap();

        let value: Value = ciborium::de::from_reader(bytes.as_slice()).unwrap();

        let payload_id = map_get(&value, "payload_id");
        assert!(
            matches!(payload_id, Value::Bytes(b) if b.len() == 16),
            "payload_id must be a 16-byte CBOR bstr, got {payload_id:?}"
        );

        let device_id = map_get(map_get(&value, "sender"), "device_id");
        assert!(
            matches!(device_id, Value::Bytes(b) if b.len() == 16),
            "device_id must be a 16-byte CBOR bstr, got {device_id:?}"
        );

        let items = match map_get(&value, "items") {
            Value::Array(a) => a,
            other => panic!("expected items array, got {other:?}"),
        };
        let hash = map_get(&items[1], "hash");
        assert!(
            matches!(hash, Value::Bytes(b) if b.len() == 32),
            "hash must be a 32-byte CBOR bstr, got {hash:?}"
        );
    }
}
