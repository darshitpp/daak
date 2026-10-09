//! System-Bonjour discovery for iOS.
//!
//! iOS requires a restricted entitlement for raw multicast, so `mdns-sd`
//! cannot run there. This module talks to mDNSResponder through `dns_sd.h`.
//! The public API equals the `mdns` backend. See the design spec.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::Rng;

use crate::error::{CoreError, Result};

use super::mdns::{
    announce_from_props, is_own_advertisement, sanitize_host, txt_short, PeerAnnounce,
    PROTO_VERSION,
};
use super::naming::resolve_name;
use super::records::{DiscoveryEvent, RecordTracker};

type SdRef = *mut c_void;

const SERVICE_TYPE: &str = "_daak._tcp";
// The values below match `dns_sd.h` in the macOS SDK.
const FLAG_ADD: u32 = 0x2; // kDNSServiceFlagsAdd
const FLAG_NO_AUTO_RENAME: u32 = 0x8; // kDNSServiceFlagsNoAutoRename
const FLAG_SHARE_CONNECTION: u32 = 0x4000; // kDNSServiceFlagsShareConnection
const IFACE_ANY: u32 = 0; // kDNSServiceInterfaceIndexAny
const IFACE_LOCAL_ONLY: u32 = 0xffff_ffff; // kDNSServiceInterfaceIndexLocalOnly
#[cfg(test)]
const TEST_ADDR: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
const ERR_NO_AUTH: i32 = -65555; // kDNSServiceErr_NoAuth
const ERR_NAME_CONFLICT: i32 = -65548; // kDNSServiceErr_NameConflict
const PROTOCOL_IPV4_IPV6: u32 = 0x01 | 0x02; // kDNSServiceProtocol_IPv4 | IPv6

type RegisterReply =
    extern "C" fn(SdRef, u32, i32, *const c_char, *const c_char, *const c_char, *mut c_void);
type BrowseReply =
    extern "C" fn(SdRef, u32, u32, i32, *const c_char, *const c_char, *const c_char, *mut c_void);
type ResolveReply = extern "C" fn(
    SdRef,
    u32,
    u32,
    i32,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const u8,
    *mut c_void,
);
// The `address` argument is a `const struct sockaddr *`. The callback reads it
// as bytes, so the type here is `*const u8`. The ABI is the same.
type AddrInfoReply =
    extern "C" fn(SdRef, u32, u32, i32, *const c_char, *const u8, u32, *mut c_void);

