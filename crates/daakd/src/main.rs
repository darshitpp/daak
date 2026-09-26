use daak_ipc::socket_path;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    daakd::serve(&socket_path()).await
}
