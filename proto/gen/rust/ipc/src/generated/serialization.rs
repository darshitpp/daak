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

impl cbor_event::se::Serialize for CancelRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Cancel")?;
        self.cancel.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for CancelRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut cancel = None;
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
                        "Cancel" => {
                            if cancel.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Cancel".into(),
                                ))
                                .into());
                            }
                            cancel = Some(
                                TransferRef::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("cancel"))?,
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
            let cancel = match cancel {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Cancel")))
                            .into(),
                    );
                }
            };
            Ok(Self { cancel })
        })()
        .map_err(|e| e.annotate("CancelRequest"))
    }
}

impl cbor_event::se::Serialize for DeviceFoundArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(3))?;
        serializer.write_text("addr")?;
        serializer.write_text(&self.addr)?;
        serializer.write_text("name")?;
        serializer.write_text(&self.name)?;
        serializer.write_text("device_id")?;
        serializer.write_text(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for DeviceFoundArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(3)?;
            read_len.finish()?;
            let mut addr = None;
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
                        "addr" => {
                            if addr.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "addr".into(),
                                ))
                                .into());
                            }
                            addr = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("addr"))?,
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
                                Ok(raw.text()?)
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
            let addr = match addr {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("addr")))
                            .into(),
                    );
                }
            };
            Ok(Self {
                device_id,
                name,
                addr,
            })
        })()
        .map_err(|e| e.annotate("DeviceFoundArgs"))
    }
}

impl cbor_event::se::Serialize for DeviceFoundEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("DeviceFound")?;
        self.device_found.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for DeviceFoundEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut device_found = None;
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
                        "DeviceFound" => {
                            if device_found.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "DeviceFound".into(),
                                ))
                                .into());
                            }
                            device_found = Some(
                                DeviceFoundArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("device_found"))?,
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
            let device_found =
                match device_found {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("DeviceFound"),
                        ))
                        .into());
                    }
                };
            Ok(Self { device_found })
        })()
        .map_err(|e| e.annotate("DeviceFoundEvent"))
    }
}

impl cbor_event::se::Serialize for DeviceStateArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("online")?;
        serializer.write_special(cbor_event::Special::Bool(self.online))?;
        serializer.write_text("device_id")?;
        serializer.write_text(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for DeviceStateArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut online = None;
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
                        "online" => {
                            if online.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "online".into(),
                                ))
                                .into());
                            }
                            online = Some(
                                bool::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("online"))?,
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
                                Ok(raw.text()?)
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
            let online = match online {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("online")))
                            .into(),
                    );
                }
            };
            Ok(Self { device_id, online })
        })()
        .map_err(|e| e.annotate("DeviceStateArgs"))
    }
}

impl cbor_event::se::Serialize for DeviceStateEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("DeviceState")?;
        self.device_state.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for DeviceStateEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut device_state = None;
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
                        "DeviceState" => {
                            if device_state.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "DeviceState".into(),
                                ))
                                .into());
                            }
                            device_state = Some(
                                DeviceStateArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("device_state"))?,
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
            let device_state =
                match device_state {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("DeviceState"),
                        ))
                        .into());
                    }
                };
            Ok(Self { device_state })
        })()
        .map_err(|e| e.annotate("DeviceStateEvent"))
    }
}

impl cbor_event::se::Serialize for DevicesRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            DevicesRequest::ValueText44657669636573 => serializer.write_text("Devices"),
        }
    }
}

impl Deserialize for DevicesRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            match raw.cbor_type()? {
                cbor_event::Type::Text => {
                    let value_text44657669636573_value = raw.text()?;
                    if value_text44657669636573_value != "Devices" {
                        return Err(DeserializeFailure::FixedValueMismatch {
                            found: Key::Str(value_text44657669636573_value),
                            expected: Key::Str(String::from("Devices")),
                        }
                        .into());
                    }
                    Ok(DevicesRequest::ValueText44657669636573)
                }
                _ => Err(DeserializeFailure::NoVariantMatched.into()),
            }
        })()
        .map_err(|e| e.annotate("DevicesRequest"))
    }
}

impl cbor_event::se::Serialize for DisplayNameArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("name")?;
        serializer.write_text(&self.name)?;
        Ok(serializer)
    }
}

impl Deserialize for DisplayNameArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut name = None;
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
            let name = match name {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("name")))
                            .into(),
                    );
                }
            };
            Ok(Self { name })
        })()
        .map_err(|e| e.annotate("DisplayNameArgs"))
    }
}

impl cbor_event::se::Serialize for ErrorArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("message")?;
        serializer.write_text(&self.message)?;
        Ok(serializer)
    }
}

impl Deserialize for ErrorArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut message = None;
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
                        "message" => {
                            if message.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "message".into(),
                                ))
                                .into());
                            }
                            message = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("message"))?,
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
            let message =
                match message {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("message"),
                        ))
                        .into());
                    }
                };
            Ok(Self { message })
        })()
        .map_err(|e| e.annotate("ErrorArgs"))
    }
}

impl cbor_event::se::Serialize for ErrorResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Error")?;
        self.error.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for ErrorResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut error = None;
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
                        "Error" => {
                            if error.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Error".into(),
                                ))
                                .into());
                            }
                            error = Some(
                                ErrorArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("error"))?,
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
            let error = match error {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Error")))
                            .into(),
                    );
                }
            };
            Ok(Self { error })
        })()
        .map_err(|e| e.annotate("ErrorResponse"))
    }
}

impl cbor_event::se::Serialize for EventArm {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Event")?;
        self.event.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for EventArm {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut event = None;
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
                        "Event" => {
                            if event.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Event".into(),
                                ))
                                .into());
                            }
                            event = Some(
                                IpcEvent::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("event"))?,
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
            let event = match event {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Event")))
                            .into(),
                    );
                }
            };
            Ok(Self { event })
        })()
        .map_err(|e| e.annotate("EventArm"))
    }
}

impl cbor_event::se::Serialize for ExportDebugBundleArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("path")?;
        serializer.write_text(&self.path)?;
        Ok(serializer)
    }
}