extern "C" {
    fn DNSServiceCreateConnection(sd_ref: *mut SdRef) -> i32;
    fn DNSServiceRefSockFD(sd_ref: SdRef) -> c_int;
    fn DNSServiceProcessResult(sd_ref: SdRef) -> i32;
    fn DNSServiceRefDeallocate(sd_ref: SdRef);
    #[allow(clippy::too_many_arguments)]
    fn DNSServiceRegister(
        sd_ref: *mut SdRef,
        flags: u32,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port_be: u16,
        txt_len: u16,
        txt: *const c_void,
        callback: RegisterReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceBrowse(
        sd_ref: *mut SdRef,
        flags: u32,
        interface: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceResolve(
        sd_ref: *mut SdRef,
        flags: u32,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceGetAddrInfo(
        sd_ref: *mut SdRef,
        flags: u32,
        interface: u32,
        protocol: u32,
        hostname: *const c_char,
        callback: AddrInfoReply,
        context: *mut c_void,
    ) -> i32;
}

/// A pointer that crosses to the thread that pumps it.
/// The pointee is touched by that one thread only, after the hand-over.
struct SendPtr<T>(T);
// SAFETY: see the type comment. The sender never uses the value again.
unsafe impl<T> Send for SendPtr<T> {}

fn discovery_err(what: &str, code: i32) -> CoreError {
    if code == ERR_NO_AUTH {
        return CoreError::Discovery(format!(
            "{what}: the system refused local network access ({code}). Allow Local Network for Daak in Settings."
        ));
    }
    CoreError::Discovery(format!("{what}: dns_sd error {code}"))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Build a TXT record: one length byte, then `key=value`, for each pair.
/// A pair longer than 255 bytes is cut so the length byte stays valid.
/// The cut lands on a character boundary, so the value stays valid UTF-8.
pub(crate) fn txt_record(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (k, v) in pairs {
        let mut entry = format!("{k}={v}");
        let mut end = entry.len().min(255);
        while !entry.is_char_boundary(end) {
            end -= 1;
        }
        entry.truncate(end);
        out.push(entry.len() as u8);
        out.extend(entry.into_bytes());
    }
    out
}

/// Parse a TXT record. A bad length stops the parse. It never panics.
pub(crate) fn parse_txt(bytes: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < bytes.len() {
        let len = bytes[i] as usize;
        i += 1;
        if i + len > bytes.len() {
            break;
        }
        if let Ok(s) = std::str::from_utf8(&bytes[i..i + len]) {
            if let Some((k, v)) = s.split_once('=') {
                map.insert(k.to_string(), v.to_string());
            }
        }
        i += len;
    }
    map
}

/// The longest DNS-SD instance name, in bytes.
const MAX_INSTANCE_BYTES: usize = 63;

/// The service instance name for a display name.
/// A name with no ASCII letter or digit gives `daak-` and 8 hex digits of the
/// device id. The result has at most 63 bytes and no trailing `-`.
fn instance_name(display_name: &str, device_id: [u8; 16]) -> String {
    let mut name = sanitize_host(display_name);
    if name.is_empty() {
        name = format!("daak-{}", &hex::encode(device_id)[..8]);
    }
    let mut end = name.len().min(MAX_INSTANCE_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name.truncate(end);
    name.trim_end_matches('-').to_string()
}

/// What `pump` does after one `poll` wake.
#[derive(Debug, PartialEq, Eq)]
enum PollAction {
    Process,
    Stop,
    Idle,
}

/// Choose the action for the `revents` of the connection fd.
/// Data to read always comes first, so a final event is not lost when the
/// peer closes. `POLLERR` or `POLLHUP` with no data to read stops the loop.
fn poll_action(revents: i16) -> PollAction {
    if revents & libc::POLLNVAL != 0 {
        PollAction::Stop
    } else if revents & libc::POLLIN != 0 {
        PollAction::Process
    } else if revents & (libc::POLLERR | libc::POLLHUP) != 0 {
        PollAction::Stop
    } else {
        PollAction::Idle
    }
}

/// Run `DNSServiceProcessResult` until `stop` is set or the connection fails.
/// `after` runs once per wake. The wake interval is 200 ms.
fn pump(root: SdRef, stop: &AtomicBool, mut after: impl FnMut()) {
    // SAFETY: root is a live ref. Only this thread uses it.
    let fd = unsafe { DNSServiceRefSockFD(root) };
    if fd < 0 {
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        let mut p = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: p is a valid pollfd and the count is 1.
        let n = unsafe { libc::poll(&mut p, 1, 200) };
        if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() != std::io::ErrorKind::Interrupted {
                tracing::warn!(%err, "poll failed. Discovery stops for this connection.");
                break;
            }
        }
        if n > 0 {
            match poll_action(p.revents) {
                PollAction::Process => {
                    // SAFETY: root is live. The callbacks run here, on this thread.
                    let rc = unsafe { DNSServiceProcessResult(root) };
                    if rc != 0 {
                        tracing::warn!(
                            code = rc,
                            "DNSServiceProcessResult failed. Discovery stops for this connection."
                        );
                        break;
                    }
                }
                PollAction::Stop => {
                    tracing::warn!(
                        revents = p.revents,
                        "The connection to the system failed. Discovery stops for this connection."
                    );
                    break;
                }
                PollAction::Idle => {}
            }
        }
        after();
    }
}

// ---- Advertiser ----

/// The interface for a registration. A test build registers on the local host
/// only, so a test never shows a fake peer to a real device on the LAN.
fn register_iface() -> u32 {
    if cfg!(test) {
        IFACE_LOCAL_ONLY
    } else {
        IFACE_ANY
    }
}

/// Why a registration failed. A taken name is a case of its own.
enum RegisterError {
    NameConflict,
    Other(CoreError),
}

pub struct Advertiser {
    sd: SdRef,
    stop: Arc<AtomicBool>,
    conflict: Arc<AtomicI32>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

// SAFETY: `sd` is used only by the pump thread and by `stop`, and `stop`
// first joins the pump thread. The other fields are Send and Sync.
unsafe impl Send for Advertiser {}
unsafe impl Sync for Advertiser {}

extern "C" fn register_cb(
    _: SdRef,
    _: u32,
    err: i32,
    _: *const c_char,
    _: *const c_char,
    _: *const c_char,
    ctx: *mut c_void,
) {
    if err != 0 {
        // SAFETY: ctx points into the AtomicI32 in the Advertiser `conflict` Arc.
        // The Advertiser holds that Arc until after the ref is deallocated.
        unsafe { (*(ctx as *const AtomicI32)).store(err, Ordering::SeqCst) };
    }
}

impl Advertiser {
    pub fn start(name: &str, port: u16, device_id: [u8; 16]) -> Result<Self> {
        Self::start_with_meta(name, port, device_id, "", "", 0, "online", None)
    }

    /// `_bind_ip` is ignored. mDNSResponder publishes the host address records.
    #[allow(clippy::too_many_arguments)]
    pub fn start_with_meta(
        name: &str,
        port: u16,
        device_id: [u8; 16],
        fp: &str,
        pk: &str,
        caps: u32,
        status: &str,
        bind_ip: Option<IpAddr>,
    ) -> Result<Self> {
        Self::register(name, port, device_id, fp, pk, caps, status, bind_ip).map_err(|e| match e {
            RegisterError::NameConflict => discovery_err("register", ERR_NAME_CONFLICT),
            RegisterError::Other(e) => e,
        })
    }

    /// Like `start_with_meta`, but a taken name gives the typed `NameConflict`.
    #[allow(clippy::too_many_arguments)]
    fn register(
        name: &str,
        port: u16,
        device_id: [u8; 16],
        fp: &str,
        pk: &str,
        caps: u32,
        status: &str,
        _bind_ip: Option<IpAddr>,
    ) -> std::result::Result<Self, RegisterError> {
        let id = hex::encode(device_id);
        let ver = PROTO_VERSION.to_string();
        let caps = caps.to_string();
        let mut pairs: Vec<(&str, &str)> = vec![("id", &id), ("name", name), ("v", &ver)];
        let fp = txt_short(fp, 20);
        let pk = txt_short(pk, 16);
        if let Some(f) = fp.as_deref() {
            pairs.push(("fp", f));
        }
        if let Some(p) = pk.as_deref() {
            pairs.push(("pk", p));
        }
        pairs.push(("caps", &caps));
        pairs.push(("st", status));
        let txt = txt_record(&pairs);

        let instance = CString::new(instance_name(name, device_id))
            .map_err(|e| RegisterError::Other(CoreError::Discovery(e.to_string())))?;
        let regtype = CString::new(SERVICE_TYPE).expect("constant has no NUL");
        let conflict = Arc::new(AtomicI32::new(0));
        let mut sd: SdRef = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call. The service copies the
        // strings and the TXT data. The context is the AtomicI32 in `conflict`,
        // and the returned Advertiser owns that Arc until the ref is gone.
        let rc = unsafe {
            DNSServiceRegister(
                &mut sd,
                FLAG_NO_AUTO_RENAME,
                register_iface(),
                instance.as_ptr(),
                regtype.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                port.to_be(),
                txt.len() as u16,
                txt.as_ptr().cast(),
                register_cb,
                Arc::as_ptr(&conflict) as *mut c_void,
            )
        };
        if rc == ERR_NAME_CONFLICT {
            return Err(RegisterError::NameConflict);
        }
        if rc != 0 {
            return Err(RegisterError::Other(discovery_err("register", rc)));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let t_stop = stop.clone();
        let t_sd = SendPtr(sd);
        let thread = std::thread::spawn(move || {
            let t_sd = t_sd; // capture the whole wrapper, not the raw field
            pump(t_sd.0, &t_stop, || {});
        });
        Ok(Self {
            sd,
            stop,
            conflict,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn start_resolving(
        base_name: &str,
        port: u16,
        device_id: [u8; 16],
        rng: &mut impl Rng,
    ) -> Result<(Self, String)> {
        Self::start_resolving_on(base_name, port, device_id, rng, None)
    }

    /// Choose a display name that no other peer uses, then advertise it.
    /// A taken name arrives in two ways. A local-only registration fails at
    /// once with NameConflict. A LAN registration reports it later, through
    /// `conflicted`. Both ways pick a new name. Any other error propagates.
    pub fn start_resolving_on(
        base_name: &str,
        port: u16,
        device_id: [u8; 16],
        rng: &mut impl Rng,
        bind_ip: Option<IpAddr>,
    ) -> Result<(Self, String)> {
        // The filter by `device_id` keeps our own fresh record out of the list.
        let names = |w| {
            observed(w, Some(device_id))
                .into_iter()
                .map(|a| a.name)
                .collect::<Vec<_>>()
        };
        let start =
            |name: &str| Self::register(name, port, device_id, "", "", 0, "online", bind_ip);
        let mut seen = names(super::mdns::BROWSE_WINDOW);
        let mut name = resolve_name(base_name, &seen, rng);
        for _ in 0..2 {
            match start(&name) {
                Ok(adv) => {
                    let late = names(super::mdns::RECHECK_WINDOW);
                    if !late.contains(&name) && !adv.conflicted() {
                        return Ok((adv, name));
                    }
                    adv.stop();
                    seen.extend(late);
                }
                Err(RegisterError::NameConflict) => {}
                Err(RegisterError::Other(e)) => return Err(e),
            }
            seen.push(name.clone());
            name = resolve_name(base_name, &seen, rng);
        }
        match start(&name) {
            Ok(adv) => Ok((adv, name)),
            Err(RegisterError::NameConflict) => Err(discovery_err("register", ERR_NAME_CONFLICT)),
            Err(RegisterError::Other(e)) => Err(e),
        }
    }

    /// True when the system reported a name conflict for this registration.
    pub fn conflicted(&self) -> bool {
        self.conflict.load(Ordering::SeqCst) == ERR_NAME_CONFLICT
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = lock(&self.thread).take() {
            let _ = t.join();
            // SAFETY: the pump thread ended, so no callback can run on this ref.
            // The take() above makes this the only deallocation.
            unsafe { DNSServiceRefDeallocate(self.sd) };
        }
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---- Browser ----

/// One discovered service instance on one interface.
struct Svc {
    gen: u64,
    /// The context of `resolve` and `addr`. `Drop` frees it, after both refs are gone.
    /// It is a raw pointer because the system holds a copy of the address.
    ctx: *mut Key,
    iface: u32,
    resolve: SdRef,
    addr: SdRef, // null until the first resolve reply
    host: String,
    port: u16,
    txt: Vec<u8>,
    addrs: Vec<IpAddr>,
    /// Set by `resolve_cb` when the host changes. The pump loop restarts the lookup.
    restart_addr: bool,
}

/// True when a later resolve reply names a new host. The first reply is no change.
fn host_changed(old: &str, new: &str) -> bool {
    !old.is_empty() && old != new
}

impl Drop for Svc {
    fn drop(&mut self) {
        // SAFETY: `ctx` came from `Box::into_raw` and nothing else frees it.
        // `drain_dead` and the thread exit deallocate the refs before this drop.
        drop(unsafe { Box::from_raw(self.ctx) });
    }
}

struct State {
    root: SdRef,
    browse: SdRef,
    sink: Box<dyn FnMut(DiscoveryEvent) + Send>,
    // The tracker key is the same string as the `services` key.
    tracker: RecordTracker,
    services: HashMap<String, Box<Svc>>, // key: "<instance>\0<interface>"
    // The Svc stays boxed so the address of its Key owner never moves.
    #[allow(clippy::vec_box)]
    dead: Vec<Box<Svc>>, // freed after ProcessResult returns
    next_gen: u64,
}

/// The context for one resolve and its address lookup.
/// `gen` tells a late callback of a removed service from a new service with the same key.
struct Key {
    state: *mut State,
    key: String,
    gen: u64,
}

/// Look up the live service of a callback context. Return None for a stale callback.
///
/// # Safety
/// `ctx` must be a `*const Key` that belongs to a live `Svc`, and the call must
/// come from the pump thread. The returned borrows must not outlive the callback.
unsafe fn service_of<'a>(ctx: *mut c_void) -> Option<(&'a mut State, &'a mut Svc)> {
    let key = &*(ctx as *const Key);
    let state = &mut *key.state;
    let state_ptr: *mut State = state;
    // Split the borrow: the map entry and the state fields are used apart.
    let svc = (*state_ptr).services.get_mut(&key.key)?;
    if svc.gen != key.gen {
        return None;
    }
    Some((&mut *state_ptr, &mut **svc))
}

/// Report the record as `Found`. Return the device id when the record parses.
fn emit(svc: &Svc, sink: &mut dyn FnMut(DiscoveryEvent)) -> Option<[u8; 16]> {
    let map = parse_txt(&svc.txt);
    // A local-only service resolves to the loopback address only, and
    // `pick_addr` drops that. In a test build, a local-only service that has an
    // address reports a fixed documentation address (RFC 5737) in its place.
    #[cfg(test)]
    let addrs: Vec<IpAddr> = if svc.iface == IFACE_LOCAL_ONLY && !svc.addrs.is_empty() {
        vec![TEST_ADDR]
    } else {
        svc.addrs.clone()
    };
    #[cfg(not(test))]
    let addrs = &svc.addrs;
    // A record without an `id` key gives Err and is skipped.
    if let Ok(a) = announce_from_props(
        |k| map.get(k).cloned(),
        &svc.host,
        addrs.iter().copied(),
        svc.port,
    ) {
        let id = a.device_id;
        sink(DiscoveryEvent::Found(a));
        return Some(id);
    }
    None
}

/// Report the record and remember which device it announces.
fn emit_and_track(state: &mut State, svc: &Svc) {
    if let Some(id) = emit(svc, &mut state.sink) {
        // SAFETY: `ctx` is the Key of this Svc. The Svc owns it until it drops.
        let key = unsafe { &(*svc.ctx).key };
        state.tracker.found(key, id);
    }
}

extern "C" fn browse_cb(
    _: SdRef,
    flags: u32,
    iface: u32,
    err: i32,
    name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    ctx: *mut c_void,
) {
    if err != 0 || name.is_null() {
        return;
    }
    let sp = ctx as *mut State;
    // SAFETY: ctx is the State that `spawn_browse` allocated. It lives until the
    // pump thread ends. This callback runs on that thread.
    let state = unsafe { &mut *sp };
    // SAFETY: the system passes a valid NUL-terminated string.
    let inst = unsafe { CStr::from_ptr(name) }.to_string_lossy();
    let key = format!("{inst}\0{iface}");
    if flags & FLAG_ADD == 0 {
        // Move the Svc out. The refs are deallocated after ProcessResult returns.
        if let Some(s) = state.services.remove(&key) {
            state.dead.push(s);
        }
        // The sink call frees no ref. A record that never resolved gives None.
        if let Some(id) = state.tracker.removed(&key) {
            (state.sink)(DiscoveryEvent::Lost(id));
        }
        return;
    }
    if state.services.contains_key(&key) {
        return;
    }
    state.next_gen += 1;
    let gen = state.next_gen;
    let kctx = Box::into_raw(Box::new(Key {
        state: sp,
        key: key.clone(),
        gen,
    }));
    let kp = kctx as *mut c_void;
    // A shared sub-ref starts as a copy of the root ref.
    let mut r = state.root;
    // SAFETY: name, regtype and domain are valid for the call. The Svc below
    // owns the Key and frees it after the refs are gone.
    let rc = unsafe {
        DNSServiceResolve(
            &mut r,
            FLAG_SHARE_CONNECTION,
            iface,
            name,
            regtype,
            domain,
            resolve_cb,
            kp,
        )
    };
    if rc != 0 {
        // SAFETY: no ref holds the Key, and no Svc owns it. This is the only owner.
        drop(unsafe { Box::from_raw(kctx) });
        return;
    }
    state.services.insert(
        key,
        Box::new(Svc {
            gen,
            ctx: kctx,
            iface,
            resolve: r,
            addr: std::ptr::null_mut(),
            host: String::new(),
            port: 0,
            txt: Vec::new(),
            addrs: Vec::new(),
            restart_addr: false,
        }),
    );
}

extern "C" fn resolve_cb(
    _: SdRef,
    _: u32,
    _: u32,
    err: i32,
    _: *const c_char,
    host: *const c_char,
    port_be: u16,
    txt_len: u16,
    txt: *const u8,
    ctx: *mut c_void,
) {
    if err != 0 || host.is_null() {
        return;
    }
    // SAFETY: ctx is the Key of a live Svc. This callback runs on the pump thread.
    let Some((state, svc)) = (unsafe { service_of(ctx) }) else {
        return;
    };
    // SAFETY: the system passes a valid NUL-terminated string.
    let new_host = unsafe { CStr::from_ptr(host) }
        .to_string_lossy()
        .into_owned();
    // A callback must not free a ref. The pump loop restarts the lookup.
    if host_changed(&svc.host, &new_host) {
        svc.restart_addr = true;
    }
    svc.host = new_host;
    svc.port = u16::from_be(port_be);
    svc.txt = if txt.is_null() || txt_len == 0 {
        Vec::new()
    } else {
        // SAFETY: the system passes `txt_len` readable bytes at `txt`.
        unsafe { std::slice::from_raw_parts(txt, txt_len as usize) }.to_vec()
    };
    if !svc.addr.is_null() {
        // A later resolve reply, such as a TXT change. Send the known addresses again.
        // After a host change, the pump loop clears the old addresses first.
        if !svc.restart_addr {
            emit_and_track(state, svc);
        }
        return;
    }
    let Ok(host_c) = CString::new(svc.host.as_str()) else {
        return;
    };
    let mut a = state.root;
    // SAFETY: host_c is valid for the call. The context is the Key of this Svc.
    // The Svc deallocates this ref before it frees the Key.
    let rc = unsafe {
        DNSServiceGetAddrInfo(
            &mut a,
            FLAG_SHARE_CONNECTION,
            svc.iface,
            PROTOCOL_IPV4_IPV6,
            host_c.as_ptr(),
            addr_cb,
            ctx,
        )
    };
    if rc == 0 {
        svc.addr = a;
    }
}

extern "C" fn addr_cb(
    _: SdRef,
    flags: u32,
    _: u32,
    err: i32,
    _: *const c_char,
    sockaddr: *const u8,
    _: u32,
    ctx: *mut c_void,
) {
    if err != 0 || sockaddr.is_null() {
        return;
    }
    // SAFETY: the system passes a sockaddr_in (16 bytes) or sockaddr_in6 (28 bytes).
    // Byte 1 is the family. The reads below stay inside the structure for that family.
    let ip = unsafe {
        match *sockaddr.add(1) as c_int {
            libc::AF_INET => {
                let b = std::slice::from_raw_parts(sockaddr.add(4), 4);
                IpAddr::V4(Ipv4Addr::new(b[0], b[1], b[2], b[3]))
            }
            libc::AF_INET6 => {
                let b: [u8; 16] = std::slice::from_raw_parts(sockaddr.add(8), 16)
                    .try_into()
                    .expect("slice has 16 bytes");
                IpAddr::V6(Ipv6Addr::from(b))
            }
            _ => return,
        }
    };
    // SAFETY: ctx is the Key of a live Svc. This callback runs on the pump thread.
    let Some((state, svc)) = (unsafe { service_of(ctx) }) else {
        return;
    };
    if flags & FLAG_ADD == 0 {
        svc.addrs.retain(|a| *a != ip);
        return;
    }
    if !svc.addrs.contains(&ip) {
        svc.addrs.push(ip);
    }
    emit_and_track(state, svc);
}

/// Start a new address lookup for every service whose host changed.
/// The caller must not run inside a callback.
fn restart_addr_lookups(state: &mut State) {
    let root = state.root;
    for svc in state.services.values_mut().filter(|s| s.restart_addr) {
        svc.restart_addr = false;
        // SAFETY: the old ref is live and this thread created it. No callback runs
        // now, so none can use the Key through the old ref after this call.
        if !svc.addr.is_null() {
            unsafe { DNSServiceRefDeallocate(svc.addr) };
        }
        svc.addr = std::ptr::null_mut();
        svc.addrs.clear();
        let Ok(host_c) = CString::new(svc.host.as_str()) else {
            continue;
        };
        let mut a = root;
        // SAFETY: host_c is valid for the call. The context is the Key of this Svc.
        // The Svc deallocates the new ref before it frees the Key.
        let rc = unsafe {
            DNSServiceGetAddrInfo(
                &mut a,
                FLAG_SHARE_CONNECTION,
                svc.iface,
                PROTOCOL_IPV4_IPV6,
                host_c.as_ptr(),
                addr_cb,
                svc.ctx as *mut c_void,
            )
        };
        // On failure, `addr` stays null. The next resolve reply starts a lookup.
        if rc == 0 {
            svc.addr = a;
        }
    }
}

/// Deallocate the refs of every service in `dead`, then drop the services.
/// The caller must not run inside a callback.
fn drain_dead(state: &mut State) {
    for svc in state.dead.drain(..) {
        // SAFETY: each ref is live and was created by this thread. After the
        // calls, no callback can use the Key, so the drop below is safe.
        unsafe {
            if !svc.resolve.is_null() {
                DNSServiceRefDeallocate(svc.resolve);
            }
            if !svc.addr.is_null() {
                DNSServiceRefDeallocate(svc.addr);
            }
        }
    }
}

/// The owner of the browse thread.
struct BrowseHandle {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl BrowseHandle {
    /// Set the stop flag and join the thread. The thread frees all its refs.
    fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = lock(&self.thread).take() {
            let _ = t.join();
        }
    }
}

impl Drop for BrowseHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_browse(sink: Box<dyn FnMut(DiscoveryEvent) + Send>) -> Result<BrowseHandle> {
    let mut root: SdRef = std::ptr::null_mut();
    // SAFETY: root is a valid out pointer.
    let rc = unsafe { DNSServiceCreateConnection(&mut root) };
    if rc != 0 {
        return Err(discovery_err("connect", rc));
    }
    let state = Box::into_raw(Box::new(State {
        root,
        browse: std::ptr::null_mut(),
        sink,
        tracker: RecordTracker::default(),
        services: HashMap::new(),
        dead: Vec::new(),
        next_gen: 0,
    }));
    let regtype = CString::new(SERVICE_TYPE).expect("constant has no NUL");
    let mut b = root; // a shared sub-ref starts as a copy of the root ref
                      // SAFETY: regtype is valid for the call. `state` stays allocated until the
                      // pump thread ends, or until the error branch below frees it.
    let rc = unsafe {
        DNSServiceBrowse(
            &mut b,
            FLAG_SHARE_CONNECTION,
            0,
            regtype.as_ptr(),
            std::ptr::null(),
            browse_cb,
            state as *mut c_void,
        )
    };
    if rc != 0 {
        // SAFETY: no thread runs yet. The root ref and the state have one owner: this branch.
        unsafe {
            DNSServiceRefDeallocate(root);
            drop(Box::from_raw(state));
        }
        return Err(discovery_err("browse", rc));
    }
    // SAFETY: no thread runs yet.
    unsafe { (*state).browse = b };
    let stop = Arc::new(AtomicBool::new(false));
    let t_stop = stop.clone();
    let sp = SendPtr(state);
    let thread = std::thread::spawn(move || {
        let sp = sp; // capture the whole wrapper, not the raw field
        let state = sp.0;
        // SAFETY: this thread owns `state` from now on. Callbacks also run here.
        // The root ref is read from the state, so the closure captures no raw ref.
        let root = unsafe { (*state).root };
        pump(root, &t_stop, || {
            // SAFETY: the pump runs this closure on the thread that owns `state`.
            // No callback is active here.
            let st = unsafe { &mut *state };
            restart_addr_lookups(st);
            drain_dead(st);
        });
        // SAFETY: the pump ended, so no callback runs. This thread is the only owner.
        let mut st = unsafe { Box::from_raw(state) };
        let live: Vec<_> = st.services.drain().map(|(_, s)| s).collect();
        st.dead.extend(live);
        drain_dead(&mut st);
        // SAFETY: all sub-refs are gone. Deallocate the browse ref, then the root.
        unsafe {
            DNSServiceRefDeallocate(st.browse);
            DNSServiceRefDeallocate(st.root);
        }
        // `st` drops here and drops the sink.
    });
    Ok(BrowseHandle {
        stop,
        thread: Mutex::new(Some(thread)),
    })
}

pub struct Browser {
    rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<DiscoveryEvent>>,
    handle: BrowseHandle,
}

impl Browser {
    pub fn start() -> Result<Self> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = spawn_browse(Box::new(move |e| {
            let _ = tx.send(e);
        }))?;
        Ok(Self {
            rx: tokio::sync::Mutex::new(rx),
            handle,
        })
    }

    /// The next peer record. `None` after `stop`.
    pub async fn recv(&self) -> Option<DiscoveryEvent> {
        self.rx.lock().await.recv().await
    }

    pub fn stop(&self) {
        self.handle.shutdown();
    }
}

/// Peers seen in `window`, minus the record of `own`. Blocking.
pub(crate) fn observed(window: Duration, own: Option<[u8; 16]>) -> Vec<PeerAnnounce> {
    let (tx, rx) = std::sync::mpsc::channel();
    let Ok(b) = spawn_browse(Box::new(move |e| {
        let _ = tx.send(e);
    })) else {
        return vec![];
    };
    let deadline = std::time::Instant::now() + window;
    let mut out = Vec::new();
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(DiscoveryEvent::Found(a)) if !is_own_advertisement(Some(a.device_id), own) => {
                out.push(a)
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    b.shutdown();
    out
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::time::Duration;

    fn unique_id() -> [u8; 16] {
        rand::random()
    }

    fn unique_port() -> u16 {
        40_000 + (rand::random::<u16>() % 20_000)
    }

    #[tokio::test]
    async fn txt_keys_survive_an_advertise_and_browse_round_trip() {
        let id = unique_id();
        let port = unique_port();
        let name = format!("dnssd-rt-{}", hex::encode(&id[..4]));
        let adv = Advertiser::start_with_meta(&name, port, id, "", "", 7, "online", None).unwrap();
        let browser = Browser::start().unwrap();
        let found = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let Some(DiscoveryEvent::Found(a)) = browser.recv().await else {
                    panic!("the browse must report a found record");
                };
                if a.device_id == id {
                    return a;
                }
            }
        })
        .await
        .expect("the browse must find the advertised service");
        assert_eq!(found.name, name);
        assert_eq!(found.port, port);
        assert_eq!(found.addr.ip(), TEST_ADDR);
        assert_eq!(found.capabilities, 7);
        assert_eq!(found.status, "online");
        assert_eq!(found.proto_version, PROTO_VERSION);
        browser.stop();
        adv.stop();
    }

    fn start_named(name: &str) -> Advertiser {
        start_named_with_id(name, unique_id())
    }

    fn start_named_with_id(name: &str, id: [u8; 16]) -> Advertiser {
        Advertiser::start_with_meta(name, unique_port(), id, "", "", 0, "online", None).unwrap()
    }

    // Observed: a test build registers on the local host only, so the system
    // refuses a duplicate name at once. The call returns NameConflict (-65548).
    // A LAN registration reports the same code later, through `register_cb`.
    #[tokio::test]
    async fn a_stopped_advertiser_reports_lost() {
        let id = unique_id();
        let name = format!("dnssd-lost-{}", hex::encode(&id[..4]));
        let adv = start_named_with_id(&name, id);
        let browser = Browser::start().unwrap();
        let saw_found = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(DiscoveryEvent::Found(a)) = browser.recv().await {
                    if a.device_id == id {
                        return;
                    }
                }
            }
        })
        .await;
        assert!(saw_found.is_ok(), "the browse must find the service first");
        adv.stop();
        let lost = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(DiscoveryEvent::Lost(got)) = browser.recv().await {
                    if got == id {
                        return;
                    }
                }
            }
        })
        .await;
        assert!(lost.is_ok(), "the browse must report the removal");
        browser.stop();
    }

    #[test]
    fn a_taken_local_instance_name_is_refused() {
        let name = format!("dnssd-cf-{}", hex::encode(&unique_id()[..4]));
        let first = start_named(&name);
        let second = Advertiser::start_with_meta(
            &name,
            unique_port(),
            unique_id(),
            "",
            "",
            0,
            "online",
            None,
        );
        let err = second.err().expect("the duplicate must fail").to_string();
        assert!(err.contains("-65548"), "{err}");
        assert!(!first.conflicted());
        first.stop();
    }

    #[test]
    fn a_duplicate_name_is_a_typed_conflict() {
        let name = format!("dnssd-tc-{}", hex::encode(&unique_id()[..4]));
        let first = start_named(&name);
        let second =
            Advertiser::register(&name, unique_port(), unique_id(), "", "", 0, "online", None);
        assert!(matches!(second, Err(RegisterError::NameConflict)));
        first.stop();
    }

    // The LAN path: the system calls `register_cb` with NameConflict.
    #[test]
    fn the_register_callback_records_a_name_conflict() {
        let slot = AtomicI32::new(0);
        let ctx = &slot as *const AtomicI32 as *mut c_void;
        let nul = std::ptr::null();
        register_cb(std::ptr::null_mut(), 0, 0, nul, nul, nul, ctx);
        assert_eq!(slot.load(Ordering::SeqCst), 0);
        register_cb(
            std::ptr::null_mut(),
            0,
            ERR_NAME_CONFLICT,
            nul,
            nul,
            nul,
            ctx,
        );
        assert_eq!(slot.load(Ordering::SeqCst), ERR_NAME_CONFLICT);
    }

    #[test]
    fn a_stopped_advertiser_leaves_the_lan() {
        let id = unique_id();
        let name = format!("dnssd-st-{}", hex::encode(&id[..4]));
        let adv = Advertiser::start_with_meta(&name, unique_port(), id, "", "", 0, "online", None)
            .unwrap();
        assert!(wait_for(id, true));
        adv.stop();
        assert!(wait_for(id, false));
    }

    fn wait_for(id: [u8; 16], present: bool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            let seen = observed(Duration::from_millis(1500), None)
                .iter()
                .any(|a| a.device_id == id);
            if seen == present {
                return true;
            }
        }
        false
    }

    #[test]
    fn a_taken_display_name_gets_a_new_name() {
        let base = format!("Kitchen-{}", hex::encode(&unique_id()[..4]));
        let squatter_id = unique_id();
        let squatter = Advertiser::start_with_meta(
            &base,
            unique_port(),
            squatter_id,
            "",
            "",
            0,
            "online",
            None,
        )
        .unwrap();
        assert!(wait_for(squatter_id, true));
        let mut rng = rand::thread_rng();
        let (adv, name) =
            Advertiser::start_resolving_on(&base, unique_port(), unique_id(), &mut rng, None)
                .unwrap();
        assert_ne!(name, base);
        adv.stop();
        squatter.stop();
    }

    #[test]
    fn a_free_display_name_is_kept() {
        let base = format!("Free-{}", hex::encode(&unique_id()[..4]));
        let mut rng = rand::thread_rng();
        let (adv, name) =
            Advertiser::start_resolving_on(&base, unique_port(), unique_id(), &mut rng, None)
                .unwrap();
        assert_eq!(name, base);
        adv.stop();
    }

    #[test]
    fn the_own_record_is_filtered_by_device_id() {
        let id = unique_id();
        let name = format!("dnssd-own-{}", hex::encode(&id[..4]));
        let adv = Advertiser::start_with_meta(&name, unique_port(), id, "", "", 0, "online", None)
            .unwrap();
        assert!(wait_for(id, true));
        let with_filter = observed(Duration::from_millis(1500), Some(id));
        assert!(with_filter.iter().all(|a| a.device_id != id));
        adv.stop();
    }
}

