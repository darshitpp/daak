use std::net::SocketAddr;

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
    let listener = tokio::net::TcpListener::bind(addr).await?;
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