impl Deserialize for ExportDebugBundleArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut path = None;
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
                        "path" => {
                            if path.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "path".into(),
                                ))
                                .into());
                            }
                            path = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("path"))?,
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
            let path = match path {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("path")))
                            .into(),
                    );
                }
            };
            Ok(Self { path })
        })()
        .map_err(|e| e.annotate("ExportDebugBundleArgs"))
    }
}

impl cbor_event::se::Serialize for ExportDebugBundleRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("ExportDebugBundle")?;
        self.export_debug_bundle.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for ExportDebugBundleRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut export_debug_bundle = None;
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
                        "ExportDebugBundle" => {
                            if export_debug_bundle.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "ExportDebugBundle".into(),
                                ))
                                .into());
                            }
                            export_debug_bundle =
                                Some(ExportDebugBundleArgs::deserialize(raw).map_err(
                                    |e: DeserializeError| e.annotate("export_debug_bundle"),
                                )?);
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
            let export_debug_bundle =
                match export_debug_bundle {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("ExportDebugBundle"),
                        ))
                        .into());
                    }
                };
            Ok(Self {
                export_debug_bundle,
            })
        })()
        .map_err(|e| e.annotate("ExportDebugBundleRequest"))
    }
}

impl cbor_event::se::Serialize for InboxReceivedArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("payload_json")?;
        serializer.write_text(&self.payload_json)?;
        Ok(serializer)
    }
}

impl Deserialize for InboxReceivedArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut payload_json = None;
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
                        "payload_json" => {
                            if payload_json.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "payload_json".into(),
                                ))
                                .into());
                            }
                            payload_json = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("payload_json"))?,
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
            let payload_json =
                match payload_json {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("payload_json"),
                        ))
                        .into());
                    }
                };
            Ok(Self { payload_json })
        })()
        .map_err(|e| e.annotate("InboxReceivedArgs"))
    }
}

impl cbor_event::se::Serialize for InboxReceivedEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("InboxReceived")?;
        self.inbox_received.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for InboxReceivedEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut inbox_received = None;
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
                        "InboxReceived" => {
                            if inbox_received.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "InboxReceived".into(),
                                ))
                                .into());
                            }
                            inbox_received = Some(
                                InboxReceivedArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("inbox_received"))?,
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
            let inbox_received =
                match inbox_received {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("InboxReceived"),
                        ))
                        .into());
                    }
                };
            Ok(Self { inbox_received })
        })()
        .map_err(|e| e.annotate("InboxReceivedEvent"))
    }
}

impl cbor_event::se::Serialize for IpcEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            IpcEvent::DeviceFoundEvent(device_found_event) => {
                device_found_event.serialize(serializer)
            }
            IpcEvent::DeviceStateEvent(device_state_event) => {
                device_state_event.serialize(serializer)
            }
            IpcEvent::PairingSasEvent(pairing_sas_event) => pairing_sas_event.serialize(serializer),
            IpcEvent::PairingDoneEvent(pairing_done_event) => {
                pairing_done_event.serialize(serializer)
            }
            IpcEvent::TransferProgressEvent(transfer_progress_event) => {
                transfer_progress_event.serialize(serializer)
            }
            IpcEvent::TransferItemEvent(transfer_item_event) => {
                transfer_item_event.serialize(serializer)
            }
            IpcEvent::TransferDoneEvent(transfer_done_event) => {
                transfer_done_event.serialize(serializer)
            }
            IpcEvent::TransferFailedEvent(transfer_failed_event) => {
                transfer_failed_event.serialize(serializer)
            }
            IpcEvent::InboxReceivedEvent(inbox_received_event) => {
                inbox_received_event.serialize(serializer)
            }
        }
    }
}

