extern crate alloc;
use super::error::{DeserializeError, DeserializeFailure};
use super::serialization::*;
use alloc::borrow::ToOwned;
use alloc::boxed::Box;
use alloc::format;
use alloc::string::String;
use alloc::string::ToString;
use alloc::vec::Vec;

macro_rules! any_cbor_recursion_guard {
    () => {};
}

// `AnyCbor` — a structured CBOR value (the runtime lowering of CDDL `any`).
//
// NON-PRESERVE variant (concatenated when `--preserve-encodings` is off). No encoding metadata:
// the round-trip contract is VALUE-level (re-serialization is canonical-ish, exactly as
// non-preserve generated code behaves — smallest integer widths, definite lengths, floats always
// written f64), matching the crate-wide non-preserve contract. Equality/ordering/hashing compare
// VALUE only (floats by `total_cmp`/bit pattern so the relations are total and NaN is
// self-consistent). The preserve variant (`any_cbor_preserve.rs`) is representational instead.
//
// Depth: `deserialize` routes all recursion through the single `read` seam, whose first line
// invokes `any_cbor_recursion_guard!()`. The includer supplies that macro: the static assembly in
// generated crates expands it to `DepthGuard::acquire(<baked limit>)?` under
// `--deserialize-depth-limit` (and to nothing without the flag, so no-flag crates keep
// byte-identical output); the property-harness shims supply their own definition to exercise the
// guard. Without the flag: bounded allocation, dangling-`Break` rejection, `Err` (never panic) on
// malformed input — same as the rest of the crate.
#[derive(Clone, Debug)]
pub enum AnyCbor {
    UInt(u64),
    // Full CBOR nint domain (-2^64..=-1).
    NInt(i128),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<AnyCbor>),
    // Wire order AND duplicate keys preserved.
    Map(Vec<(AnyCbor, AnyCbor)>),
    Tag(u64, Box<AnyCbor>),
    Special(AnySpecial),
}

#[derive(Clone, Debug)]
pub enum AnySpecial {
    Bool(bool),
    Null,
    Undefined,
    Unassigned(u8),
    Float(f64),
}

/// Lightweight discriminant for `AnyCbor::kind()`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnyCborKind {
    UInt,
    NInt,
    Bytes,
    Text,
    Array,
    Map,
    Tag,
    Bool,
    Null,
    Undefined,
    Unassigned,
    Float,
}

/// Length-first-then-bytewise comparison of two encoded CBOR map keys — the RFC 7049 §3.9
/// "canonical CBOR" key ordering. Shared runtime helper (see the preserve variant for the fuller
/// note); present in both variants so callers can rely on it regardless of `--preserve-encodings`.
pub fn any_cbor_canonical_key_cmp(lhs: &[u8], rhs: &[u8]) -> core::cmp::Ordering {
    match lhs.len().cmp(&rhs.len()) {
        core::cmp::Ordering::Equal => lhs.cmp(rhs),
        diff_ord => diff_ord,
    }
}

impl AnyCbor {
    /// The CBOR major-type/special discriminant of this value.
    pub fn kind(&self) -> AnyCborKind {
        match self {
            AnyCbor::UInt(..) => AnyCborKind::UInt,
            AnyCbor::NInt(..) => AnyCborKind::NInt,
            AnyCbor::Bytes(..) => AnyCborKind::Bytes,
            AnyCbor::Text(..) => AnyCborKind::Text,
            AnyCbor::Array(..) => AnyCborKind::Array,
            AnyCbor::Map(..) => AnyCborKind::Map,
            AnyCbor::Tag(..) => AnyCborKind::Tag,
            AnyCbor::Special(AnySpecial::Bool(_)) => AnyCborKind::Bool,
            AnyCbor::Special(AnySpecial::Null) => AnyCborKind::Null,
            AnyCbor::Special(AnySpecial::Undefined) => AnyCborKind::Undefined,
            AnyCbor::Special(AnySpecial::Unassigned(_)) => AnyCborKind::Unassigned,
            AnyCbor::Special(AnySpecial::Float(..)) => AnyCborKind::Float,
        }
    }