#[cfg(all(test, any(target_os = "ios", target_os = "macos")))]
mod pure_tests {
    use super::*;

    #[test]
    fn a_new_host_needs_an_address_restart() {
        assert!(host_changed("a.local.", "b.local."));
        assert!(!host_changed("a.local.", "a.local."));
        assert!(!host_changed("", "a.local."));
    }

    #[test]
    fn a_txt_value_over_255_bytes_is_cut_to_fit() {
        let rec = txt_record(&[("name", &"x".repeat(400))]);
        assert!(rec.len() <= 256);
        assert_eq!(rec[0] as usize, rec.len() - 1);
    }

    #[test]
    fn a_txt_record_without_an_id_is_skipped() {
        let rec = txt_record(&[("name", "no-id")]);
        let map = parse_txt(&rec);
        assert!(announce_from_props(
            |k| map.get(k).cloned(),
            "h.local.",
            ["192.168.0.5".parse().unwrap()].into_iter(),
            1
        )
        .is_err());
    }

    #[test]
    fn a_txt_record_round_trips_every_pair() {
        let rec = txt_record(&[("id", "ab"), ("st", "online")]);
        let map = parse_txt(&rec);
        assert_eq!(map.get("id").map(String::as_str), Some("ab"));
        assert_eq!(map.get("st").map(String::as_str), Some("online"));
    }