impl Deserialize for IpcEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let initial_position = raw.position();
            let mut errs = Vec::new();
            let deser_variant: Result<_, DeserializeError> = DeviceFoundEvent::deserialize(raw);
            match deser_variant {
                Ok(device_found_event) => return Ok(Self::DeviceFoundEvent(device_found_event)),
                Err(e) => {
                    errs.push(e.annotate("DeviceFoundEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = DeviceStateEvent::deserialize(raw);
            match deser_variant {
                Ok(device_state_event) => return Ok(Self::DeviceStateEvent(device_state_event)),
                Err(e) => {
                    errs.push(e.annotate("DeviceStateEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = PairingSasEvent::deserialize(raw);
            match deser_variant {
                Ok(pairing_sas_event) => return Ok(Self::PairingSasEvent(pairing_sas_event)),
                Err(e) => {
                    errs.push(e.annotate("PairingSasEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = PairingDoneEvent::deserialize(raw);
            match deser_variant {
                Ok(pairing_done_event) => return Ok(Self::PairingDoneEvent(pairing_done_event)),
                Err(e) => {
                    errs.push(e.annotate("PairingDoneEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> =
                TransferProgressEvent::deserialize(raw);
            match deser_variant {
                Ok(transfer_progress_event) => {
                    return Ok(Self::TransferProgressEvent(transfer_progress_event));
                }
                Err(e) => {
                    errs.push(e.annotate("TransferProgressEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = TransferItemEvent::deserialize(raw);
            match deser_variant {
                Ok(transfer_item_event) => return Ok(Self::TransferItemEvent(transfer_item_event)),
                Err(e) => {
                    errs.push(e.annotate("TransferItemEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = TransferDoneEvent::deserialize(raw);
            match deser_variant {
                Ok(transfer_done_event) => return Ok(Self::TransferDoneEvent(transfer_done_event)),
                Err(e) => {
                    errs.push(e.annotate("TransferDoneEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = TransferFailedEvent::deserialize(raw);
            match deser_variant {
                Ok(transfer_failed_event) => {
                    return Ok(Self::TransferFailedEvent(transfer_failed_event));
                }
                Err(e) => {
                    errs.push(e.annotate("TransferFailedEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = InboxReceivedEvent::deserialize(raw);
            match deser_variant {
                Ok(inbox_received_event) => {
                    return Ok(Self::InboxReceivedEvent(inbox_received_event));
                }
                Err(e) => {
                    errs.push(e.annotate("InboxReceivedEvent"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            Err(DeserializeFailure::NoVariantMatchedWithCauses(errs).into())
        })()
        .map_err(|e| e.annotate("IpcEvent"))
    }
}

impl cbor_event::se::Serialize for IpcFrame {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("v")?;
        serializer.write_unsigned_integer(self.v)?;
        serializer.write_text("msg")?;
        self.msg.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for IpcFrame {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut v = None;
            let mut msg = None;
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
                        "msg" => {
                            if msg.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "msg".into(),
                                ))
                                .into());
                            }
                            msg = Some(
                                IpcMessage::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("msg"))?,
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
            let msg = match msg {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("msg")))
                            .into(),
                    );
                }
            };
            Ok(Self { v, msg })
        })()
        .map_err(|e| e.annotate("IpcFrame"))
    }
}

impl cbor_event::se::Serialize for IpcMessage {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            IpcMessage::RequestArm(request_arm) => request_arm.serialize(serializer),
            IpcMessage::ResponseArm(response_arm) => response_arm.serialize(serializer),
            IpcMessage::EventArm(event_arm) => event_arm.serialize(serializer),
        }
    }
}

impl Deserialize for IpcMessage {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let initial_position = raw.position();
            let mut errs = Vec::new();
            let deser_variant: Result<_, DeserializeError> = RequestArm::deserialize(raw);
            match deser_variant {
                Ok(request_arm) => return Ok(Self::RequestArm(request_arm)),
                Err(e) => {
                    errs.push(e.annotate("RequestArm"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = ResponseArm::deserialize(raw);
            match deser_variant {
                Ok(response_arm) => return Ok(Self::ResponseArm(response_arm)),
                Err(e) => {
                    errs.push(e.annotate("ResponseArm"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = EventArm::deserialize(raw);
            match deser_variant {
                Ok(event_arm) => return Ok(Self::EventArm(event_arm)),
                Err(e) => {
                    errs.push(e.annotate("EventArm"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            Err(DeserializeFailure::NoVariantMatchedWithCauses(errs).into())
        })()
        .map_err(|e| e.annotate("IpcMessage"))
    }
}

impl cbor_event::se::Serialize for IpcRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            IpcRequest::StartRequest(start_request) => start_request.serialize(serializer),
            IpcRequest::SubscribeRequest(subscribe_request) => {
                subscribe_request.serialize(serializer)
            }
            IpcRequest::DevicesRequest(devices_request) => devices_request.serialize(serializer),
            IpcRequest::PairRequest(pair_request) => pair_request.serialize(serializer),
            IpcRequest::SendRequest(send_request) => send_request.serialize(serializer),
            IpcRequest::CancelRequest(cancel_request) => cancel_request.serialize(serializer),
            IpcRequest::RetryRequest(retry_request) => retry_request.serialize(serializer),
            IpcRequest::ListTransfersRequest(list_transfers_request) => {
                list_transfers_request.serialize(serializer)
            }
            IpcRequest::ListInboxRequest(list_inbox_request) => {
                list_inbox_request.serialize(serializer)
            }
            IpcRequest::SetDisplayNameRequest(set_display_name_request) => {
                set_display_name_request.serialize(serializer)
            }
            IpcRequest::SetPresenceRequest(set_presence_request) => {
                set_presence_request.serialize(serializer)
            }
            IpcRequest::ExportDebugBundleRequest(export_debug_bundle_request) => {
                export_debug_bundle_request.serialize(serializer)
            }
            IpcRequest::ShutdownRequest(shutdown_request) => shutdown_request.serialize(serializer),
        }
    }
}

impl Deserialize for IpcRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let initial_position = raw.position();
            let mut errs = Vec::new();
            let deser_variant: Result<_, DeserializeError> = StartRequest::deserialize(raw);
            match deser_variant {
                Ok(start_request) => return Ok(Self::StartRequest(start_request)),
                Err(e) => {
                    errs.push(e.annotate("StartRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = SubscribeRequest::deserialize(raw);
            match deser_variant {
                Ok(subscribe_request) => return Ok(Self::SubscribeRequest(subscribe_request)),
                Err(e) => {
                    errs.push(e.annotate("SubscribeRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = DevicesRequest::deserialize(raw);
            match deser_variant {
                Ok(devices_request) => return Ok(Self::DevicesRequest(devices_request)),
                Err(e) => {
                    errs.push(e.annotate("DevicesRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = PairRequest::deserialize(raw);
            match deser_variant {
                Ok(pair_request) => return Ok(Self::PairRequest(pair_request)),
                Err(e) => {
                    errs.push(e.annotate("PairRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = SendRequest::deserialize(raw);
            match deser_variant {
                Ok(send_request) => return Ok(Self::SendRequest(send_request)),
                Err(e) => {
                    errs.push(e.annotate("SendRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = CancelRequest::deserialize(raw);
            match deser_variant {
                Ok(cancel_request) => return Ok(Self::CancelRequest(cancel_request)),
                Err(e) => {
                    errs.push(e.annotate("CancelRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = RetryRequest::deserialize(raw);
            match deser_variant {
                Ok(retry_request) => return Ok(Self::RetryRequest(retry_request)),
                Err(e) => {
                    errs.push(e.annotate("RetryRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = ListTransfersRequest::deserialize(raw);
            match deser_variant {
                Ok(list_transfers_request) => {
                    return Ok(Self::ListTransfersRequest(list_transfers_request));
                }
                Err(e) => {
                    errs.push(e.annotate("ListTransfersRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = ListInboxRequest::deserialize(raw);
            match deser_variant {
                Ok(list_inbox_request) => return Ok(Self::ListInboxRequest(list_inbox_request)),
                Err(e) => {
                    errs.push(e.annotate("ListInboxRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> =
                SetDisplayNameRequest::deserialize(raw);
            match deser_variant {
                Ok(set_display_name_request) => {
                    return Ok(Self::SetDisplayNameRequest(set_display_name_request));
                }
                Err(e) => {
                    errs.push(e.annotate("SetDisplayNameRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = SetPresenceRequest::deserialize(raw);
            match deser_variant {
                Ok(set_presence_request) => {
                    return Ok(Self::SetPresenceRequest(set_presence_request));
                }
                Err(e) => {
                    errs.push(e.annotate("SetPresenceRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> =
                ExportDebugBundleRequest::deserialize(raw);
            match deser_variant {
                Ok(export_debug_bundle_request) => {
                    return Ok(Self::ExportDebugBundleRequest(export_debug_bundle_request));
                }
                Err(e) => {
                    errs.push(e.annotate("ExportDebugBundleRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = ShutdownRequest::deserialize(raw);
            match deser_variant {
                Ok(shutdown_request) => return Ok(Self::ShutdownRequest(shutdown_request)),
                Err(e) => {
                    errs.push(e.annotate("ShutdownRequest"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            Err(DeserializeFailure::NoVariantMatchedWithCauses(errs).into())
        })()
        .map_err(|e| e.annotate("IpcRequest"))
    }
}

impl cbor_event::se::Serialize for IpcResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            IpcResponse::OkResponse(ok_response) => ok_response.serialize(serializer),
            IpcResponse::ErrorResponse(error_response) => error_response.serialize(serializer),
            IpcResponse::JsonResponse(json_response) => json_response.serialize(serializer),
            IpcResponse::PortResponse(port_response) => port_response.serialize(serializer),
            IpcResponse::UpdateRequiredResponse(update_required_response) => {
                update_required_response.serialize(serializer)
            }
        }
    }
}

impl Deserialize for IpcResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let initial_position = raw.position();
            let mut errs = Vec::new();
            let deser_variant: Result<_, DeserializeError> = OkResponse::deserialize(raw);
            match deser_variant {
                Ok(ok_response) => return Ok(Self::OkResponse(ok_response)),
                Err(e) => {
                    errs.push(e.annotate("OkResponse"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = ErrorResponse::deserialize(raw);
            match deser_variant {
                Ok(error_response) => return Ok(Self::ErrorResponse(error_response)),
                Err(e) => {
                    errs.push(e.annotate("ErrorResponse"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = JsonResponse::deserialize(raw);
            match deser_variant {
                Ok(json_response) => return Ok(Self::JsonResponse(json_response)),
                Err(e) => {
                    errs.push(e.annotate("JsonResponse"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> = PortResponse::deserialize(raw);
            match deser_variant {
                Ok(port_response) => return Ok(Self::PortResponse(port_response)),
                Err(e) => {
                    errs.push(e.annotate("PortResponse"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            let deser_variant: Result<_, DeserializeError> =
                UpdateRequiredResponse::deserialize(raw);
            match deser_variant {
                Ok(update_required_response) => {
                    return Ok(Self::UpdateRequiredResponse(update_required_response));
                }
                Err(e) => {
                    errs.push(e.annotate("UpdateRequiredResponse"));
                    raw.set_position(initial_position).unwrap();
                }
            };
            Err(DeserializeFailure::NoVariantMatchedWithCauses(errs).into())
        })()
        .map_err(|e| e.annotate("IpcResponse"))
    }
}

impl cbor_event::se::Serialize for JsonArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("value")?;
        serializer.write_text(&self.value)?;
        Ok(serializer)
    }
}

impl Deserialize for JsonArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut value = None;
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
                        "value" => {
                            if value.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "value".into(),
                                ))
                                .into());
                            }
                            value = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("value"))?,
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
            let value = match value {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("value")))
                            .into(),
                    );
                }
            };
            Ok(Self { value })
        })()
        .map_err(|e| e.annotate("JsonArgs"))
    }
}

impl cbor_event::se::Serialize for JsonResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Json")?;
        self.json.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for JsonResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut json = None;
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
                        "Json" => {
                            if json.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Json".into(),
                                ))
                                .into());
                            }
                            json = Some(
                                JsonArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("json"))?,
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
            let json = match json {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Json")))
                            .into(),
                    );
                }
            };
            Ok(Self { json })
        })()
        .map_err(|e| e.annotate("JsonResponse"))
    }
}

impl cbor_event::se::Serialize for ListInboxRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            ListInboxRequest::ValueText4C697374496E626F78 => serializer.write_text("ListInbox"),
        }
    }
}

impl Deserialize for ListInboxRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            match raw.cbor_type()? {
                cbor_event::Type::Text => {
                    let value_text4_c697374496_e626_f78_value = raw.text()?;
                    if value_text4_c697374496_e626_f78_value != "ListInbox" {
                        return Err(DeserializeFailure::FixedValueMismatch {
                            found: Key::Str(value_text4_c697374496_e626_f78_value),
                            expected: Key::Str(String::from("ListInbox")),
                        }
                        .into());
                    }
                    Ok(ListInboxRequest::ValueText4C697374496E626F78)
                }
                _ => Err(DeserializeFailure::NoVariantMatched.into()),
            }
        })()
        .map_err(|e| e.annotate("ListInboxRequest"))
    }
}

impl cbor_event::se::Serialize for ListTransfersArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(match &self.filter {
            Some(_) => 1,
            None => 0,
        }))?;
        if let Some(field) = &self.filter {
            serializer.write_text("filter")?;
            field.serialize(serializer)?;
        }
        Ok(serializer)
    }
}

impl Deserialize for ListTransfersArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            let mut filter = None;
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
                        "filter" => {
                            if filter.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "filter".into(),
                                ))
                                .into());
                            }
                            filter = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    TransferFilter::deserialize(raw)
                                })()
                                .map_err(|e| e.annotate("filter"))?,
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
            read_len.finish()?;
            Ok(Self { filter })
        })()
        .map_err(|e| e.annotate("ListTransfersArgs"))
    }
}

impl cbor_event::se::Serialize for OkResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            OkResponse::ValueText4F6B => serializer.write_text("Ok"),
        }
    }
}

impl Deserialize for OkResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            match raw.cbor_type()? {
                cbor_event::Type::Text => {
                    let value_text4_f6_b_value = raw.text()?;
                    if value_text4_f6_b_value != "Ok" {
                        return Err(DeserializeFailure::FixedValueMismatch {
                            found: Key::Str(value_text4_f6_b_value),
                            expected: Key::Str(String::from("Ok")),
                        }
                        .into());
                    }
                    Ok(OkResponse::ValueText4F6B)
                }
                _ => Err(DeserializeFailure::NoVariantMatched.into()),
            }
        })()
        .map_err(|e| e.annotate("OkResponse"))
    }
}

impl cbor_event::se::Serialize for PairArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("addr")?;
        serializer.write_text(&self.addr)?;
        serializer.write_text("bundle_cbor")?;
        serializer.write_bytes(&self.bundle_cbor)?;
        Ok(serializer)
    }
}

impl Deserialize for PairArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut addr = None;
            let mut bundle_cbor = None;
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
                        "addr" => {
                            if addr.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "addr".into(),
                                ))
                                .into());
                            }
                            addr = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("addr"))?,
                            );
                        }
                        "bundle_cbor" => {
                            if bundle_cbor.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "bundle_cbor".into(),
                                ))
                                .into());
                            }
                            bundle_cbor = Some(
                                Ok(raw.bytes()?)
                                    .map_err(|e: DeserializeError| e.annotate("bundle_cbor"))?,
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
            let addr = match addr {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("addr")))
                            .into(),
                    );
                }
            };
            let bundle_cbor =
                match bundle_cbor {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("bundle_cbor"),
                        ))
                        .into());
                    }
                };
            Ok(Self { addr, bundle_cbor })
        })()
        .map_err(|e| e.annotate("PairArgs"))
    }
}

impl cbor_event::se::Serialize for PairRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Pair")?;
        self.pair.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for PairRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut pair = None;
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
                        "Pair" => {
                            if pair.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Pair".into(),
                                ))
                                .into());
                            }
                            pair = Some(
                                PairArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("pair"))?,
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
            let pair = match pair {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Pair")))
                            .into(),
                    );
                }
            };
            Ok(Self { pair })
        })()
        .map_err(|e| e.annotate("PairRequest"))
    }
}

impl cbor_event::se::Serialize for PairingDoneArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("device_id")?;
        serializer.write_text(&self.device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for PairingDoneArgs {
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
                                Ok(raw.text()?)
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
        .map_err(|e| e.annotate("PairingDoneArgs"))
    }
}

impl cbor_event::se::Serialize for PairingDoneEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("PairingDone")?;
        self.pairing_done.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for PairingDoneEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut pairing_done = None;
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
                        "PairingDone" => {
                            if pairing_done.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "PairingDone".into(),
                                ))
                                .into());
                            }
                            pairing_done = Some(
                                PairingDoneArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("pairing_done"))?,
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
            let pairing_done =
                match pairing_done {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("PairingDone"),
                        ))
                        .into());
                    }
                };
            Ok(Self { pairing_done })
        })()
        .map_err(|e| e.annotate("PairingDoneEvent"))
    }
}