    pub fn as_uint(&self) -> Option<u64> {
        match self {
            AnyCbor::UInt(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_nint(&self) -> Option<i128> {
        match self {
            AnyCbor::NInt(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            AnyCbor::Bytes(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            AnyCbor::Text(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[AnyCbor]> {
        match self {
            AnyCbor::Array(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&[(AnyCbor, AnyCbor)]> {
        match self {
            AnyCbor::Map(v) => Some(v),
            _ => None,
        }
    }

    pub fn as_tag(&self) -> Option<(u64, &AnyCbor)> {
        match self {
            AnyCbor::Tag(t, inner) => Some((*t, inner)),
            _ => None,
        }
    }

    pub fn as_float(&self) -> Option<f64> {
        match self {
            AnyCbor::Special(AnySpecial::Float(f)) => Some(*f),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            AnyCbor::Special(AnySpecial::Bool(b)) => Some(*b),
            _ => None,
        }
    }

    /// The simple-value code of an `unassigned` special (0..=19 or 32..=255), else `None`. Needed by
    /// the JSON surface's reverse mapping (there is no other way to read the code back out).
    pub fn as_unassigned(&self) -> Option<u8> {
        match self {
            AnyCbor::Special(AnySpecial::Unassigned(v)) => Some(*v),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, AnyCbor::Special(AnySpecial::Null))
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, AnyCbor::Special(AnySpecial::Undefined))
    }

    // --- constructors (mode-paired with the preserve variant; here there are no encoding slots to
    // fill). These are the value-building surface the JSON deserialize path, the wasm wrapper, and
    // the emit-tests mint all construct through, so the same call sites serve every mode. ---

    pub fn new_uint(value: u64) -> Self {
        AnyCbor::UInt(value)
    }

    /// `value` must lie in the CBOR nint domain `-2^64..=-1`; out-of-domain is a debug-assert (no
    /// clamping — the caller is responsible, mirroring the crate-wide "no silent coercion" stance).
    pub fn new_nint(value: i128) -> Self {
        debug_assert!(
            (-(1i128 << 64)..=-1).contains(&value),
            "AnyCbor::new_nint: {value} outside the CBOR nint domain -2^64..=-1"
        );
        AnyCbor::NInt(value)
    }

    pub fn new_bytes(bytes: Vec<u8>) -> Self {
        AnyCbor::Bytes(bytes)
    }

    pub fn new_text(text: String) -> Self {
        AnyCbor::Text(text)
    }

    pub fn new_array(elems: Vec<AnyCbor>) -> Self {
        AnyCbor::Array(elems)
    }

    pub fn new_map(pairs: Vec<(AnyCbor, AnyCbor)>) -> Self {
        AnyCbor::Map(pairs)
    }

    pub fn new_tag(tag: u64, inner: AnyCbor) -> Self {
        AnyCbor::Tag(tag, Box::new(inner))
    }

    pub fn new_bool(b: bool) -> Self {
        AnyCbor::Special(AnySpecial::Bool(b))
    }

    pub fn new_null() -> Self {
        AnyCbor::Special(AnySpecial::Null)
    }

    pub fn new_undefined() -> Self {
        AnyCbor::Special(AnySpecial::Undefined)
    }

    pub fn new_unassigned(code: u8) -> Self {
        AnyCbor::Special(AnySpecial::Unassigned(code))
    }

    /// Canonical-width float (non-preserve carries no width slot).
    pub fn new_float(f: f64) -> Self {
        AnyCbor::Special(AnySpecial::Float(f))
    }

    /// Canonical-ish value re-encoding (smallest widths, definite lengths, f64 floats).
    pub fn to_cbor_bytes(&self) -> Vec<u8> {
        let mut buf = cbor_event::se::Serializer::new_vec();
        self.serialize_ref(&mut buf).unwrap();
        buf.finalize()
    }

    /// Value equality used by generated open-record constraint checks.  This assembly carries no
    /// replay-width slots, so its normal serialization is already the value normal form.
    pub fn value_eq(&self, other: &Self) -> bool {
        self.to_cbor_bytes() == other.to_cbor_bytes()
    }

    /// The serialization workhorse; the `cbor_event::se::Serialize` impl delegates here.
    pub fn serialize_ref<'a>(
        &self,
        serializer: &'a mut cbor_event::se::Serializer,
    ) -> cbor_event::Result<&'a mut cbor_event::se::Serializer> {
        match self {
            AnyCbor::UInt(v) => {
                serializer.write_unsigned_integer(*v)?;
            }
            AnyCbor::NInt(v) => {
                let arg = (-((*v) + 1)) as u64;
                serializer.write_negative_integer_sz(*v, cbor_event::Sz::canonical(arg))?;
            }
            AnyCbor::Bytes(bytes) => {
                serializer.write_bytes(bytes)?;
            }
            AnyCbor::Text(text) => {
                serializer.write_text(text)?;
            }
            AnyCbor::Array(elems) => {
                serializer.write_array(cbor_event::Len::Len(elems.len() as u64))?;
                for elem in elems.iter() {
                    elem.serialize_ref(serializer)?;
                }
            }
            AnyCbor::Map(pairs) => {
                serializer.write_map(cbor_event::Len::Len(pairs.len() as u64))?;
                for (key, value) in pairs.iter() {
                    key.serialize_ref(serializer)?;
                    value.serialize_ref(serializer)?;
                }
            }
            AnyCbor::Tag(tag, inner) => {
                serializer.write_tag(*tag)?;
                inner.serialize_ref(serializer)?;
            }
            AnyCbor::Special(special) => match special {
                AnySpecial::Bool(b) => {
                    serializer.write_special(cbor_event::Special::Bool(*b))?;
                }
                AnySpecial::Null => {
                    serializer.write_special(cbor_event::Special::Null)?;
                }
                AnySpecial::Undefined => {
                    serializer.write_special(cbor_event::Special::Undefined)?;
                }
                AnySpecial::Unassigned(v) => {
                    serializer.write_special(cbor_event::Special::Unassigned(*v))?;
                }
                AnySpecial::Float(f) => {
                    serializer.write_special(cbor_event::Special::Float(*f))?;
                }
            },
        }
        Ok(serializer)
    }

    /// Recursion seam for deserialize (see the file header re: the depth guard).
    fn read(raw: &mut cbor_event::de::Deserializer) -> Result<Self, DeserializeError> {
        // Depth-guard hook: expands to a `DepthGuard::acquire(<baked limit>)?` RAII binding when the
        // generated crate is built with `--deserialize-depth-limit`, or to nothing otherwise. The
        // macro is supplied by the includer (the static assembly for generated crates; the test
        // shims for the property harness) so this one file serves every flag combination unsplit.
        any_cbor_recursion_guard!();
        match raw.cbor_type()? {
            cbor_event::Type::UnsignedInteger => Ok(AnyCbor::UInt(raw.unsigned_integer_sz()?.0)),
            cbor_event::Type::NegativeInteger => Ok(AnyCbor::NInt(raw.negative_integer_sz()?.0)),
            cbor_event::Type::Bytes => Ok(AnyCbor::Bytes(raw.bytes_sz()?.0)),
            cbor_event::Type::Text => Ok(AnyCbor::Text(raw.text_sz()?.0)),
            cbor_event::Type::Array => {
                let len = raw.array_sz()?;
                // Never with_capacity(claimed len).
                let mut elems = Vec::new();
                read_sequence(raw, len, |raw| {
                    elems.push(AnyCbor::read(raw)?);
                    Ok(())
                })?;
                Ok(AnyCbor::Array(elems))
            }
            cbor_event::Type::Map => {
                let len = raw.map_sz()?;
                let mut pairs = Vec::new();
                read_sequence(raw, len, |raw| {
                    let key = AnyCbor::read(raw)?;
                    let value = AnyCbor::read(raw)?;
                    pairs.push((key, value));
                    Ok(())
                })?;
                Ok(AnyCbor::Map(pairs))
            }
            cbor_event::Type::Tag => {
                let (tag, _sz) = raw.tag_sz()?;
                Ok(AnyCbor::Tag(tag, Box::new(AnyCbor::read(raw)?)))
            }
            cbor_event::Type::Special => {
                let head = *raw
                    .as_slice()
                    .first()
                    .ok_or_else(|| DeserializeFailure::CBOR(cbor_event::Error::NotEnough(0, 1)))?;
                match head & 0b0001_1111 {
                    0x19..=0x1b => Ok(AnyCbor::Special(AnySpecial::Float(raw.float_sz()?.0))),
                    0x1f => {
                        Err(DeserializeFailure::CBOR(cbor_event::Error::UnexpectedBreak).into())
                    }
                    _ => match raw.special()? {
                        cbor_event::Special::Bool(b) => Ok(AnyCbor::Special(AnySpecial::Bool(b))),
                        cbor_event::Special::Null => Ok(AnyCbor::Special(AnySpecial::Null)),
                        cbor_event::Special::Undefined => {
                            Ok(AnyCbor::Special(AnySpecial::Undefined))
                        }
                        cbor_event::Special::Unassigned(v) => {
                            Ok(AnyCbor::Special(AnySpecial::Unassigned(v)))
                        }
                        cbor_event::Special::Float(_) | cbor_event::Special::Break => {
                            Err(DeserializeFailure::CBOR(cbor_event::Error::UnexpectedBreak).into())
                        }
                    },
                }
            }
        }
    }
}

/// Compare an arbitrary generated map-key type to a fixed key by its decoded CBOR VALUE.  The
/// serialization may replay non-minimal preserve widths; parsing it back into `AnyCbor` and using
/// `value_eq` intentionally discards that spelling before the comparison.
pub fn cbor_value_eq_serialized<T: cbor_event::se::Serialize>(
    value: &T,
    expected: &AnyCbor,
) -> Result<bool, DeserializeError> {
    let mut serializer = cbor_event::se::Serializer::new_vec();
    cbor_event::se::Serialize::serialize(value, &mut serializer)?;
    <AnyCbor as Deserialize>::from_cbor_bytes(&serializer.finalize())
        .map(|found| found.value_eq(expected))
}

impl Deserialize for AnyCbor {
    fn deserialize(raw: &mut cbor_event::de::Deserializer) -> Result<Self, DeserializeError> {
        AnyCbor::read(raw)
    }
}

impl cbor_event::se::Serialize for AnyCbor {
    fn serialize<'se>(
        &self,
        serializer: &'se mut cbor_event::se::Serializer,
    ) -> cbor_event::Result<&'se mut cbor_event::se::Serializer> {
        self.serialize_ref(serializer)
    }
}

fn read_sequence<F>(
    raw: &mut cbor_event::de::Deserializer,
    len: cbor_event::LenSz,
    mut read_one: F,
) -> Result<(), DeserializeError>
where
    F: FnMut(&mut cbor_event::de::Deserializer) -> Result<(), DeserializeError>,
{
    match len {
        cbor_event::LenSz::Len(n, _) => {
            for _ in 0..n {
                read_one(raw)?;
            }
        }
        cbor_event::LenSz::Indefinite => loop {
            if raw.cbor_type()? == cbor_event::Type::Special && raw.special_break()? {
                break;
            }
            read_one(raw)?;
        },
    }
    Ok(())
}

// --- value-level Eq / Ord / Hash (floats by bits / total_cmp) ---

impl PartialEq for AnySpecial {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (AnySpecial::Bool(a), AnySpecial::Bool(b)) => a == b,
            (AnySpecial::Null, AnySpecial::Null) => true,
            (AnySpecial::Undefined, AnySpecial::Undefined) => true,
            (AnySpecial::Unassigned(a), AnySpecial::Unassigned(b)) => a == b,
            (AnySpecial::Float(a), AnySpecial::Float(b)) => a.to_bits() == b.to_bits(),
            _ => false,
        }
    }
}
impl Eq for AnySpecial {}

impl PartialEq for AnyCbor {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (AnyCbor::UInt(a), AnyCbor::UInt(b)) => a == b,
            (AnyCbor::NInt(a), AnyCbor::NInt(b)) => a == b,
            (AnyCbor::Bytes(a), AnyCbor::Bytes(b)) => a == b,
            (AnyCbor::Text(a), AnyCbor::Text(b)) => a == b,
            (AnyCbor::Array(a), AnyCbor::Array(b)) => a == b,
            (AnyCbor::Map(a), AnyCbor::Map(b)) => a == b,
            (AnyCbor::Tag(a, ia), AnyCbor::Tag(b, ib)) => a == b && ia == ib,
            (AnyCbor::Special(a), AnyCbor::Special(b)) => a == b,
            _ => false,
        }
    }
}
impl Eq for AnyCbor {}

impl core::hash::Hash for AnySpecial {
    fn hash<H: core::hash::Hasher>(&self, state: &mut H) {
        core::mem::discriminant(self).hash(state);
        match self {
            AnySpecial::Bool(b) => b.hash(state),
            AnySpecial::Null | AnySpecial::Undefined => {}
            AnySpecial::Unassigned(v) => v.hash(state),
            AnySpecial::Float(f) => f.to_bits().hash(state),
        }
    }
}

impl core::hash::Hash for AnyCbor {
    fn hash<H: core::hash::Hasher>(&self, state: &mut H) {
        core::mem::discriminant(self).hash(state);
        match self {
            AnyCbor::UInt(v) => v.hash(state),
            AnyCbor::NInt(v) => v.hash(state),
            AnyCbor::Bytes(v) => v.hash(state),
            AnyCbor::Text(v) => v.hash(state),
            AnyCbor::Array(v) => v.hash(state),
            AnyCbor::Map(v) => v.hash(state),
            AnyCbor::Tag(t, inner) => {
                t.hash(state);
                inner.hash(state);
            }
            AnyCbor::Special(s) => s.hash(state),
        }
    }
}

fn any_special_ord_rank(s: &AnySpecial) -> u8 {
    match s {
        AnySpecial::Bool(_) => 0,
        AnySpecial::Null => 1,
        AnySpecial::Undefined => 2,
        AnySpecial::Unassigned(_) => 3,
        AnySpecial::Float(..) => 4,
    }
}

impl Ord for AnySpecial {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        any_special_ord_rank(self)
            .cmp(&any_special_ord_rank(other))
            .then_with(|| match (self, other) {
                (AnySpecial::Bool(a), AnySpecial::Bool(b)) => a.cmp(b),
                (AnySpecial::Unassigned(a), AnySpecial::Unassigned(b)) => a.cmp(b),
                (AnySpecial::Float(a), AnySpecial::Float(b)) => a.total_cmp(b),
                _ => core::cmp::Ordering::Equal,
            })
    }
}
impl PartialOrd for AnySpecial {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn any_cbor_ord_rank(v: &AnyCbor) -> u8 {
    match v {
        AnyCbor::UInt(..) => 0,
        AnyCbor::NInt(..) => 1,
        AnyCbor::Bytes(..) => 2,
        AnyCbor::Text(..) => 3,
        AnyCbor::Array(..) => 4,
        AnyCbor::Map(..) => 5,
        AnyCbor::Tag(..) => 6,
        AnyCbor::Special(..) => 7,
    }
}

impl Ord for AnyCbor {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        any_cbor_ord_rank(self)
            .cmp(&any_cbor_ord_rank(other))
            .then_with(|| match (self, other) {
                (AnyCbor::UInt(a), AnyCbor::UInt(b)) => a.cmp(b),
                (AnyCbor::NInt(a), AnyCbor::NInt(b)) => a.cmp(b),
                (AnyCbor::Bytes(a), AnyCbor::Bytes(b)) => a.cmp(b),
                (AnyCbor::Text(a), AnyCbor::Text(b)) => a.cmp(b),
                (AnyCbor::Array(a), AnyCbor::Array(b)) => a.cmp(b),
                (AnyCbor::Map(a), AnyCbor::Map(b)) => a.cmp(b),
                (AnyCbor::Tag(a, ia), AnyCbor::Tag(b, ib)) => a.cmp(b).then_with(|| ia.cmp(ib)),
                (AnyCbor::Special(a), AnyCbor::Special(b)) => a.cmp(b),
                _ => core::cmp::Ordering::Equal,
            })
    }
}
impl PartialOrd for AnyCbor {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
// Manual serde `Serialize`/`Deserialize` for `AnyCbor` — a JSON *representation of CBOR*, not
// "natural" JSON. Written ONCE against the mode-independent surface (`kind()`/`as_*` accessors +
// the `new_*` constructors), so this single fragment serves BOTH the preserve and non-preserve
// assemblies (mirroring how `ordered_hash_map_json.rs` is mode-agnostic). Encoding fields NEVER
// appear in JSON — JSON is the deliberately lossy side of the contract (a preserve value survives
// value-equal modulo encodings; a non-preserve value survives exactly for all finite floats).
//
// Rendering: every value is a single-key object whose key is the snake_case kind name:
//   uint       {"uint": 5}                 JSON number (u64 range, as serde_json emits crate-wide)
//   nint       {"nint": -3}                JSON number when the value fits i64,
//              {"nint": "-18446744073709551616"}  else a decimal string (the nint domain exceeds i64)
//   bytes      {"bytes": "a1b2"}           canonical hex — lowercase, even length, no 0x prefix,
//                                          on the read side as well (`any_cbor_hex_decode`)
//   text       {"text": "…"}
//   array      {"array": [ … ]}            recursive
//   map        {"map": [[K, V], …]}        array of pairs — wire order + duplicate keys preserved,
//                                          non-string keys representable
//   tag        {"tag": [11, V]}
//   bool       {"bool": true}
//   null       {"null": null}
//   undefined  {"undefined": null}
//   unassigned {"unassigned": 250}
//   float      {"float": 1.5}              finite floats as numbers;
//              {"float": "NaN"|"Infinity"|"-Infinity"}  non-finite as strings (serde_json cannot
//                                          represent them as numbers). NaN payload bits are NOT
//                                          round-tripped through JSON (the lossy-side charter).
//
// Map-key note (matches the crate-wide non-string-key-table posture): serde_json
// requires MAP keys to be strings. A `{* uint => any}` / `{* text => any}` table works (uint keys
// stringify, text keys verbatim); a `{* any => any}` (or any non-string-keyed) table serializes each
// key as an OBJECT, so `to_json` errors at runtime with "key must be a string" — exactly as a
// `{* bytes => uint}` table already does today. This is intentional consistency, not a new rule:
// generation accepts such tables and the runtime serde error is the honest signal. The demanded
// shape (`{* uint => any}` metadata tables) is unaffected.
impl serde::Serialize for AnyCbor {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(1))?;
        match self.kind() {
            AnyCborKind::UInt => {
                map.serialize_entry("uint", &self.as_uint().unwrap())?;
            }
            AnyCborKind::NInt => {
                let v = self.as_nint().unwrap();
                match i64::try_from(v) {
                    Ok(n) => map.serialize_entry("nint", &n)?,
                    Err(_) => map.serialize_entry("nint", &v.to_string())?,
                }
            }
            AnyCborKind::Bytes => {
                map.serialize_entry("bytes", &any_cbor_hex_encode(self.as_bytes().unwrap()))?;
            }
            AnyCborKind::Text => {
                map.serialize_entry("text", self.as_text().unwrap())?;
            }
            AnyCborKind::Array => {
                // &[AnyCbor] → JSON array, each element recursing through this impl.
                map.serialize_entry("array", self.as_array().unwrap())?;
            }
            AnyCborKind::Map => {
                // &[(AnyCbor, AnyCbor)] → JSON array of 2-element arrays (each tuple is a seq).
                map.serialize_entry("map", self.as_map().unwrap())?;
            }
            AnyCborKind::Tag => {
                let (tag, inner) = self.as_tag().unwrap();
                // (u64, &AnyCbor) → JSON array [tag, value].
                map.serialize_entry("tag", &(tag, inner))?;
            }
            AnyCborKind::Bool => {
                map.serialize_entry("bool", &self.as_bool().unwrap())?;
            }
            AnyCborKind::Null => {
                map.serialize_entry("null", &())?;
            }
            AnyCborKind::Undefined => {
                map.serialize_entry("undefined", &())?;
            }
            AnyCborKind::Unassigned => {
                map.serialize_entry("unassigned", &self.as_unassigned().unwrap())?;
            }
            AnyCborKind::Float => {
                let f = self.as_float().unwrap();
                if f.is_finite() {
                    map.serialize_entry("float", &f)?;
                } else if f.is_nan() {
                    map.serialize_entry("float", "NaN")?;
                } else if f > 0.0 {
                    map.serialize_entry("float", "Infinity")?;
                } else {
                    map.serialize_entry("float", "-Infinity")?;
                }
            }
        }
        map.end()
    }
}

