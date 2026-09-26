// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

// same as cbor_event::de::Deserialize but with our DeserializeError
extern crate alloc;
use alloc::borrow::ToOwned;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
pub trait Deserialize {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError>
    where
        Self: Sized;

    // cbor_event's Deserializer owns its buffer, so this copies `data` once (O(n))
    /// Deserialize from this type's CBOR form.
    /// For a type that also has a raw-bytes form (e.g. one implementing `RawBytesEncoding`),
    /// this expects the CBOR byte-string encoding (type/length header plus payload),
    /// where `from_raw_bytes` takes the bare payload.
    fn from_cbor_bytes(data: &[u8]) -> Result<Self, DeserializeError>
    where
        Self: Sized,
    {
        let mut raw = Deserializer::from(data.to_vec());
        let value = Self::deserialize(&mut raw)?;
        // Reject leftover bytes after a complete value instead of silently ignoring them: otherwise a
        // truncated/corrupt or accidentally-concatenated buffer would deserialize as Ok.
        // Hand-rolled rather than cbor_event's deserialize_complete(): that helper is bounded to
        // cbor_event's own Deserialize trait and error type, while this trait must surface the
        // annotated DeserializeError.
        if !raw.as_slice().is_empty() {
            return Err(DeserializeFailure::CBOR(cbor_event::Error::TrailingData).into());
        }
        Ok(value)
    }
}

impl<T: cbor_event::de::Deserialize> Deserialize for T {
    fn deserialize(raw: &mut Deserializer) -> Result<T, DeserializeError> {
        T::deserialize(raw).map_err(DeserializeError::from)
    }
}

/// Rank of a CBOR float WIDTH in width order (2 < 4 < 8 bytes, RFC 8949 §3.3). It ranks the width
/// of a VALUE's shortest lossless form against the window a CDDL float class spans — never the head
/// a value happened to arrive under. The float-invalid `Sz::Inline`/`Sz::One` — which neither
/// `smallest_float_sz` nor a `float_sz()` read produces, but a hand-built encoding struct can hold —
/// sort with the widest width, so they can never pass a window check the widest width itself would
/// not.
fn float_width_rank(sz: cbor_event::Sz) -> u8 {
    match sz {
        cbor_event::Sz::Two => 0,
        cbor_event::Sz::Four => 1,
        _ => 2,
    }
}

/// Whether `value` belongs to a CDDL float class spanning the widths `min_width..=max_width`, and
/// therefore the width it writes at — the two are one question.
///
/// The CDDL float prelude names constrain VALUES, not encodings: RFC 8610 §2.2.3 says the `#7.x`
/// notation "is about a set of values at the data model level … it does not mandate that these
/// values also do have to be serialized as half-precision floats: CDDL does not provide any language
/// means to restrict the choice of serialization variants", and §3.3 defines `float32` as "a number
/// representable as a single-precision float". The six names PARTITION the float values by their
/// shortest lossless form: `float16` is the values whose shortest form is `#7.25`, `float32` `#7.26`,
/// `float64` `#7.27`, with `float16-32`/`float32-64` spanning two and `float` all three. So
/// membership is `smallest_float_sz(value)` landing inside the class's window, and the classes are
/// DISJOINT — `1.5` is a `float16` and not a `float32`, whatever head it arrived under.
///
/// The width a MEMBER writes at is exactly that shortest form (RFC 8949 §4.1 preferred
/// serialization), which is its declared width by construction: membership IS "shortest form lands
/// in the window". A NON-member — `1.5` assigned to a `float32` field, say — has no width to write
/// at and fails LOUDLY here rather than being encoded, because a wider head would emit bytes this
/// crate's own decoder rejects and a narrower one would round the value.
///
/// The failure is `cbor_event::Error::InvalidLenPassed` carrying the width the value REQUIRES, which
/// is the actionable fact and the one the class does not admit. That error rather than a
/// message-carrying `CustomError`: this is a `core`-only path (a `String` would pull in `alloc`), and
/// it is the same error identity the lossy-narrowing case has always failed with.
pub fn float_class_width(
    value: f64,
    min_width: cbor_event::Sz,
    max_width: cbor_event::Sz,
) -> cbor_event::Result<cbor_event::Sz> {
    let smallest = cbor_event::se::smallest_float_sz(value);
    if float_width_rank(smallest) < float_width_rank(min_width)
        || float_width_rank(smallest) > float_width_rank(max_width)
    {
        return Err(cbor_event::Error::InvalidLenPassed(smallest));
    }
    Ok(smallest)
}

