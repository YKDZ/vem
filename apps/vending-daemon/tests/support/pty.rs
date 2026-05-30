use std::{
    os::fd::{FromRawFd, IntoRawFd},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use nix::{
    fcntl::OFlag,
    pty::{grantpt, posix_openpt, ptsname_r, unlockpt},
    sys::termios::{cfmakeraw, tcgetattr, tcsetattr, SetArg},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

    pub fn spawn_successful_lower_controller(mut self) -> Arc<AtomicUsize> {
        let count = Arc::new(AtomicUsize::new(0));
        let count_for_task = count.clone();
        tokio::spawn(async move {
            loop {
                let mut frame = [0_u8; 4];
                if self.master.read_exact(&mut frame).await.is_err() {
                    break;
                }
                count_for_task.fetch_add(1, Ordering::SeqCst);
                let _ = self.master.write_all(&[0x55, 0x00]).await;
                let _ = self.master.write_all(&[0x55, 0xF1]).await;
                let _ = self.master.flush().await;
            }
        });
        count
    }

    pub fn spawn_scanner_writer(mut self, bytes: &'static [u8]) {
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = self.master.write_all(bytes).await;
            let _ = self.master.flush().await;
        });
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