/// A JSON nint payload: a number (must fit `i64`) or a decimal string (any magnitude in the domain).
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum AnyCborJsonNint {
    Num(i64),
    Str(String),
}

/// A JSON float payload: a finite number, or one of the three non-finite string sentinels.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum AnyCborJsonFloat {
    Num(f64),
    Str(String),
}

impl<'de> serde::Deserialize<'de> for AnyCbor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(AnyCborJsonVisitor)
    }
}

struct AnyCborJsonVisitor;

impl<'de> serde::de::Visitor<'de> for AnyCborJsonVisitor {
    type Value = AnyCbor;

    fn expecting(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
        f.write_str("a single-key CBOR-tagged JSON object (e.g. {\"uint\": 5})")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut access: A) -> Result<AnyCbor, A::Error> {
        use serde::de::Error;
        let key: String = access
            .next_key()?
            .ok_or_else(|| A::Error::custom("expected a single-key AnyCbor object, got {}"))?;
        let value = match key.as_str() {
            "uint" => AnyCbor::new_uint(access.next_value()?),
            "nint" => {
                let raw: i128 = match access.next_value::<AnyCborJsonNint>()? {
                    AnyCborJsonNint::Num(n) => n as i128,
                    AnyCborJsonNint::Str(s) => s
                        .parse::<i128>()
                        .map_err(|e| A::Error::custom(format!("nint decimal string: {e}")))?,
                };
                if !(-(1i128 << 64)..=-1).contains(&raw) {
                    return Err(A::Error::custom(format!(
                        "nint {raw} outside the CBOR nint domain -2^64..=-1"
                    )));
                }
                AnyCbor::new_nint(raw)
            }
            "bytes" => {
                let hex: String = access.next_value()?;
                AnyCbor::new_bytes(any_cbor_hex_decode(&hex).map_err(A::Error::custom)?)
            }
            "text" => AnyCbor::new_text(access.next_value()?),
            "array" => AnyCbor::new_array(access.next_value()?),
            "map" => AnyCbor::new_map(access.next_value()?),
            "tag" => {
                let (tag, inner): (u64, AnyCbor) = access.next_value()?;
                AnyCbor::new_tag(tag, inner)
            }
            "bool" => AnyCbor::new_bool(access.next_value()?),
            "null" => {
                access.next_value::<()>()?;
                AnyCbor::new_null()
            }
            "undefined" => {
                access.next_value::<()>()?;
                AnyCbor::new_undefined()
            }
            "unassigned" => AnyCbor::new_unassigned(access.next_value()?),
            "float" => {
                let f = match access.next_value::<AnyCborJsonFloat>()? {
                    AnyCborJsonFloat::Num(n) => n,
                    AnyCborJsonFloat::Str(s) => match s.as_str() {
                        "NaN" => f64::NAN,
                        "Infinity" => f64::INFINITY,
                        "-Infinity" => f64::NEG_INFINITY,
                        other => {
                            return Err(A::Error::custom(format!(
                                "unrecognized float string {other:?} (want a number or \
                                 \"NaN\"/\"Infinity\"/\"-Infinity\")"
                            )));
                        }
                    },
                };
                AnyCbor::new_float(f)
            }
            other => {
                return Err(A::Error::custom(format!(
                    "unknown AnyCbor kind key {other:?}"
                )));
            }
        };
        if access.next_key::<String>()?.is_some() {
            return Err(A::Error::custom(
                "an AnyCbor object must have exactly one key",
            ));
        }
        Ok(value)
    }
}