/// Exact `f64` -> `f32` narrowing for a value a class-membership check has ALREADY proven fits:
/// every value an `f32`-carried CDDL float class admits has a shortest lossless form of `#7.25` or
/// `#7.26` and is therefore f32-exact by construction, so the miss arm is unreachable. It panics
/// rather than erroring because reaching it would mean the membership check above it is wrong — a
/// generator bug, not malformed input.
///
/// Never an `as` cast: that rounds silently, and its NaN-payload behaviour is not merely
/// platform-dependent — LLVM const-folds the conversion to a canonical quiet NaN, so `as` can differ
/// between the const-evaluated and runtime paths of ONE binary. The widening direction goes through
/// `cbor_event::se::f32_to_f64_exact` for the same reason.
pub fn narrow_f32(value: f64) -> f32 {
    cbor_event::se::f64_to_f32_exact(value)
        .expect("a value an f32-carried CDDL float class admits is f32-exact by construction")
}

/// Read a float belonging to a CDDL class spanning the widths `min_width..=max_width` (`float32` is
/// `#7.26` alone; `float16-32` is `#7.25`/`#7.26`; `float` spans all three).
///
/// ANY float head is accepted — `f9`, `fa` and `fb` alike — and the decoded VALUE is then tested for
/// membership (see [`float_class_width`]). Acceptance cannot key on the head: a CDDL float name is a
/// set of values, and RFC 8949 §4.1 preferred serialization lets any conforming encoder write `1.5`
/// as `f9 3e00`, so a head-strict reader would reject its own class's canonical bytes. The returned
/// `sz` is the real WIRE width, which is what `--preserve-encodings` replays; it is deliberately not
/// constrained to the window, since an `fb`-headed `1.5` is a `float16` whose byte-exact round-trip
/// needs the `fb` back.
///
/// A non-member is a decode ERROR reporting the width the VALUE requires — never a silent widening
/// or narrowing, which would make a `float32` member's decoded value depend on a value its own type
/// excludes.
pub fn read_float_sz_width(
    raw: &mut Deserializer,
    min_width: cbor_event::Sz,
    max_width: cbor_event::Sz,
) -> Result<(f64, cbor_event::Sz), DeserializeError> {
    let (value, sz) = raw.float_sz()?;
    let smallest = cbor_event::se::smallest_float_sz(value);
    if float_width_rank(smallest) < float_width_rank(min_width)
        || float_width_rank(smallest) > float_width_rank(max_width)
    {
        return Err(DeserializeFailure::FloatWidth {
            found: smallest,
            min: min_width,
            max: max_width,
        }
        .into());
    }
    Ok((value, sz))
}

/// [`read_float_sz_width`] dropping the wire width — the non-`--preserve-encodings` form, where the
/// value's class membership is checked but no width is recorded.
pub fn read_float_width(
    raw: &mut Deserializer,
    min_width: cbor_event::Sz,
    max_width: cbor_event::Sz,
) -> Result<f64, DeserializeError> {
    read_float_sz_width(raw, min_width, max_width).map(|(value, _)| value)
}
pub struct CBORReadLen {
    deser_len: cbor_event::Len,
    read: u64,
}

impl CBORReadLen {
    pub fn new(len: cbor_event::Len) -> Self {
        Self {
            deser_len: len,
            read: 0,
        }
    }

