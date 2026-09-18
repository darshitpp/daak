use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};

use crate::error::{CoreError, Result};
use crate::manifest::now_ms;

pub const PRESENCE_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 67, 68);
pub const PRESENCE_PORT: u16 = 53535;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Online,
    Away,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Presence {
    pub device_id: [u8; 16],
    pub session_id: [u8; 16],
    pub name: String,
    pub state: PresenceState,
    pub seq: u64,
    pub sent_at_ms: u64,
}

impl Presence {
    pub fn to_cbor(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::ser::into_writer(self, &mut out).map_err(|e| CoreError::Cbor(e.to_string()))?;
        Ok(out)
    }

    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        ciborium::de::from_reader(bytes).map_err(|e| CoreError::Cbor(e.to_string()))
    }

    pub fn new(
        device_id: [u8; 16],
        session_id: [u8; 16],
        name: String,
        state: PresenceState,
    ) -> Self {
        Self {
            device_id,
            session_id,
            name,
            state,
            seq: 0,
            sent_at_ms: now_ms(),
        }
    }
}

pub struct PresenceSocket {
    socket: tokio::net::UdpSocket,
}

impl PresenceSocket {
    pub async fn bind() -> Result<Self> {
        let raw = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        raw.set_reuse_address(true)?;
        #[cfg(unix)]
        raw.set_reuse_port(true)?;
        let addr: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PRESENCE_PORT).into();
        raw.bind(&addr.into())?;
        raw.set_nonblocking(true)?;
        let std_socket: std::net::UdpSocket = raw.into();
        let socket = tokio::net::UdpSocket::from_std(std_socket)?;
        socket.join_multicast_v4(PRESENCE_GROUP, Ipv4Addr::UNSPECIFIED)?;
        socket.set_multicast_loop_v4(true)?;
        Ok(Self { socket })
    }

    pub async fn announce(&self, presence: &Presence) -> Result<()> {
        let bytes = presence.to_cbor()?;
        let dest: SocketAddr = SocketAddrV4::new(PRESENCE_GROUP, PRESENCE_PORT).into();
        self.socket.send_to(&bytes, dest).await?;
        Ok(())
    }

    pub async fn recv(&self) -> Result<(SocketAddr, Presence)> {
        let mut buf = [0u8; 2048];
        let (n, from) = self.socket.recv_from(&mut buf).await?;
        let p = Presence::from_cbor(&buf[..n])?;
        Ok((from, p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[ignore = "multicast send returns EHOSTUNREACH off loopback in this environment; verified manually on a real LAN"]
    #[tokio::test]
    async fn two_sockets_on_one_host_exchange_beacons() {
        let a = PresenceSocket::bind().await.unwrap();
        let b = PresenceSocket::bind().await.unwrap();
        let p = Presence {
            device_id: [9u8; 16],
            session_id: [0u8; 16],
            name: "Tester".into(),
            state: PresenceState::Online,
            seq: 1,
            sent_at_ms: 123,
        };
        a.announce(&p).await.unwrap();
        let (_from, got) = tokio::time::timeout(std::time::Duration::from_secs(2), b.recv())
            .await
            .expect("timed out")
            .unwrap();
        assert_eq!(got, p);
    }

    #[test]
    fn presence_cbor_roundtrip() {
        let p = Presence {
            device_id: [1u8; 16],
            session_id: [0u8; 16],
            name: "n".into(),
            state: PresenceState::Away,
            seq: 42,
            sent_at_ms: 7,
        };
        assert_eq!(Presence::from_cbor(&p.to_cbor().unwrap()).unwrap(), p);
    }

    #[test]
    fn presence_cbor_roundtrip_includes_session_id() {
        let p = Presence {
            device_id: [1u8; 16],
            session_id: [9u8; 16],
            name: "n".into(),
            state: PresenceState::Online,
            seq: 1,
            sent_at_ms: 7,
        };
        let back = Presence::from_cbor(&p.to_cbor().unwrap()).unwrap();
        assert_eq!(back.session_id, [9u8; 16]);
        assert_eq!(back, p);
    }
}