// =================================================================================================
// Natural-fallible JSON — the PRIMARY surface every *generated* type uses for an `any`-typed value.
// This is a SEPARATE surface from the tagged codec above: the tagged impls stay `AnyCbor`'s own
// `Serialize`/`Deserialize` (the total value-level escape hatch and the `AnyCbor` wasm-wrapper
// codec); generated members / enum arms / newtype wrappers instead route
// through `natural_any_cbor` (the `#[serde(with = …)]` adapter below), which renders the CBOR value
// as the JSON value it *naturally is* — `{ "count": 3 }` rather than `{ "map": [[{"text":"count"},
// {"uint":3}]] }`. Only natural rendering composes with static typing on the read side and only
// natural rendering is what a human-authored `from_json` document looks like.
//
// `to_natural_json` implements RFC 8949 §6.1's INJECTIVE subset and STRICT-FAILS everywhere §6.1
// would substitute a value (bytes, tags, `undefined`, unassigned simples, non-finite floats,
// out-of-i64 nints, complex/colliding map keys). No substitutes, ever: our output feeds a symmetric
// `from_natural_json`, so a silent substitution is write-back corruption. Consequence, by design:
// `to_json` on a generated type that *contains* an `any` is FALLIBLE on data — loudly (the error
// names the offending node kind), with `AnyCbor`'s tagged codec as the value-level escape hatch.
//
// `from_natural_json` is TOTAL (every JSON value has a CBOR home) and implements RFC 8949 §6.2:
// lexically-integral numbers become uint/nint (else float), object keys follow the `any`-domain
// prefer-numeric rule (a text key `"12"` JSON-round-trips to uint `12` — the documented JSON-only
// ambiguity; CBOR is authoritative).