    pub fn read(&self) -> u64 {
        self.read
    }

    // Marks {n} values as being read, and if we go past the available definite length
    // given by the CBOR, we return an error.
    pub fn read_elems(&mut self, count: usize) -> Result<(), DeserializeFailure> {
        match self.deser_len {
            cbor_event::Len::Len(n) => {
                self.read += count as u64;
                if self.read > n {
                    Err(DeserializeFailure::DefiniteLenMismatch(n, None))
                } else {
                    Ok(())
                }
            }
            cbor_event::Len::Indefinite => Ok(()),
        }
    }

    pub fn finish(&self) -> Result<(), DeserializeFailure> {
        match self.deser_len {
            cbor_event::Len::Len(n) => {
                if self.read == n {
                    Ok(())
                } else {
                    Err(DeserializeFailure::DefiniteLenMismatch(n, Some(self.read)))
                }
            }
            cbor_event::Len::Indefinite => Ok(()),
        }
    }
}

// allows a crate exported by cddl-codegen to serve as a --common-import-override target for
// preserve-encodings=false crates, which construct CBORReadLen via From<cbor_event::Len>
impl From<cbor_event::Len> for CBORReadLen {
    fn from(len: cbor_event::Len) -> Self {
        Self::new(len)
    }
}

pub trait DeserializeEmbeddedGroup {
    fn deserialize_as_embedded_group(
        raw: &mut Deserializer,
        read_len: &mut CBORReadLen,
        len: cbor_event::Len,
    ) -> Result<Self, DeserializeError>
    where
        Self: Sized;
}

/// Write a float at the smallest head that preserves its value exactly — RFC 8949 §4.1 preferred
/// serialization, uniformly, the same rule the integer writes follow. The
/// `--preserve-encodings` twin of this name additionally replays a recorded wire width; without that
/// flag there is none to replay, so the smallest form is the whole rule.
pub fn write_float(serializer: &mut Serializer, value: f64) -> cbor_event::Result<&mut Serializer> {
    serializer.write_float_sz(value, cbor_event::se::smallest_float_sz(value))
}

/// Write a float belonging to a CDDL class spanning the widths `min_width..=max_width`, at the
/// smallest head that preserves its value (RFC 8949 §4.1) — which for a member of the class IS its
/// declared width, since membership means the value's shortest lossless form lands in the window.
///
/// A NON-member — `1.5` assigned to a `float32` field — fails LOUDLY in `float_class_width` rather
/// than being written at a head the class admits: those bytes would decode to a value this crate's
/// own reader rejects for that field. See [`float_class_width`] for the value-set semantics.
pub fn write_float_width(
    serializer: &mut Serializer,
    value: f64,
    min_width: cbor_event::Sz,
    max_width: cbor_event::Sz,
) -> cbor_event::Result<&mut Serializer> {
    let width = float_class_width(value, min_width, max_width)?;
    serializer.write_float_sz(value, width)
}
pub trait SerializeEmbeddedGroup {
    fn serialize_as_embedded_group<'a>(
        &self,
        serializer: &'a mut Serializer,
    ) -> cbor_event::Result<&'a mut Serializer>;
}

pub trait ToCBORBytes {
    fn to_cbor_bytes(&self) -> Vec<u8>;
}

impl<T: cbor_event::se::Serialize> ToCBORBytes for T {
    fn to_cbor_bytes(&self) -> Vec<u8> {
        let mut buf = Serializer::new_vec();
        self.serialize(&mut buf).unwrap();
        buf.finalize()
    }
}

use super::*;
use crate::generated::error::*;
use cbor_event::de::Deserializer;
use cbor_event::se::{Serialize, Serializer};