impl cbor_event::se::Serialize for PairingSasArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("sas")?;
        serializer.write_text(&self.sas)?;
        serializer.write_text("peer_device_id")?;
        serializer.write_text(&self.peer_device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for PairingSasArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut sas = None;
            let mut peer_device_id = None;
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
                        "sas" => {
                            if sas.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "sas".into(),
                                ))
                                .into());
                            }
                            sas = Some(
                                Ok(raw.text()?).map_err(|e: DeserializeError| e.annotate("sas"))?,
                            );
                        }
                        "peer_device_id" => {
                            if peer_device_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "peer_device_id".into(),
                                ))
                                .into());
                            }
                            peer_device_id = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("peer_device_id"))?,
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
            let peer_device_id =
                match peer_device_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("peer_device_id"),
                        ))
                        .into());
                    }
                };
            let sas = match sas {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("sas")))
                            .into(),
                    );
                }
            };
            Ok(Self {
                peer_device_id,
                sas,
            })
        })()
        .map_err(|e| e.annotate("PairingSasArgs"))
    }
}

impl cbor_event::se::Serialize for PairingSasEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("PairingSas")?;
        self.pairing_sas.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for PairingSasEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut pairing_sas = None;
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
                        "PairingSas" => {
                            if pairing_sas.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "PairingSas".into(),
                                ))
                                .into());
                            }
                            pairing_sas = Some(
                                PairingSasArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("pairing_sas"))?,
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
            let pairing_sas =
                match pairing_sas {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("PairingSas"),
                        ))
                        .into());
                    }
                };
            Ok(Self { pairing_sas })
        })()
        .map_err(|e| e.annotate("PairingSasEvent"))
    }
}

