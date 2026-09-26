pub mod connection;
pub mod secure;
pub mod tcp;

pub use connection::{Connection, CONTROL_STREAM};
pub use secure::{
    complete_handshake, confirm_keys, open_secure, recv_secure_transfer, send_secure_transfer,
    FrameTransport, SecureConnection,
};

use std::net::IpAddr;

pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return v4.is_loopback() || v4.is_private() || v4.is_link_local();
            }
            let seg = v6.segments();
            (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::RecordType;
    use bytes::Bytes;

    #[test]
    fn is_local_accepts_private_and_loopback_ranges() {
        for ip in [
            "127.0.0.1",
            "192.168.1.5",
            "10.0.0.1",
            "172.16.0.1",
            "169.254.1.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:192.168.1.5",
        ] {
            assert!(is_local(ip.parse().unwrap()), "{ip} should be local");
        }
    }

    #[test]
    fn is_local_rejects_public_and_unspecified() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "2001:4860:4860::8888",
            "0.0.0.0",
            "::",
        ] {
            assert!(!is_local(ip.parse().unwrap()), "{ip} should not be local");
        }
    }

    #[tokio::test]
    async fn dial_refuses_non_local_address_without_connecting() {
        let err = tcp::dial("8.8.8.8:443".parse().unwrap()).await;
        assert!(matches!(err, Err(crate::error::CoreError::Protocol(_))));
    }

    #[tokio::test]
    async fn frames_cross_a_real_tcp_connection() {
        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();

        let server = tokio::spawn(async move {
            let (mut conn, _peer) = tcp::accept(&listener).await.unwrap();
            let f = conn.recv().await.unwrap().unwrap();
            assert_eq!(f.kind, RecordType::Manifest);
            assert_eq!(&f.body[..], b"payload");
            conn.send(CONTROL_STREAM, RecordType::Ack, Bytes::from_static(b"ok"))
                .await
                .unwrap();
        });

        let mut client = tcp::dial(addr).await.unwrap();
        client
            .send(
                CONTROL_STREAM,
                RecordType::Manifest,
                Bytes::from_static(b"payload"),
            )
            .await
            .unwrap();
        let ack = client.recv().await.unwrap().unwrap();
        assert_eq!(ack.kind, RecordType::Ack);
        assert_eq!(&ack.body[..], b"ok");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn large_body_survives_tcp_segmentation() {
        let (listener, addr) = tcp::bind("127.0.0.1:0".parse().unwrap()).await.unwrap();

        let body: Vec<u8> = (0..1_048_576u32).map(|i| (i % 251) as u8).collect();
        let expected = body.clone();

        let server = tokio::spawn(async move {
            let (mut conn, _peer) = tcp::accept(&listener).await.unwrap();
            let f = conn.recv().await.unwrap().unwrap();
            assert_eq!(f.kind, RecordType::Chunk);
            assert_eq!(f.stream_id, 7);
            assert_eq!(f.body.len(), 1_048_576);
            assert_eq!(&f.body[..], &expected[..]);
        });

        let mut client = tcp::dial(addr).await.unwrap();
        client
            .send(7, RecordType::Chunk, Bytes::from(body))
            .await
            .unwrap();
        server.await.unwrap();
    }
}