impl cbor_event::se::Serialize for DeviceRef {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("name")?;
        serializer.write_text(&self.name)?;
        serializer.write_text("device_id")?;
        serializer.write_bytes(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for DeviceRef {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut name = None;
            let mut device_id = None;
            let mut read = 0;
            while match len {
                cbor_event::Len::Len(n) => read < n,
                cbor_event::Len::Indefinite => true,
            } {
                match raw.cbor_type()? {
                    cbor_event::Type::UnsignedInteger => {
                        return Err(DeserializeFailure::UnknownKey(Key::Uint(
                            raw.unsigned_integer()?,
                        ))
                        .into());
                    }
                    cbor_event::Type::Text => match raw.text()?.as_str() {
                        "name" => {
                            if name.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "name".into(),
                                ))
                                .into());
                            }
                            name = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("name"))?,
                            );
                        }
                        "device_id" => {
                            if device_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "device_id".into(),
                                ))
                                .into());
                            }
                            device_id = Some(
                                Ok::<_, DeserializeError>(raw.bytes()?)
                                    .and_then(|bytes| {
                                        bytes.try_into().map_err(|bytes: Vec<u8>| {
                                            DeserializeFailure::RangeCheck {
                                                found: bytes.len() as i128,
                                                min: Some(16),
                                                max: Some(16),
                                            }
                                            .into()
                                        })
                                    })
                                    .map(|bytes: [u8; 16]| bytes)
                                    .map_err(|e: DeserializeError| e.annotate("device_id"))?,
                            );
                        }
                        unknown_key => {
                            return Err(DeserializeFailure::UnknownKey(Key::Str(
                                unknown_key.to_owned(),
                            ))
                            .into());
                        }
                    },
                    cbor_event::Type::Special => match len {
                        cbor_event::Len::Len(_) => {
                            return Err(DeserializeFailure::BreakInDefiniteLen.into());
                        }
                        cbor_event::Len::Indefinite => match raw.special()? {
                            cbor_event::Special::Break => break,
                            _ => return Err(DeserializeFailure::EndingBreakMissing.into()),
                        },
                    },
                    other_type => {
                        return Err(DeserializeFailure::UnexpectedKeyType(other_type).into());
                    }
                }
                read += 1;
            }
            let device_id =
                match device_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("device_id"),
                        ))
                        .into());
                    }
                };
            let name = match name {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("name")))
                            .into(),
                    );
                }
            };
            Ok(Self { device_id, name })
        })()
        .map_err(|e| e.annotate("DeviceRef"))
    }
}

impl cbor_event::se::Serialize for Item {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(
            2 + match &self.name {
                Some(_) => 1,
                None => 0,
            } + match &self.mime {
                Some(_) => 1,
                None => 0,
            } + match &self.size {
                Some(_) => 1,
                None => 0,
            } + match &self.hash {
                Some(_) => 1,
                None => 0,
            } + match &self.text {
                Some(_) => 1,
                None => 0,
            } + match &self.chunk_size {
                Some(_) => 1,
                None => 0,
            } + match &self.chunk_count {
                Some(_) => 1,
                None => 0,
            } + match &self.children {
                Some(_) => 1,
                None => 0,
            } + match &self.reply_to {
                Some(_) => 1,
                None => 0,
            } + match &self.attrs {
                Some(_) => 1,
                None => 0,
            },
        ))?;
        if let Some(field) = &self.hash {
            serializer.write_text("hash")?;
            serializer.write_bytes(field)?;
        }
        if let Some(field) = &self.mime {
            serializer.write_text("mime")?;
            serializer.write_text(field)?;
        }
        if let Some(field) = &self.name {
            serializer.write_text("name")?;
            serializer.write_text(field)?;
        }
        if let Some(field) = &self.size {
            serializer.write_text("size")?;
            serializer.write_unsigned_integer(*field)?;
        }
        if let Some(field) = &self.text {
            serializer.write_text("text")?;
            serializer.write_text(field)?;
        }
        serializer.write_text("type")?;
        serializer.write_text(&self.item_type)?;
        if let Some(field) = &self.attrs {
            serializer.write_text("attrs")?;
            serializer.write_map(cbor_event::Len::Len(field.len() as u64))?;
            for (key, value) in field.iter() {
                serializer.write_text(key)?;
                value.serialize(serializer)?;
            }
        }
        serializer.write_text("index")?;
        serializer.write_unsigned_integer(self.index)?;
        if let Some(field) = &self.children {
            serializer.write_text("children")?;
            serializer.write_array(cbor_event::Len::Len(field.len() as u64))?;
            for element in field.iter() {
                element.serialize(serializer)?;
            }
        }
        if let Some(field) = &self.reply_to {
            serializer.write_text("reply_to")?;
            serializer.write_bytes(field)?;
        }
        if let Some(field) = &self.chunk_size {
            serializer.write_text("chunk_size")?;
            serializer.write_unsigned_integer(*field)?;
        }
        if let Some(field) = &self.chunk_count {
            serializer.write_text("chunk_count")?;
            serializer.write_unsigned_integer(*field)?;
        }
        Ok(serializer)
    }
}