impl cbor_event::se::Serialize for PortArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("port")?;
        serializer.write_unsigned_integer(self.port)?;
        Ok(serializer)
    }
}

impl Deserialize for PortArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut port = None;
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
                        "port" => {
                            if port.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "port".into(),
                                ))
                                .into());
                            }
                            port = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("port"))?,
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
            let port = match port {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("port")))
                            .into(),
                    );
                }
            };
            Ok(Self { port })
        })()
        .map_err(|e| e.annotate("PortArgs"))
    }
}

impl cbor_event::se::Serialize for PortResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Port")?;
        self.port.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for PortResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut port = None;
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
                        "Port" => {
                            if port.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Port".into(),
                                ))
                                .into());
                            }
                            port = Some(
                                PortArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("port"))?,
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
            let port = match port {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Port")))
                            .into(),
                    );
                }
            };
            Ok(Self { port })
        })()
        .map_err(|e| e.annotate("PortResponse"))
    }
}

impl cbor_event::se::Serialize for RequestArm {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Request")?;
        self.request.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for RequestArm {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut request = None;
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
                        "Request" => {
                            if request.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Request".into(),
                                ))
                                .into());
                            }
                            request = Some(
                                IpcRequest::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("request"))?,
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
            let request =
                match request {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("Request"),
                        ))
                        .into());
                    }
                };
            Ok(Self { request })
        })()
        .map_err(|e| e.annotate("RequestArm"))
    }
}

impl cbor_event::se::Serialize for ResponseArm {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Response")?;
        self.response.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for ResponseArm {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut response = None;
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
                        "Response" => {
                            if response.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Response".into(),
                                ))
                                .into());
                            }
                            response = Some(
                                IpcResponse::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("response"))?,
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
            let response =
                match response {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("Response"),
                        ))
                        .into());
                    }
                };
            Ok(Self { response })
        })()
        .map_err(|e| e.annotate("ResponseArm"))
    }
}

impl cbor_event::se::Serialize for RetryRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Retry")?;
        self.retry.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for RetryRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut retry = None;
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
                        "Retry" => {
                            if retry.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Retry".into(),
                                ))
                                .into());
                            }
                            retry = Some(
                                TransferRef::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("retry"))?,
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
            let retry = match retry {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Retry")))
                            .into(),
                    );
                }
            };
            Ok(Self { retry })
        })()
        .map_err(|e| e.annotate("RetryRequest"))
    }
}