// The natural walk builds a `serde_json::Value` and hands it to the caller's serializer. That final
// step goes through the sibling `json_value_ser` runtime module rather than `serde_json::Value`'s own
// `Serialize`, because the latter is DISHONEST in the serde data model under
// `serde_json/arbitrary_precision` (every number becomes a private `$serde_json::private::Number`
// token struct that only serde_json itself collapses — so `to_json()` looks right while
// `to_json_value()` and every other serializer ship the token). See `json_value_ser.rs` for the
// guarantees; it is emitted alongside this fragment under the same `--json-serde-derives` flag, so
// the path always resolves. Imported ONCE here at the `any_cbor` module level so every inner adapter
// module reaches it as `super::…` — the spelling that resolves both in-crate (`super` is `generated`)
// and under `--export-static-crate` (`super` is the target crate's flat module dir).
use super::json_value_ser::{JsonValueSer, serialize_json_value};

/// Error from [`to_natural_json`]: a CBOR node whose kind has no injective JSON image (RFC 8949
/// §6.1 strict-fail — no substitute values). The message names the offending kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnyToNaturalJsonError(pub String);

impl core::fmt::Display for AnyToNaturalJsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
        write!(
            f,
            "AnyCbor value has no natural JSON representation: {}",
            self.0
        )
    }
}

impl core::error::Error for AnyToNaturalJsonError {}

/// The natural-JSON string form of an `any` MAP KEY (used both for a key's object-property name and
/// for collision detection): text verbatim, uint/nint in decimal. Any other kind (bytes, array,
/// map, tag, float, bool, null, undefined, unassigned) has no key image → strict-fail.
pub fn any_cbor_natural_key_string(key: &AnyCbor) -> Result<String, AnyToNaturalJsonError> {
    match key.kind() {
        AnyCborKind::Text => Ok(key.as_text().unwrap().to_owned()),
        AnyCborKind::UInt => Ok(key.as_uint().unwrap().to_string()),
        AnyCborKind::NInt => Ok(key.as_nint().unwrap().to_string()),
        other => Err(AnyToNaturalJsonError(format!(
            "map key of kind {other:?} is not text/uint/nint"
        ))),
    }
}

/// Render an [`AnyCbor`] as the [`serde_json::Value`] it naturally is, or error naming the node kind
/// with no injective JSON image (RFC 8949 §6.1's strict-fail). Big uints (> 2^53) stay JSON numbers
/// (the documented I-JSON / RFC 7493 precision caveat, not a failure).
pub fn to_natural_json(value: &AnyCbor) -> Result<serde_json::Value, AnyToNaturalJsonError> {
    use serde_json::Value;
    match value.kind() {
        AnyCborKind::UInt => Ok(Value::from(value.as_uint().unwrap())),
        AnyCborKind::NInt => {
            // serde_json's number model bottoms out at i64; a nint below i64::MIN has no image.
            let n = value.as_nint().unwrap();
            match i64::try_from(n) {
                Ok(i) => Ok(Value::from(i)),
                Err(_) => Err(AnyToNaturalJsonError(format!(
                    "nint {n} is below i64::MIN (no JSON number image)"
                ))),
            }
        }
        AnyCborKind::Text => Ok(Value::from(value.as_text().unwrap().to_owned())),
        AnyCborKind::Bool => Ok(Value::from(value.as_bool().unwrap())),
        AnyCborKind::Null => Ok(Value::Null),
        AnyCborKind::Float => {
            let f = value.as_float().unwrap();
            // serde_json cannot hold non-finite numbers; NaN/±Inf strict-fail (JSON is lossy for
            // NaN payloads anyway; here the whole non-finite value has no number image).
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .ok_or_else(|| {
                    AnyToNaturalJsonError(format!("non-finite float {f} has no JSON number image"))
                })
        }
        AnyCborKind::Array => {
            let arr = value.as_array().unwrap();
            let mut out = Vec::with_capacity(arr.len());
            for elem in arr {
                out.push(to_natural_json(elem)?);
            }
            Ok(Value::Array(out))
        }
        AnyCborKind::Map => {
            let pairs = value.as_map().unwrap();
            let mut obj = serde_json::Map::new();
            // Determinism + collision detection: a `BTreeSet` of stringified keys. Two keys that
            // stringify identically (uint `12` + text `"12"`, or two equal keys) are a collision →
            // strict-fail (RFC 8949 §6.1's "danger of key collision"): our JSON feeds a symmetric read.
            let mut seen = alloc::collections::BTreeSet::new();
            for (key, val) in pairs {
                let key_string = any_cbor_natural_key_string(key)?;
                if !seen.insert(key_string.clone()) {
                    return Err(AnyToNaturalJsonError(format!(
                        "map key {key_string:?} stringifies identically to an earlier key"
                    )));
                }
                obj.insert(key_string, to_natural_json(val)?);
            }
            Ok(Value::Object(obj))
        }
        AnyCborKind::Bytes => Err(AnyToNaturalJsonError("bytes".into())),
        AnyCborKind::Tag => Err(AnyToNaturalJsonError("tag".into())),
        AnyCborKind::Undefined => Err(AnyToNaturalJsonError("undefined".into())),
        AnyCborKind::Unassigned => Err(AnyToNaturalJsonError("unassigned simple value".into())),
    }
}

