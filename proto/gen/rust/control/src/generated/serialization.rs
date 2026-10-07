// This file was code-generated using an experimental CDDL to rust tool:
// https://github.com/dcSpark/cddl-codegen

// same as cbor_event::de::Deserialize but with our DeserializeError
extern crate alloc;
use alloc::borrow::ToOwned;
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

impl cbor_event::se::Serialize for Ack {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(4))?;
        serializer.write_text("hash_ok")?;
        serializer.write_special(cbor_event::Special::Bool(self.hash_ok))?;
        serializer.write_text("complete")?;
        serializer.write_special(cbor_event::Special::Bool(self.complete))?;
        serializer.write_text("item_index")?;
        serializer.write_unsigned_integer(self.item_index)?;
        serializer.write_text("transfer_id")?;
        serializer.write_bytes(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for Ack {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(4)?;
            read_len.finish()?;
            let mut hash_ok = None;
            let mut complete = None;
            let mut item_index = None;
            let mut transfer_id = None;
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
                        "hash_ok" => {
                            if hash_ok.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "hash_ok".into(),
                                ))
                                .into());
                            }
                            hash_ok = Some(
                                bool::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("hash_ok"))?,
                            );
                        }
                        "complete" => {
                            if complete.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "complete".into(),
                                ))
                                .into());
                            }
                            complete = Some(
                                bool::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("complete"))?,
                            );
                        }
                        "item_index" => {
                            if item_index.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "item_index".into(),
                                ))
                                .into());
                            }
                            item_index = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("item_index"))?,
                            );
                        }
                        "transfer_id" => {
                            if transfer_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "transfer_id".into(),
                                ))
                                .into());
                            }
                            transfer_id = Some(
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
                                    .map_err(|e: DeserializeError| e.annotate("transfer_id"))?,
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
            let transfer_id =
                match transfer_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("transfer_id"),
                        ))
                        .into());
                    }
                };
            let item_index =
                match item_index {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("item_index"),
                        ))
                        .into());
                    }
                };
            let complete =
                match complete {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("complete"),
                        ))
                        .into());
                    }
                };
            let hash_ok =
                match hash_ok {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("hash_ok"),
                        ))
                        .into());
                    }
                };
            Ok(Self {
                transfer_id,
                item_index,
                complete,
                hash_ok,
            })
        })()
        .map_err(|e| e.annotate("Ack"))
    }
}

impl cbor_event::se::Serialize for Beacon {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(4))?;
        serializer.write_text("v")?;
        serializer.write_unsigned_integer(self.v)?;
        serializer.write_text("seq")?;
        serializer.write_unsigned_integer(self.seq)?;
        serializer.write_text("body")?;
        serializer.write_bytes(&self.body)?;
        serializer.write_text("device_id")?;
        serializer.write_bytes(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for Beacon {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(4)?;
            read_len.finish()?;
            let mut v = None;
            let mut seq = None;
            let mut body = None;
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
                        "seq" => {
                            if seq.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "seq".into(),
                                ))
                                .into());
                            }
                            seq = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("seq"))?,
                            );
                        }
                        "body" => {
                            if body.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "body".into(),
                                ))
                                .into());
                            }
                            body = Some(
                                Ok(raw.bytes()?)
                                    .map_err(|e: DeserializeError| e.annotate("body"))?,
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
            let v = match v {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("v")))
                            .into(),
                    );
                }
            };
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
            let seq = match seq {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("seq")))
                            .into(),
                    );
                }
            };
            let body = match body {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("body")))
                            .into(),
                    );
                }
            };
            Ok(Self {
                v,
                device_id,
                seq,
                body,
            })
        })()
        .map_err(|e| e.annotate("Beacon"))
    }
}

impl cbor_event::se::Serialize for Hello {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("device_id")?;
        serializer.write_bytes(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for Hello {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
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
            Ok(Self { device_id })
        })()
        .map_err(|e| e.annotate("Hello"))
    }
}

impl cbor_event::se::Serialize for Nack {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(3))?;
        serializer.write_text("ranges")?;
        serializer.write_array(cbor_event::Len::Len(self.ranges.len() as u64))?;
        for element in self.ranges.iter() {
            element.serialize(serializer)?;
        }
        serializer.write_text("item_index")?;
        serializer.write_unsigned_integer(self.item_index)?;
        serializer.write_text("transfer_id")?;
        serializer.write_bytes(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for Nack {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(3)?;
            read_len.finish()?;
            let mut ranges = None;
            let mut item_index = None;
            let mut transfer_id = None;
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
                        "ranges" => {
                            if ranges.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "ranges".into(),
                                ))
                                .into());
                            }
                            ranges = Some(
                                (|| -> Result<_, DeserializeError> {
                                    let mut ranges_arr = Vec::new();
                                    let len = raw.array()?;
                                    while match len {
                                        cbor_event::Len::Len(n) => (ranges_arr.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        ranges_arr.push(Range::deserialize(raw)?);
                                    }
                                    Ok(ranges_arr)
                                })()
                                .map_err(|e| e.annotate("ranges"))?,
                            );
                        }
                        "item_index" => {
                            if item_index.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "item_index".into(),
                                ))
                                .into());
                            }
                            item_index = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("item_index"))?,
                            );
                        }
                        "transfer_id" => {
                            if transfer_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "transfer_id".into(),
                                ))
                                .into());
                            }
                            transfer_id = Some(
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
                                    .map_err(|e: DeserializeError| e.annotate("transfer_id"))?,
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
            let transfer_id =
                match transfer_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("transfer_id"),
                        ))
                        .into());
                    }
                };
            let item_index =
                match item_index {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("item_index"),
                        ))
                        .into());
                    }
                };
            let ranges = match ranges {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("ranges")))
                            .into(),
                    );
                }
            };
            Ok(Self {
                transfer_id,
                item_index,
                ranges,
            })
        })()
        .map_err(|e| e.annotate("Nack"))
    }
}

impl cbor_event::se::Serialize for Range {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_array(cbor_event::Len::Len(2))?;
        serializer.write_unsigned_integer(self.index_0)?;
        serializer.write_unsigned_integer(self.index_1)?;
        Ok(serializer)
    }
}

impl Deserialize for Range {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.array()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let index_0 =
                Ok(raw.unsigned_integer()?).map_err(|e: DeserializeError| e.annotate("index_0"))?;
            let index_1 =
                Ok(raw.unsigned_integer()?).map_err(|e: DeserializeError| e.annotate("index_1"))?;
            match len {
                cbor_event::Len::Len(_) => (),
                cbor_event::Len::Indefinite => match raw.special()? {
                    cbor_event::Special::Break => (),
                    _ => return Err(DeserializeFailure::EndingBreakMissing.into()),
                },
            }
            Ok(Range { index_0, index_1 })
        })()
        .map_err(|e| e.annotate("Range"))
    }
}