    #[test]
    fn a_normal_name_is_the_instance() {
        assert_eq!(
            instance_name("Kitchen Tablet", [7; 16]),
            sanitize_host("Kitchen Tablet")
        );
    }

    #[test]
    fn a_non_ascii_name_falls_back_to_the_device_id() {
        let id = [0xab; 16];
        let a = instance_name("ダーシット", id);
        assert_eq!(a, "daak-abababab");
        assert_eq!(a, instance_name("ダーシット", id));
    }

    #[test]
    fn a_long_name_fits_the_63_byte_limit() {
        let name = "a".repeat(62) + &"b".repeat(138);
        let got = instance_name(&name, [1; 16]);
        assert!(got.len() <= 63 && !got.is_empty());
        assert!(!got.ends_with('-'));
        let spaced = "a".repeat(62) + " " + &"b".repeat(137);
        let got = instance_name(&spaced, [1; 16]);
        assert_eq!(got, "a".repeat(62));
    }

    #[test]
    fn a_multibyte_txt_value_is_cut_on_a_char_boundary() {
        // The prefix "nam=" has 4 bytes. 251 bytes remain, which is inside a char.
        let v = "é".repeat(200);
        let rec = txt_record(&[("nam", &v)]);
        assert_eq!(rec[0] as usize, rec.len() - 1);
        let map = parse_txt(&rec);
        let got = map.get("nam").expect("the pair survives the cut");
        assert_eq!(got, &"é".repeat(125));
        assert_eq!(got.len(), 250);
    }

    #[test]
    fn poll_events_map_to_one_action() {
        use libc::{POLLERR, POLLHUP, POLLIN, POLLNVAL};
        assert_eq!(poll_action(POLLIN), PollAction::Process);
        assert_eq!(poll_action(POLLIN | POLLHUP), PollAction::Process);
        assert_eq!(poll_action(POLLIN | POLLERR), PollAction::Process);
        assert_eq!(poll_action(POLLHUP), PollAction::Stop);
        assert_eq!(poll_action(POLLERR), PollAction::Stop);
        assert_eq!(poll_action(POLLNVAL), PollAction::Stop);
        assert_eq!(poll_action(POLLIN | POLLNVAL), PollAction::Stop);
        assert_eq!(poll_action(0), PollAction::Idle);
    }

    #[test]
    fn a_truncated_txt_record_does_not_panic() {
        let map = parse_txt(&[9, b'a', b'=', b'b']);
        assert!(map.is_empty());
        assert!(parse_txt(&[]).is_empty());
    }
}
