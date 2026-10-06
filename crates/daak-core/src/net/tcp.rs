use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use crate::error::{CoreError, Result};
use crate::framing::DEFAULT_MAX_FRAME;

use super::connection::Connection;
use super::is_local;

pub async fn dial(addr: SocketAddr) -> Result<Connection<tokio::net::TcpStream>> {
    if !is_local(addr.ip()) {
        return Err(CoreError::Protocol(format!(
            "refusing non-local address {addr}"
        )));
    }
    let stream = tokio::net::TcpStream::connect(addr).await?;
    stream.set_nodelay(true)?;
    Ok(Connection::new(stream, DEFAULT_MAX_FRAME))
}

pub async fn bind(addr: SocketAddr) -> Result<(tokio::net::TcpListener, SocketAddr)> {
    // A WILDCARD bind means "every interface", and the caller means it: every
    // shipped entry point requests `0.0.0.0:{port}` (daakd, daak-ffi, daak-cli)
    // and then hands `local_addr().port()` to the mDNS advertiser. The
    // advertiser's AUTO form publishes EVERY interface address the host has --
    // on the measured host `192.168.0.226` AND `fe80::1%lo0` AND `::1` -- so a
    // browsing peer's `pick_addr` may dial any of them.
    //
    // An IPv4 wildcard has no IPv6 socket at all, so half of those published
    // addresses are undialable. Measured: three of four discovery runs returned
    // `[fe80::1]:45940` and the dial failed with `No route to host`, while the
    // same peer answered on `192.168.0.226:45940`. The send then died at
    // "peer is not paired" (engine.rs:476) after the full retry budget.
    //
    // So bind the IPv6 wildcard instead, with IPV6_V6ONLY OFF. One socket then
    // listens on both families and every address the advertiser can publish is
    // reachable (measured: all of `::1`, `fe80::1%lo0`, `fe80::...%en0`,
    // `127.0.0.1` and `192.168.0.226` connect). An EXPLICIT address is left
    // exactly as asked: a caller that names one interface means that one, and
    // `127.0.0.1:0` is how every loopback test gets an IPv4-only socket.
    //
    // `local_addr` then reports `[::]:port`, and the port is all any caller
    // uses (`advertise_ip` maps the unspecified address back to `None`, so the
    // record stays in its AUTO form).
    let requested = if addr.ip().is_unspecified() {
        match addr {
            SocketAddr::V4(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), addr.port()),
            v6 => v6,
        }
    } else {
        addr
    };
    let listener = tokio::net::TcpListener::bind(requested).await?;
    let local = listener.local_addr()?;
    Ok((listener, local))
}

pub async fn accept(
    listener: &tokio::net::TcpListener,
) -> Result<(Connection<tokio::net::TcpStream>, SocketAddr)> {
    let (stream, peer) = listener.accept().await?;
    if !is_local(peer.ip()) {
        drop(stream);
        return Err(CoreError::Protocol(format!(
            "refusing non-local peer {peer}"
        )));
    }
    stream.set_nodelay(true)?;
    Ok((Connection::new(stream, DEFAULT_MAX_FRAME), peer))
}