impl Deserialize for Item {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            let mut hash = None;
            let mut mime = None;
            let mut name = None;
            let mut size = None;
            let mut text = None;
            let mut item_type = None;
            let mut attrs = None;
            let mut index = None;
            let mut children = None;
            let mut reply_to = None;
            let mut chunk_size = None;
            let mut chunk_count = None;
            let mut read = 0;
            while match len {
                cbor_event::Len::Len(n) => read < n,
                cbor_event::Len::Indefinite => true,
            } {
                match raw.cbor_type()? {
                    cbor_event::Type::UnsignedInteger => {
                        return Err(DeserializeFailure::UnknownKey(Key::Uint(
                            raw.unsigned_integer()?,
                        ))
                        .into());
                    }
                    cbor_event::Type::Text => match raw.text()?.as_str() {
                        "hash" => {
                            if hash.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "hash".into(),
                                ))
                                .into());
                            }
                            hash = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok::<_, DeserializeError>(raw.bytes()?)
                                        .and_then(|bytes| {
                                            bytes.try_into().map_err(|bytes: Vec<u8>| {
                                                DeserializeFailure::RangeCheck {
                                                    found: bytes.len() as i128,
                                                    min: Some(32),
                                                    max: Some(32),
                                                }
                                                .into()
                                            })
                                        })
                                        .map(|bytes: [u8; 32]| bytes)
                                })()
                                .map_err(|e| e.annotate("hash"))?,
                            );
                        }
                        "mime" => {
                            if mime.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "mime".into(),
                                ))
                                .into());
                            }
                            mime = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.text()?)
                                })()
                                .map_err(|e| e.annotate("mime"))?,
                            );
                        }
                        "name" => {
                            if name.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "name".into(),
                                ))
                                .into());
                            }
                            name = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.text()?)
                                })()
                                .map_err(|e| e.annotate("name"))?,
                            );
                        }
                        "size" => {
                            if size.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "size".into(),
                                ))
                                .into());
                            }
                            size = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.unsigned_integer()?)
                                })()
                                .map_err(|e| e.annotate("size"))?,
                            );
                        }
                        "text" => {
                            if text.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "text".into(),
                                ))
                                .into());
                            }
                            text = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.text()?)
                                })()
                                .map_err(|e| e.annotate("text"))?,
                            );
                        }
                        "type" => {
                            if item_type.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "type".into(),
                                ))
                                .into());
                            }
                            item_type = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("item_type"))?,
                            );
                        }
                        "attrs" => {
                            if attrs.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "attrs".into(),
                                ))
                                .into());
                            }
                            attrs = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    let mut attrs_table = BTreeMap::new();
                                    let attrs_len = raw.map()?;
                                    while match attrs_len {
                                        cbor_event::Len::Len(n) => (attrs_table.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(attrs_len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        let attrs_key = raw.text()?;
                                        let attrs_value =
                                            crate::generated::any_cbor::AnyCbor::deserialize(raw)?;
                                        if attrs_table
                                            .insert(attrs_key.clone(), attrs_value)
                                            .is_some()
                                        {
                                            return Err(DeserializeFailure::DuplicateKey(
                                                Key::Str(attrs_key),
                                            )
                                            .into());
                                        }
                                    }
                                    Ok(attrs_table)
                                })()
                                .map_err(|e| e.annotate("attrs"))?,
                            );
                        }
                        "index" => {
                            if index.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "index".into(),
                                ))
                                .into());
                            }
                            index = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("index"))?,
                            );
                        }
                        "children" => {
                            if children.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "children".into(),
                                ))
                                .into());
                            }
                            children = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    let mut children_arr = Vec::new();
                                    let len = raw.array()?;
                                    while match len {
                                        cbor_event::Len::Len(n) => (children_arr.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        children_arr.push(Item::deserialize(raw)?);
                                    }
                                    Ok(children_arr)
                                })()
                                .map_err(|e| e.annotate("children"))?,
                            );
                        }
                        "reply_to" => {
                            if reply_to.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "reply_to".into(),
                                ))
                                .into());
                            }
                            reply_to = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok::<_, DeserializeError>(raw.bytes()?)
                                        .and_then(|bytes| {
                                            bytes.try_into().map_err(|bytes: Vec<u8>| {
                                                DeserializeFailure::RangeCheck {
                                                    found: bytes.len() as i128,
                                                    min: Some(16),
                                                    max: Some(16),
                                                }
                                                .into()
                                            })
                                        })
                                        .map(|bytes: [u8; 16]| bytes)
                                })()
                                .map_err(|e| e.annotate("reply_to"))?,
                            );
                        }
                        "chunk_size" => {
                            if chunk_size.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "chunk_size".into(),
                                ))
                                .into());
                            }
                            chunk_size = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.unsigned_integer()?)
                                })()
                                .map_err(|e| e.annotate("chunk_size"))?,
                            );
                        }
                        "chunk_count" => {
                            if chunk_count.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "chunk_count".into(),
                                ))
                                .into());
                            }
                            chunk_count = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.unsigned_integer()?)
                                })()
                                .map_err(|e| e.annotate("chunk_count"))?,
                            );
                        }
                        unknown_key => {
                            return Err(DeserializeFailure::UnknownKey(Key::Str(
                                unknown_key.to_owned(),
                            ))
                            .into());
                        }
                    },
                    cbor_event::Type::Special => match len {
                        cbor_event::Len::Len(_) => {
                            return Err(DeserializeFailure::BreakInDefiniteLen.into());
                        }
                        cbor_event::Len::Indefinite => match raw.special()? {
                            cbor_event::Special::Break => break,
                            _ => return Err(DeserializeFailure::EndingBreakMissing.into()),
                        },
                    },
                    other_type => {
                        return Err(DeserializeFailure::UnexpectedKeyType(other_type).into());
                    }
                }
                read += 1;
            }
            let index = match index {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("index")))
                            .into(),
                    );
                }
            };
            let item_type = match item_type {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("type")))
                            .into(),
                    );
                }
            };
            read_len.finish()?;
            Ok(Self {
                index,
                item_type,
                name,
                mime,
                size,
                hash,
                text,
                chunk_size,
                chunk_count,
                children,
                reply_to,
                attrs,
            })
        })()
        .map_err(|e| e.annotate("Item"))
    }
}

