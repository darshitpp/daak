use std::process::Command;

#[test]
fn name_subcommand_prints_hostname() {
    let out = Command::new(env!("CARGO_BIN_EXE_daak"))
        .arg("name")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(!String::from_utf8(out.stdout).unwrap().trim().is_empty());
}