impl cbor_event::se::Serialize for SendArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(3))?;
        serializer.write_text("text")?;
        match &self.text {
            Some(x) => {
                serializer.write_text(x)?;
            }
            None => {
                serializer.write_special(cbor_event::Special::Null)?;
            }
        };
        serializer.write_text("files")?;
        serializer.write_array(cbor_event::Len::Len(self.files.len() as u64))?;
        for element in self.files.iter() {
            serializer.write_text(element)?;
        }
        serializer.write_text("peer_device_id")?;
        serializer.write_text(&self.peer_device_id)?;
        Ok(serializer)
    }
}

impl Deserialize for SendArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(3)?;
            read_len.finish()?;
            let mut text = None;
            let mut files = None;
            let mut peer_device_id = None;
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
                        "text" => {
                            if text.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "text".into(),
                                ))
                                .into());
                            }
                            text = Some(
                                (|| -> Result<_, DeserializeError> {
                                    Ok(match raw.cbor_type()? != cbor_event::Type::Special {
                                        true => Some(raw.text()?),
                                        false => {
                                            if raw.special()? != cbor_event::Special::Null {
                                                return Err(DeserializeFailure::ExpectedNull.into());
                                            }
                                            None
                                        }
                                    })
                                })()
                                .map_err(|e| e.annotate("text"))?,
                            );
                        }
                        "files" => {
                            if files.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "files".into(),
                                ))
                                .into());
                            }
                            files = Some(
                                (|| -> Result<_, DeserializeError> {
                                    let mut files_arr = Vec::new();
                                    let len = raw.array()?;
                                    while match len {
                                        cbor_event::Len::Len(n) => (files_arr.len() as u64) < n,
                                        cbor_event::Len::Indefinite => true,
                                    } {
                                        if matches!(len, cbor_event::Len::Indefinite)
                                            && raw.cbor_type()? == cbor_event::Type::Special
                                            && raw.special_break()?
                                        {
                                            break;
                                        }
                                        files_arr.push(raw.text()?);
                                    }
                                    Ok(files_arr)
                                })()
                                .map_err(|e| e.annotate("files"))?,
                            );
                        }
                        "peer_device_id" => {
                            if peer_device_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "peer_device_id".into(),
                                ))
                                .into());
                            }
                            peer_device_id = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("peer_device_id"))?,
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
            let peer_device_id =
                match peer_device_id {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("peer_device_id"),
                        ))
                        .into());
                    }
                };
            let text = match text {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("text")))
                            .into(),
                    );
                }
            };
            let files = match files {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("files")))
                            .into(),
                    );
                }
            };
            Ok(Self {
                peer_device_id,
                text,
                files,
            })
        })()
        .map_err(|e| e.annotate("SendArgs"))
    }
}

impl cbor_event::se::Serialize for SendRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Send")?;
        self.send.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for SendRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut send = None;
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
                        "Send" => {
                            if send.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Send".into(),
                                ))
                                .into());
                            }
                            send = Some(
                                SendArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("send"))?,
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
            let send = match send {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Send")))
                            .into(),
                    );
                }
            };
            Ok(Self { send })
        })()
        .map_err(|e| e.annotate("SendRequest"))
    }
}

impl cbor_event::se::Serialize for SetDisplayNameRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("SetDisplayName")?;
        self.set_display_name.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for SetDisplayNameRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut set_display_name = None;
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
                        "SetDisplayName" => {
                            if set_display_name.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "SetDisplayName".into(),
                                ))
                                .into());
                            }
                            set_display_name =
                                Some(DisplayNameArgs::deserialize(raw).map_err(
                                    |e: DeserializeError| e.annotate("set_display_name"),
                                )?);
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
            let set_display_name =
                match set_display_name {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("SetDisplayName"),
                        ))
                        .into());
                    }
                };
            Ok(Self { set_display_name })
        })()
        .map_err(|e| e.annotate("SetDisplayNameRequest"))
    }
}

impl cbor_event::se::Serialize for SetPresenceArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("state")?;
        serializer.write_text(&self.state)?;
        Ok(serializer)
    }
}

impl Deserialize for SetPresenceArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut state = None;
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
                        "state" => {
                            if state.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "state".into(),
                                ))
                                .into());
                            }
                            state = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("state"))?,
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
            let state = match state {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("state")))
                            .into(),
                    );
                }
            };
            Ok(Self { state })
        })()
        .map_err(|e| e.annotate("SetPresenceArgs"))
    }
}

impl cbor_event::se::Serialize for SetPresenceRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("SetPresence")?;
        self.set_presence.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for SetPresenceRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut set_presence = None;
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
                        "SetPresence" => {
                            if set_presence.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "SetPresence".into(),
                                ))
                                .into());
                            }
                            set_presence = Some(
                                SetPresenceArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("set_presence"))?,
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
            let set_presence =
                match set_presence {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("SetPresence"),
                        ))
                        .into());
                    }
                };
            Ok(Self { set_presence })
        })()
        .map_err(|e| e.annotate("SetPresenceRequest"))
    }
}

impl cbor_event::se::Serialize for ShutdownRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            ShutdownRequest::ValueText53687574646F776E => serializer.write_text("Shutdown"),
        }
    }
}

impl Deserialize for ShutdownRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            match raw.cbor_type()? {
                cbor_event::Type::Text => {
                    let value_text53687574646_f776_e_value = raw.text()?;
                    if value_text53687574646_f776_e_value != "Shutdown" {
                        return Err(DeserializeFailure::FixedValueMismatch {
                            found: Key::Str(value_text53687574646_f776_e_value),
                            expected: Key::Str(String::from("Shutdown")),
                        }
                        .into());
                    }
                    Ok(ShutdownRequest::ValueText53687574646F776E)
                }
                _ => Err(DeserializeFailure::NoVariantMatched.into()),
            }
        })()
        .map_err(|e| e.annotate("ShutdownRequest"))
    }
}

impl cbor_event::se::Serialize for StartArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(3))?;
        serializer.write_text("data_dir")?;
        serializer.write_text(&self.data_dir)?;
        serializer.write_text("listen_port")?;
        serializer.write_unsigned_integer(self.listen_port)?;
        serializer.write_text("display_name")?;
        serializer.write_text(&self.display_name)?;
        Ok(serializer)
    }
}