/// The `any`-domain reading of a JSON object key (RFC 8949 §6.2 read convention): prefer the numeric reading for a
/// CANONICAL decimal spelling (round-trips through `to_string`), else text. So `"12"` → uint `12`,
/// `"-5"` → nint `-5`, but `"012"`/`"+5"`/`"5.0"`/`"abc"` → text. Total.
pub fn any_cbor_natural_key_from_string(key: &str) -> AnyCbor {
    // `.ok().filter(round-trips)` keeps this a single `if let` (no nested-if / no let-chain, so it
    // stays clippy-clean AND edition-agnostic in the generated crate). A canonical decimal spelling
    // round-trips through `to_string`; `"012"`/`"+3"`/`"-0"`/non-round-tripping forms fall to text.
    if let Some(u) = key.parse::<u64>().ok().filter(|u| u.to_string() == key) {
        return AnyCbor::new_uint(u);
    }
    // Keys are STRINGS, so a nint key has no `i64` ceiling (unlike a nint VALUE, bounded by
    // serde_json's number model): parse the whole CBOR nint domain (-2^64..=-1) as `i128`, matching
    // what `any_cbor_natural_key_string` writes. The domain check subsumes the sign check.
    if let Some(i) = key
        .parse::<i128>()
        .ok()
        .filter(|i| (-(1i128 << 64)..=-1).contains(i) && i.to_string() == key)
    {
        return AnyCbor::new_nint(i);
    }
    AnyCbor::new_text(key.to_owned())
}

/// The reverse of [`to_natural_json`]: every JSON value has a CBOR home (RFC 8949 §6.2).
/// TOTAL — never fails. Lexically-integral numbers become uint (non-negative) / nint (negative),
/// anything else (fractional / out-of-i64-magnitude) becomes a float; object keys use the
/// `any`-domain prefer-numeric rule.
pub fn from_natural_json(value: serde_json::Value) -> AnyCbor {
    use serde_json::Value;
    match value {
        Value::Null => AnyCbor::new_null(),
        Value::Bool(b) => AnyCbor::new_bool(b),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                AnyCbor::new_uint(u)
            } else if let Some(i) = n.as_i64() {
                // as_i64 with a non-u64 number is negative → in the nint domain.
                AnyCbor::new_nint(i as i128)
            } else {
                // Not lexically integral (has a fraction/exponent, or out of i64 magnitude).
                AnyCbor::new_float(n.as_f64().expect("serde_json number is u64/i64/f64"))
            }
        }
        Value::String(s) => AnyCbor::new_text(s),
        Value::Array(arr) => AnyCbor::new_array(arr.into_iter().map(from_natural_json).collect()),
        Value::Object(obj) => AnyCbor::new_map(
            obj.into_iter()
                .map(|(k, v)| (any_cbor_natural_key_from_string(&k), from_natural_json(v)))
                .collect(),
        ),
    }
}

/// `#[serde(with = "…::natural_any_cbor")]` adapter: the serde face a generated type puts on an
/// `any`-typed field/arm so it renders NATURALLY (not through `AnyCbor`'s tagged codec). Serialize
/// is fallible-on-data (RFC 8949 §6.1's failure set surfaces as a serde error naming the node kind);
/// deserialize is total (RFC 8949 §6.2).
pub mod natural_any_cbor {
    use super::{AnyCbor, from_natural_json, serialize_json_value, to_natural_json};

    pub fn serialize<S>(value: &AnyCbor, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let json = to_natural_json(value).map_err(serde::ser::Error::custom)?;
        serialize_json_value(&json, serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<AnyCbor, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let json = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
        Ok(from_natural_json(json))
    }
}

/// The `Option<AnyCbor>` companion to [`natural_any_cbor`], for an OPTIONAL `any` member (`? N: any`
/// → `Option<AnyCbor>`). A generated optional field pairs this with `#[serde(default)]` so a missing
/// key reads back as `None`, matching the derive's ordinary optional handling.
pub mod natural_any_cbor_opt {
    use super::{AnyCbor, JsonValueSer, from_natural_json, to_natural_json};

    pub fn serialize<S>(value: &Option<AnyCbor>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match value {
            Some(v) => {
                let json = to_natural_json(v).map_err(serde::ser::Error::custom)?;
                serializer.serialize_some(&JsonValueSer(&json))
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<AnyCbor>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let opt = <Option<serde_json::Value> as serde::Deserialize>::deserialize(deserializer)?;
        Ok(opt.map(from_natural_json))
    }
}

// A serde-only view of an `AnyCbor` that renders NATURALLY. Used purely to let serde's own
// container handling (`Vec`/`BTreeMap`/`OrderedHashMap` serde) walk the collection element-wise —
// this is serde composition, NOT a parallel JSON path (serde drives the container; the wrapper only
// swaps the per-element codec from tagged to natural).
pub struct NaturalAnyCborSer<'a>(pub &'a AnyCbor);

impl serde::Serialize for NaturalAnyCborSer<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        natural_any_cbor::serialize(self.0, serializer)
    }
}

pub struct NaturalAnyCborDe(pub AnyCbor);

impl<'de> serde::Deserialize<'de> for NaturalAnyCborDe {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        natural_any_cbor::deserialize(deserializer).map(NaturalAnyCborDe)
    }
}

