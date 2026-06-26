use std::{
    os::fd::{FromRawFd, IntoRawFd},
    path::{Path, PathBuf},
};

use nix::{
    fcntl::OFlag,
    pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
    sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg},
};
use tokio::io::AsyncWriteExt;

pub struct PtyHarness {
    pub slave_path: PathBuf,
    master: tokio::fs::File,
}

impl PtyHarness {
    pub fn open() -> Self {
        let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY).expect("posix_openpt");
        grantpt(&master).expect("grantpt");
        unlockpt(&master).expect("unlockpt");
        let slave_path = PathBuf::from(ptsname_r(&master).expect("ptsname"));
        configure_slave_raw(&slave_path);
        let fd = master.into_raw_fd();
        // SAFETY: fd is freshly taken from `master` and transferred exactly once.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        Self {
            slave_path,
            master: tokio::fs::File::from_std(file),
        }
    }

    pub fn spawn_scanner_writer(mut self, bytes: &'static [u8]) {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = self.master.write_all(bytes).await;
            let _ = self.master.flush().await;
        });
    }

    pub fn spawn_lower_controller_heartbeat(mut self) {
        tokio::spawn(async move {
            loop {
                let write_result = self
                    .master
                    .write_all(&[vending_core::serial::FRAME_HEAD, 0xAA])
                    .await;
                if write_result.is_err() {
                    break;
                }
                if self.master.flush().await.is_err() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });
    }

    pub async fn write(&mut self, bytes: &[u8]) {
        self.master.write_all(bytes).await.expect("write pty bytes");
        self.master.flush().await.expect("flush pty bytes");
    }
}

fn configure_slave_raw(slave_path: &Path) {
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(slave_path)
        .expect("open pty slave");
    let mut termios = tcgetattr(&slave).expect("tcgetattr pty slave");
    cfmakeraw(&mut termios);
    tcsetattr(&slave, SetArg::TCSANOW, &termios).expect("tcsetattr pty slave raw");
}
