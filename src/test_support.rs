//! Test-only helpers shared by the crate's test modules.
//!
//! Kept out of the production paths: every item here is `#[cfg(test)]` and
//! exists only so a test does not have to re-implement the same Windows
//! plumbing twice.

/// Absolute path to Windows PowerShell 5.1.
///
/// `powershell.exe` lives in `System32\WindowsPowerShell\v1.0\`, which is
/// NOT on the default PATH of a normal user session — a bare
/// `Command::new("powershell.exe")` therefore fails with "program not found"
/// on any machine that has not added it by hand. Resolve it from
/// `SystemRoot` instead, the same way `computer_control.rs` does.
#[cfg(windows)]
pub(crate) fn powershell() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}

/// Create a directory junction at `link` pointing at `target`.
///
/// Junctions need neither Developer Mode nor elevation, so they work on a
/// stock Windows CI runner. Unix uses a plain symlink.
pub(crate) fn dir_link(target: &std::path::Path, link: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a console flash would otherwise appear for every
        // junction a test creates.
        let output = std::process::Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:COFFEE_TEST_LINK -Target $env:COFFEE_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .env("COFFEE_TEST_LINK", link).env("COFFEE_TEST_TARGET", target)
            .creation_flags(0x0800_0000).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

/// Remove a link created by [`dir_link`]. A junction is a directory to
/// Windows and a symlink to Unix, so the removal call differs.
pub(crate) fn remove_dir_link(link: &std::path::Path) {
    #[cfg(unix)]
    std::fs::remove_file(link).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(link).unwrap();
}