/// `#[serde(with = …)]` adapter for a `Vec<AnyCbor>` member (homogeneous `[* any]` array as a
/// struct field), rendering each element naturally. Rides serde's own seq handling.
pub mod natural_any_cbor_seq {
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};
    // `super::alloc`, not `alloc` — the bounded hand-written exception; the full rationale is on
    // natural_any_cbor_btreemap's import in this file.
    use super::alloc::vec::Vec;

    pub fn serialize<S>(value: &[AnyCbor], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(value.iter().map(NaturalAnyCborSer))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<AnyCbor>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let elems = <Vec<NaturalAnyCborDe> as serde::Deserialize>::deserialize(deserializer)?;
        Ok(elems.into_iter().map(|e| e.0).collect())
    }
}

/// `#[serde(with = …)]` adapter for a `BTreeMap<K, AnyCbor>` member (a `{* K => any}` table with a
/// stringifiable key as a struct field, non-preserve). The KEY renders through its own serde (the
/// crate-wide table-key posture — a non-stringifiable `any` key still errors at runtime per RFC 8949 §6.1);
/// only the VALUE flips to natural. Generic over `K` so one module serves every key type.
pub mod natural_any_cbor_btreemap {
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};
    // `super::alloc`, not `alloc`: a file-top `extern crate alloc;` binds the crate name in the
    // FILE's module, and a nested inline module does not inherit that binding (a bare
    // `use alloc::…` here is E0433). This is the bounded hand-written exception to "static
    // sources carry no alloc imports" — the alloc-import injector deliberately does not scan
    // nested module bodies, because a file-top import it added for them would be unused at file
    // scope and still would not resolve in here. The injector DOES count this `super::alloc`
    // reference when deciding to emit the file-top `extern crate alloc;` this resolves through.
    use super::alloc::collections::BTreeMap;

    pub fn serialize<K, S>(value: &BTreeMap<K, AnyCbor>, serializer: S) -> Result<S::Ok, S::Error>
    where
        K: serde::Serialize,
        S: serde::Serializer,
    {
        serializer.collect_map(value.iter().map(|(k, v)| (k, NaturalAnyCborSer(v))))
    }

    pub fn deserialize<'de, K, D>(deserializer: D) -> Result<BTreeMap<K, AnyCbor>, D::Error>
    where
        K: serde::Deserialize<'de> + Ord,
        D: serde::Deserializer<'de>,
    {
        let map = <BTreeMap<K, NaturalAnyCborDe> as serde::Deserialize>::deserialize(deserializer)?;
        Ok(map.into_iter().map(|(k, v)| (k, v.0)).collect())
    }
}