impl cbor_event::se::Serialize for PayloadManifest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(
            6 + match &self.meta {
                Some(_) => 1,
                None => 0,
            } + match &self.extensions {
                Some(_) => 1,
                None => 0,
            } + match &self.reply_to {
                Some(_) => 1,
                None => 0,
            },
        ))?;
        serializer.write_text("v")?;
        serializer.write_unsigned_integer(self.v)?;
        serializer.write_text("kind")?;
        serializer.write_text(&self.kind)?;
        if let Some(field) = &self.meta {
            serializer.write_text("meta")?;
            serializer.write_map(cbor_event::Len::Len(field.len() as u64))?;
            for (key, value) in field.iter() {
                serializer.write_text(key)?;
                value.serialize(serializer)?;
            }
        }
        serializer.write_text("items")?;
        serializer.write_array(cbor_event::Len::Len(self.items.len() as u64))?;
        for element in self.items.iter() {
            element.serialize(serializer)?;
        }
        serializer.write_text("sender")?;
        self.sender.serialize(serializer)?;
        if let Some(field) = &self.reply_to {
            serializer.write_text("reply_to")?;
            serializer.write_bytes(field)?;
        }
        serializer.write_text("created_at")?;
        serializer.write_unsigned_integer(self.created_at)?;
        if let Some(field) = &self.extensions {
            serializer.write_text("extensions")?;
            serializer.write_map(cbor_event::Len::Len(field.len() as u64))?;
            for (key, value) in field.iter() {
                serializer.write_text(key)?;
                value.serialize(serializer)?;
            }
        }
        serializer.write_text("payload_id")?;
        serializer.write_bytes(&self.payload_id)?;
        Ok(serializer)
    }
}