impl Deserialize for StartArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(3)?;
            read_len.finish()?;
            let mut data_dir = None;
            let mut listen_port = None;
            let mut display_name = None;
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
                        "data_dir" => {
                            if data_dir.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "data_dir".into(),
                                ))
                                .into());
                            }
                            data_dir = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("data_dir"))?,
                            );
                        }
                        "listen_port" => {
                            if listen_port.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "listen_port".into(),
                                ))
                                .into());
                            }
                            listen_port = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("listen_port"))?,
                            );
                        }
                        "display_name" => {
                            if display_name.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "display_name".into(),
                                ))
                                .into());
                            }
                            display_name = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("display_name"))?,
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
            let data_dir =
                match data_dir {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("data_dir"),
                        ))
                        .into());
                    }
                };
            let display_name =
                match display_name {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("display_name"),
                        ))
                        .into());
                    }
                };
            let listen_port =
                match listen_port {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("listen_port"),
                        ))
                        .into());
                    }
                };
            Ok(Self {
                data_dir,
                display_name,
                listen_port,
            })
        })()
        .map_err(|e| e.annotate("StartArgs"))
    }
}

impl cbor_event::se::Serialize for StartRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("Start")?;
        self.start.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for StartRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut start = None;
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
                        "Start" => {
                            if start.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "Start".into(),
                                ))
                                .into());
                            }
                            start = Some(
                                StartArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("start"))?,
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
            let start = match start {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("Start")))
                            .into(),
                    );
                }
            };
            Ok(Self { start })
        })()
        .map_err(|e| e.annotate("StartRequest"))
    }
}

impl cbor_event::se::Serialize for SubscribeRequest {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        match self {
            SubscribeRequest::ValueText537562736372696265 => serializer.write_text("Subscribe"),
        }
    }
}

impl Deserialize for SubscribeRequest {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            match raw.cbor_type()? {
                cbor_event::Type::Text => {
                    let value_text537562736372696265_value = raw.text()?;
                    if value_text537562736372696265_value != "Subscribe" {
                        return Err(DeserializeFailure::FixedValueMismatch {
                            found: Key::Str(value_text537562736372696265_value),
                            expected: Key::Str(String::from("Subscribe")),
                        }
                        .into());
                    }
                    Ok(SubscribeRequest::ValueText537562736372696265)
                }
                _ => Err(DeserializeFailure::NoVariantMatched.into()),
            }
        })()
        .map_err(|e| e.annotate("SubscribeRequest"))
    }
}

impl cbor_event::se::Serialize for TransferDoneEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("TransferDone")?;
        self.transfer_done.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferDoneEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut transfer_done = None;
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
                        "TransferDone" => {
                            if transfer_done.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "TransferDone".into(),
                                ))
                                .into());
                            }
                            transfer_done = Some(
                                TransferRef::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("transfer_done"))?,
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
            let transfer_done =
                match transfer_done {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("TransferDone"),
                        ))
                        .into());
                    }
                };
            Ok(Self { transfer_done })
        })()
        .map_err(|e| e.annotate("TransferDoneEvent"))
    }
}

impl cbor_event::se::Serialize for TransferFailedArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(2))?;
        serializer.write_text("error")?;
        serializer.write_text(&self.error)?;
        serializer.write_text("transfer_id")?;
        serializer.write_text(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferFailedArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(2)?;
            read_len.finish()?;
            let mut error = None;
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
                        "error" => {
                            if error.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "error".into(),
                                ))
                                .into());
                            }
                            error = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("error"))?,
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
                                Ok(raw.text()?)
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
            let error = match error {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("error")))
                            .into(),
                    );
                }
            };
            Ok(Self { transfer_id, error })
        })()
        .map_err(|e| e.annotate("TransferFailedArgs"))
    }
}

impl cbor_event::se::Serialize for TransferFailedEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("TransferFailed")?;
        self.transfer_failed.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferFailedEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut transfer_failed = None;
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
                        "TransferFailed" => {
                            if transfer_failed.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "TransferFailed".into(),
                                ))
                                .into());
                            }
                            transfer_failed = Some(
                                TransferFailedArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("transfer_failed"))?,
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
            let transfer_failed =
                match transfer_failed {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("TransferFailed"),
                        ))
                        .into());
                    }
                };
            Ok(Self { transfer_failed })
        })()
        .map_err(|e| e.annotate("TransferFailedEvent"))
    }
}

impl cbor_event::se::Serialize for TransferFilter {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(
            match &self.state {
                Some(_) => 1,
                None => 0,
            } + match &self.peer_device_id {
                Some(_) => 1,
                None => 0,
            },
        ))?;
        if let Some(field) = &self.state {
            serializer.write_text("state")?;
            serializer.write_text(field)?;
        }
        if let Some(field) = &self.peer_device_id {
            serializer.write_text("peer_device_id")?;
            serializer.write_text(field)?;
        }
        Ok(serializer)
    }
}

impl Deserialize for TransferFilter {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            let mut state = None;
            let mut peer_device_id = None;
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
                        "state" => {
                            if state.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "state".into(),
                                ))
                                .into());
                            }
                            state = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.text()?)
                                })()
                                .map_err(|e| e.annotate("state"))?,
                            );
                        }
                        "peer_device_id" => {
                            if peer_device_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "peer_device_id".into(),
                                ))
                                .into());
                            }
                            peer_device_id = Some(
                                (|| -> Result<_, DeserializeError> {
                                    read_len.read_elems(1)?;
                                    Ok(raw.text()?)
                                })()
                                .map_err(|e| e.annotate("peer_device_id"))?,
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
            read_len.finish()?;
            Ok(Self {
                state,
                peer_device_id,
            })
        })()
        .map_err(|e| e.annotate("TransferFilter"))
    }
}