/// `#[serde(with = …)]` adapter for an OPTIONAL homogeneous-array member (`? N: [* any]` →
/// `Option<Vec<AnyCbor>>`), paired with `#[serde(default)]`. `None` → JSON null / missing.
pub mod natural_any_cbor_opt_seq {
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};
    // `super::alloc`, not `alloc` — the bounded hand-written exception; the full rationale is on
    // natural_any_cbor_btreemap's import in this file.
    use super::alloc::vec::Vec;

    pub fn serialize<S>(value: &Option<Vec<AnyCbor>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match value {
            Some(v) => {
                let wrapped: Vec<NaturalAnyCborSer> = v.iter().map(NaturalAnyCborSer).collect();
                serializer.serialize_some(&wrapped)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Vec<AnyCbor>>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let opt = <Option<Vec<NaturalAnyCborDe>> as serde::Deserialize>::deserialize(deserializer)?;
        Ok(opt.map(|v| v.into_iter().map(|e| e.0).collect()))
    }
}

/// `#[serde(with = …)]` adapter for an OPTIONAL non-preserve table member (`? N: {* K => any}` →
/// `Option<BTreeMap<K, AnyCbor>>`), paired with `#[serde(default)]`.
pub mod natural_any_cbor_opt_btreemap {
    use super::alloc::collections::BTreeMap;
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};

    pub fn serialize<K, S>(
        value: &Option<BTreeMap<K, AnyCbor>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        K: serde::Serialize + Ord,
        S: serde::Serializer,
    {
        match value {
            Some(m) => {
                let wrapped: BTreeMap<&K, NaturalAnyCborSer> =
                    m.iter().map(|(k, v)| (k, NaturalAnyCborSer(v))).collect();
                serializer.serialize_some(&wrapped)
            }
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, K, D>(deserializer: D) -> Result<Option<BTreeMap<K, AnyCbor>>, D::Error>
    where
        K: serde::Deserialize<'de> + Ord,
        D: serde::Deserializer<'de>,
    {
        let opt = <Option<BTreeMap<K, NaturalAnyCborDe>> as serde::Deserialize>::deserialize(
            deserializer,
        )?;
        Ok(opt.map(|m| m.into_iter().map(|(k, v)| (k, v.0)).collect()))
    }
}

/// Lowercase hex of a byte slice (self-contained — the `hex` crate is not always a dep here).
fn any_cbor_hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// Parses **canonical** hex into bytes — lowercase digits only, even length, no `0x`/`0X` prefix.
///
/// The grammar is deliberately the one `decode_canonical_hex` accepts on the crate's other two hex
/// surfaces (`RawBytesEncoding::from_raw_hex` and a `bytes` newtype's JSON form), so hex text has a
/// single canonical spelling tool-wide: for every accepted `s`, `any_cbor_hex_encode` of the decoded
/// bytes reproduces `s` byte for byte — the round-trip property on the ENCODING and not merely on
/// the bytes. This stays a SEPARATE, self-contained routine rather than a call into that function
/// because a crate emitting `AnyCbor` need not take the `hex` dependency at all, and it keeps its
/// own error surface: `String` messages rendered through serde's `Error::custom`, with odd length
/// reported BEFORE any bad nibble (the shared door reports the first offending character first).
///
/// Full rationale lives on `decode_canonical_hex`.
fn any_cbor_hex_decode(s: &str) -> Result<Vec<u8>, String> {
    /// The canonical alphabet, i.e. exactly what `any_cbor_hex_encode` writes. `char::to_digit(16)`
    /// would also take `A`–`F`, which is the leniency this surface no longer has.
    fn nibble(b: u8) -> Result<u32, String> {
        match b {
            b'0'..=b'9' => Ok((b - b'0') as u32),
            b'a'..=b'f' => Ok((b - b'a') as u32 + 10),
            _ => Err(format!("invalid hex nibble {:?}", b as char)),
        }
    }
    if s.len() & 1 == 1 {
        return Err(format!("odd-length hex string (len {})", s.len()));
    }
    let bytes = s.as_bytes();
    (0..bytes.len())
        .step_by(2)
        .map(|i| Ok(((nibble(bytes[i])? << 4) | nibble(bytes[i + 1])?) as u8))
        .collect()
}
// Natural JSON adapters for `[AnyCbor; N]`. Serde's generic array support keeps wide arrays
// available, while staging through Vec retains a single fallible cardinality handover.
pub mod natural_any_cbor_static_seq {
    use super::alloc::vec::Vec;
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};

    pub fn serialize<S, const N: usize>(
        value: &[AnyCbor; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(value.iter().map(NaturalAnyCborSer))
    }

    pub fn deserialize<'de, D, const N: usize>(deserializer: D) -> Result<[AnyCbor; N], D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let elems = <Vec<NaturalAnyCborDe> as serde::Deserialize>::deserialize(deserializer)?;
        elems
            .into_iter()
            .map(|e| e.0)
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|values: Vec<_>| {
                serde::de::Error::custom(super::alloc::format!(
                    "array length {} does not equal {N}",
                    values.len()
                ))
            })
    }
}

pub mod natural_any_cbor_opt_static_seq {
    use super::alloc::vec::Vec;
    use super::{AnyCbor, NaturalAnyCborDe, NaturalAnyCborSer};

    pub fn serialize<S, const N: usize>(
        value: &Option<[AnyCbor; N]>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match value {
            Some(value) => serializer.collect_seq(value.iter().map(NaturalAnyCborSer)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D, const N: usize>(
        deserializer: D,
    ) -> Result<Option<[AnyCbor; N]>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        <Option<Vec<NaturalAnyCborDe>> as serde::Deserialize>::deserialize(deserializer)?
            .map(|elems| {
                elems
                    .into_iter()
                    .map(|e| e.0)
                    .collect::<Vec<_>>()
                    .try_into()
                    .map_err(|values: Vec<_>| {
                        serde::de::Error::custom(super::alloc::format!(
                            "array length {} does not equal {N}",
                            values.len()
                        ))
                    })
            })
            .transpose()
    }
}
// Manual `schemars::JsonSchema` for `AnyCbor`, matching the `any_cbor_json.rs` rendering: a
// self-referential `oneOf` over the twelve single-key tagged-object forms. Precedent for a manual
// impl on a runtime type: `ordered_hash_map_schemars.rs`. The schema flows into the json-gen crate
// and through `run-json2ts.js`; the json2ts acceptance of this self-referential schema is a named
// pre-ship gate.
//
// Routed through `schemars::json_schema!` (which uses schemars' own bundled serde_json), so this
// compiles under `--json-schema-export` even when `--json-serde-derives` is off (serde_json is only
// a direct dep under the serde flag).
impl schemars::JsonSchema for AnyCbor {
    fn schema_name() -> alloc::borrow::Cow<'static, str> {
        "AnyCbor".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        // Self-reference for the recursive positions (array items, map pair elements, tag value).
        // `subschema_for::<AnyCbor>` registers AnyCbor in the generator's definitions and returns a
        // `$ref` schema. AnyCbor is mid-generation at this point, so the generator returns a ref
        // rather than inlining — `inline_schema` returning false guarantees the recursion terminates.
        let any = generator.subschema_for::<AnyCbor>().to_value();
        schemars::json_schema!({
            "oneOf": [
                { "type": "object", "additionalProperties": false, "required": ["uint"],
                  "properties": { "uint": { "type": "integer", "minimum": 0 } } },
                { "type": "object", "additionalProperties": false, "required": ["nint"],
                  "properties": { "nint": { "type": ["integer", "string"] } } },
                { "type": "object", "additionalProperties": false, "required": ["bytes"],
                  "properties": { "bytes": { "type": "string" } } },
                { "type": "object", "additionalProperties": false, "required": ["text"],
                  "properties": { "text": { "type": "string" } } },
                { "type": "object", "additionalProperties": false, "required": ["array"],
                  "properties": { "array": { "type": "array", "items": (any.clone()) } } },
                { "type": "object", "additionalProperties": false, "required": ["map"],
                  "properties": { "map": { "type": "array",
                      "items": { "type": "array", "minItems": 2, "maxItems": 2,
                          "prefixItems": [(any.clone()), (any.clone())] } } } },
                { "type": "object", "additionalProperties": false, "required": ["tag"],
                  "properties": { "tag": { "type": "array", "minItems": 2, "maxItems": 2,
                      "prefixItems": [ { "type": "integer", "minimum": 0 }, (any.clone()) ] } } },
                { "type": "object", "additionalProperties": false, "required": ["bool"],
                  "properties": { "bool": { "type": "boolean" } } },
                { "type": "object", "additionalProperties": false, "required": ["null"],
                  "properties": { "null": { "type": "null" } } },
                { "type": "object", "additionalProperties": false, "required": ["undefined"],
                  "properties": { "undefined": { "type": "null" } } },
                { "type": "object", "additionalProperties": false, "required": ["unassigned"],
                  "properties": { "unassigned": { "type": "integer", "minimum": 0, "maximum": 255 } } },
                { "type": "object", "additionalProperties": false, "required": ["float"],
                  "properties": { "float": { "type": ["number", "string"] } } }
            ]
        })
    }

    fn inline_schema() -> bool {
        false
    }
}

/// The `#[schemars(schema_with = "…::natural_any_cbor_schema")]` companion to the
/// `natural_any_cbor` serde adapter: the schema a GENERATED type puts on an `any`-typed field/arm
/// so it describes the NATURAL rendering. It is the permissive "any JSON value" schema (an empty
/// schema accepts everything) because the natural rendering of an arbitrary CBOR value can be any
/// JSON value — json2ts turns it into TS `unknown`. This is deliberately DISTINCT from `AnyCbor`'s
/// own tagged `oneOf` schema above, which describes the tagged value-codec surface (the `AnyCbor`
/// wasm wrapper's `to_json`), and is left as `AnyCbor`'s own schema.
pub fn natural_any_cbor_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({})
}

/// Companion to `natural_any_cbor_seq` (a `Vec<AnyCbor>` member, `[* any]`): an array whose items
/// are the permissive "any JSON value" schema.
pub fn natural_any_cbor_seq_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "items": {} })
}

/// Companion to `natural_any_cbor_btreemap` (a `{* K => any}` table member with a stringifiable
/// key): an object whose additional-property values are the permissive "any JSON value" schema.
pub fn natural_any_cbor_map_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "object", "additionalProperties": {} })
}
// Natural JSON schema for `[AnyCbor; N]`: arbitrary JSON values, exact cardinality.
pub fn natural_any_cbor_static_seq_schema<const N: usize>(
    _generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    let mut schema = schemars::json_schema!({ "type": "array", "items": {} });
    schema.insert("minItems".to_owned(), (N as u64).into());
    schema.insert("maxItems".to_owned(), (N as u64).into());
    schema
}

/// Optional natural `[AnyCbor; N]`: the serde adapter writes `None` as JSON null while `Some`
/// retains the exact array branch.
pub fn natural_any_cbor_opt_static_seq_schema<const N: usize>(
    _generator: &mut schemars::SchemaGenerator,
) -> schemars::Schema {
    let array = self::natural_any_cbor_static_seq_schema::<N>(_generator);
    schemars::json_schema!({
        "anyOf": [array.to_value(), { "type": "null" }],
    })
}