impl Deserialize for PayloadManifest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(6)?;
            let mut v = None;
            let mut kind = None;
            let mut meta = None;
            let mut items = None;
            let mut sender = None;
            let mut reply_to = None;
            let mut created_at = None;
            let mut extensions = None;
            let mut payload_id = None;
            let mut read = 0;
            while match len {
                cbor_event::Len::Len(n) => read < n,
                cbor_event::Len::Indefinite => true,
            } {
                match raw.cbor_type()? {
                    cbor_event::Type::UnsignedInteger => {
                        return Err(DeserializeFailure::UnknownKey(Key::Uint(
                            raw.unsigned_integer()?,
                        ))
                        .into());
                    }
                    cbor_event::Type::Text => match raw.text()?.as_str() {
                        "v" => {
                            if v.is_some() {
                                return Err(
                                    DeserializeFailure::DuplicateKey(Key::Str("v".into())).into()
                                );
                            }
                            v = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("v"))?,
                            );
                        }
                        "kind" => {
                            if kind.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "kind".into(),
                                ))
                                .into());
                            }
                            kind = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("kind"))?,
                            );
                        }
                        "meta" => {
                            if meta.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "meta".into(),
                                ))
                                .into());
                            }
                            meta = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    let mut meta_table = BTreeMap::new();
                                    let meta_len = raw.map()?;
                                    while match meta_len {
                                        cbor_event::Len::Len(n) => (meta_table.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(meta_len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        let meta_key = raw.text()?;
                                        let meta_value =
                                            crate::generated::any_cbor::AnyCbor::deserialize(raw)?;
                                        if meta_table.insert(meta_key.clone(), meta_value).is_some()
                                        {
                                            return Err(DeserializeFailure::DuplicateKey(
                                                Key::Str(meta_key),
                                            )
                                            .into());
                                        }
                                    }
                                    Ok(meta_table)
                                })()
                                .map_err(|e| e.annotate("meta"))?,
                            );
                        }
                        "items" => {
                            if items.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "items".into(),
                                ))
                                .into());
                            }
                            items = Some(
                                (|| -> Result<_, DeserializeError> {
                                    let mut items_arr = Vec::new();
                                    let len = raw.array()?;
                                    while match len {
                                        cbor_event::Len::Len(n) => (items_arr.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        items_arr.push(Item::deserialize(raw)?);
                                    }
                                    Ok(items_arr)
                                })()
                                .map_err(|e| e.annotate("items"))?,
                            );
                        }
                        "sender" => {
                            if sender.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "sender".into(),
                                ))
                                .into());
                            }
                            sender = Some(
                                DeviceRef::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("sender"))?,
                            );
                        }
                        "reply_to" => {
                            if reply_to.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "reply_to".into(),
                                ))
                                .into());
                            }
                            reply_to = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok::<_, DeserializeError>(raw.bytes()?)
                                        .and_then(|bytes| {
                                            bytes.try_into().map_err(|bytes: Vec<u8>| {
                                                DeserializeFailure::RangeCheck {
                                                    found: bytes.len() as i128,
                                                    min: Some(16),
                                                    max: Some(16),
                                                }
                                                .into()
                                            })
                                        })
                                        .map(|bytes: [u8; 16]| bytes)
                                })()
                                .map_err(|e| e.annotate("reply_to"))?,
                            );
                        }
                        "created_at" => {
                            if created_at.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "created_at".into(),
                                ))
                                .into());
                            }
                            created_at = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("created_at"))?,
                            );
                        }
                        "extensions" => {
                            if extensions.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "extensions".into(),
                                ))
                                .into());
                            }
                            extensions = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    let mut extensions_table = BTreeMap::new();
                                    let extensions_len = raw.map()?;
                                    while match extensions_len {
                                        cbor_event::Len::Len(n) => {
                                            (extensions_table.len() as u64) < n
                                        }
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(extensions_len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        let extensions_key = raw.text()?;
                                        let extensions_value =
                                            crate::generated::any_cbor::AnyCbor::deserialize(raw)?;
                                        if extensions_table
                                            .insert(extensions_key.clone(), extensions_value)
                                            .is_some()
                                        {
                                            return Err(DeserializeFailure::DuplicateKey(
                                                Key::Str(extensions_key),
                                            )
                                            .into());
                                        }
                                    }
                                    Ok(extensions_table)
                                })()
                                .map_err(|e| e.annotate("extensions"))?,
                            );
                        }
                        "payload_id" => {
                            if payload_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "payload_id".into(),
                                ))
                                .into());
                            }
                            payload_id = Some(
                                Ok::<_, DeserializeError>(raw.bytes()?)
                                    .and_then(|bytes| {
                                        bytes.try_into().map_err(|bytes: Vec<u8>| {
                                            DeserializeFailure::RangeCheck {
                                                found: bytes.len() as i128,
                                                min: Some(16),
                                                max: Some(16),
                                            }
                                            .into()
                                        })
                                    })
                                    .map(|bytes: [u8; 16]| bytes)
                                    .map_err(|e: DeserializeError| e.annotate("payload_id"))?,
                            );
                        }
                        unknown_key => {
                            return Err(DeserializeFailure::UnknownKey(Key::Str(
                                unknown_key.to_owned(),
                            ))
                            .into());
                        }
                    },
                    cbor_event::Type::Special => match len {
                        cbor_event::Len::Len(_) => {
                            return Err(DeserializeFailure::BreakInDefiniteLen.into());
                        }
                        cbor_event::Len::Indefinite => match raw.special()? {
                            cbor_event::Special::Break => break,
                            _ => return Err(DeserializeFailure::EndingBreakMissing.into()),
                        },
                    },
                    other_type => {
                        return Err(DeserializeFailure::UnexpectedKeyType(other_type).into());
                    }
                }
                read += 1;
            }
            let v = match v {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("v")))
                            .into(),
                    );
                }
            };
            let payload_id =
                match payload_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("payload_id"),
                        ))
                        .into());
                    }
                };
            let kind = match kind {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("kind")))
                            .into(),
                    );
                }
            };
            let created_at =
                match created_at {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("created_at"),
                        ))
                        .into());
                    }
                };
            let sender = match sender {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("sender")))
                            .into(),
                    );
                }
            };
            let items = match items {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("items")))
                            .into(),
                    );
                }
            };
            read_len.finish()?;
            Ok(Self {
                v,
                payload_id,
                kind,
                created_at,
                sender,
                items,
                meta,
                extensions,
                reply_to,
            })
        })()
        .map_err(|e| e.annotate("PayloadManifest"))
    }
}