impl cbor_event::se::Serialize for TransferItemArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(4))?;
        serializer.write_text("state")?;
        serializer.write_text(&self.state)?;
        serializer.write_text("dest_path")?;
        serializer.write_text(&self.dest_path)?;
        serializer.write_text("item_index")?;
        serializer.write_unsigned_integer(self.item_index)?;
        serializer.write_text("transfer_id")?;
        serializer.write_text(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferItemArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(4)?;
            read_len.finish()?;
            let mut state = None;
            let mut dest_path = None;
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
                        "state" => {
                            if state.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "state".into(),
                                ))
                                .into());
                            }
                            state = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("state"))?,
                            );
                        }
                        "dest_path" => {
                            if dest_path.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "dest_path".into(),
                                ))
                                .into());
                            }
                            dest_path = Some(
                                Ok(raw.text()?)
                                    .map_err(|e: DeserializeError| e.annotate("dest_path"))?,
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
                                Ok(raw.text()?)
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
            let state = match state {
                Some(x) => x,
                None => {
                    return Err(
                        DeserializeFailure::MandatoryFieldMissing(Key::Str(String::from("state")))
                            .into(),
                    );
                }
            };
            let dest_path =
                match dest_path {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("dest_path"),
                        ))
                        .into());
                    }
                };
            Ok(Self {
                transfer_id,
                item_index,
                state,
                dest_path,
            })
        })()
        .map_err(|e| e.annotate("TransferItemArgs"))
    }
}

impl cbor_event::se::Serialize for TransferItemEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("TransferItem")?;
        self.transfer_item.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferItemEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut transfer_item = None;
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
                        "TransferItem" => {
                            if transfer_item.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "TransferItem".into(),
                                ))
                                .into());
                            }
                            transfer_item = Some(
                                TransferItemArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("transfer_item"))?,
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
            let transfer_item =
                match transfer_item {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("TransferItem"),
                        ))
                        .into());
                    }
                };
            Ok(Self { transfer_item })
        })()
        .map_err(|e| e.annotate("TransferItemEvent"))
    }
}

impl cbor_event::se::Serialize for TransferProgressArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(3))?;
        serializer.write_text("bytes_done")?;
        serializer.write_unsigned_integer(self.bytes_done)?;
        serializer.write_text("bytes_total")?;
        serializer.write_unsigned_integer(self.bytes_total)?;
        serializer.write_text("transfer_id")?;
        serializer.write_text(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferProgressArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(3)?;
            read_len.finish()?;
            let mut bytes_done = None;
            let mut bytes_total = None;
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
                        "bytes_done" => {
                            if bytes_done.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "bytes_done".into(),
                                ))
                                .into());
                            }
                            bytes_done = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("bytes_done"))?,
                            );
                        }
                        "bytes_total" => {
                            if bytes_total.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "bytes_total".into(),
                                ))
                                .into());
                            }
                            bytes_total = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("bytes_total"))?,
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
                                Ok(raw.text()?)
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
            let bytes_done =
                match bytes_done {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("bytes_done"),
                        ))
                        .into());
                    }
                };
            let bytes_total =
                match bytes_total {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("bytes_total"),
                        ))
                        .into());
                    }
                };
            Ok(Self {
                transfer_id,
                bytes_done,
                bytes_total,
            })
        })()
        .map_err(|e| e.annotate("TransferProgressArgs"))
    }
}

impl cbor_event::se::Serialize for TransferProgressEvent {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("TransferProgress")?;
        self.transfer_progress.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferProgressEvent {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut transfer_progress = None;
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
                        "TransferProgress" => {
                            if transfer_progress.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "TransferProgress".into(),
                                ))
                                .into());
                            }
                            transfer_progress =
                                Some(TransferProgressArgs::deserialize(raw).map_err(
                                    |e: DeserializeError| e.annotate("transfer_progress"),
                                )?);
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
            let transfer_progress =
                match transfer_progress {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("TransferProgress"),
                        ))
                        .into());
                    }
                };
            Ok(Self { transfer_progress })
        })()
        .map_err(|e| e.annotate("TransferProgressEvent"))
    }
}

impl cbor_event::se::Serialize for TransferRef {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("transfer_id")?;
        serializer.write_text(&self.transfer_id)?;
        Ok(serializer)
    }
}

impl Deserialize for TransferRef {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
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
                        "transfer_id" => {
                            if transfer_id.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "transfer_id".into(),
                                ))
                                .into());
                            }
                            transfer_id = Some(
                                Ok(raw.text()?)
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
            Ok(Self { transfer_id })
        })()
        .map_err(|e| e.annotate("TransferRef"))
    }
}

impl cbor_event::se::Serialize for UpdateRequiredArgs {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("min_major")?;
        serializer.write_unsigned_integer(self.min_major)?;
        Ok(serializer)
    }
}

impl Deserialize for UpdateRequiredArgs {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut min_major = None;
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
                        "min_major" => {
                            if min_major.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "min_major".into(),
                                ))
                                .into());
                            }
                            min_major = Some(
                                Ok(raw.unsigned_integer()?)
                                    .map_err(|e: DeserializeError| e.annotate("min_major"))?,
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
            let min_major =
                match min_major {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("min_major"),
                        ))
                        .into());
                    }
                };
            Ok(Self { min_major })
        })()
        .map_err(|e| e.annotate("UpdateRequiredArgs"))
    }
}

impl cbor_event::se::Serialize for UpdateRequiredResponse {
    fn serialize<'se>(
        &self,
        serializer: &'se mut Serializer,
    ) -> cbor_event::Result<&'se mut Serializer> {
        serializer.write_map(cbor_event::Len::Len(1))?;
        serializer.write_text("UpdateRequired")?;
        self.update_required.serialize(serializer)?;
        Ok(serializer)
    }
}

impl Deserialize for UpdateRequiredResponse {
    fn deserialize(raw: &mut Deserializer) -> Result<Self, DeserializeError> {
        (|| -> Result<_, DeserializeError> {
            let len = raw.map()?;
            let mut read_len = CBORReadLen::from(len);
            read_len.read_elems(1)?;
            read_len.finish()?;
            let mut update_required = None;
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
                        "UpdateRequired" => {
                            if update_required.is_some() {
                                return Err(DeserializeFailure::DuplicateKey(Key::Str(
                                    "UpdateRequired".into(),
                                ))
                                .into());
                            }
                            update_required = Some(
                                UpdateRequiredArgs::deserialize(raw)
                                    .map_err(|e: DeserializeError| e.annotate("update_required"))?,
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
            let update_required =
                match update_required {
                    Some(x) => x,
                    None => {
                        return Err(DeserializeFailure::MandatoryFieldMissing(Key::Str(
                            String::from("UpdateRequired"),
                        ))
                        .into());
                    }
                };
            Ok(Self { update_required })
        })()
        .map_err(|e| e.annotate("UpdateRequiredResponse"))
    }
}
