// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! What differs per OS: how the holder leaves the engine's process tree, how the agent's whole tree is owned
//! (a Windows job object that dies with the holder; a POSIX process group), where the endpoint lives.

use std::path::Path;
use std::process::{Child, Command};

/// The endpoint a client connects to: a named pipe on Windows, a Unix-domain socket in the holder's private
/// folder elsewhere. The Windows name carries a random part, so another account cannot pre-create it.
#[cfg(windows)]
pub fn endpoint_for(_dir: &Path, id: &str, nonce: &str) -> std::io::Result<String> {
    Ok(format!(r"\\.\pipe\lucid-holder-{id}-{nonce}"))
}

/// A Unix socket path longer than the kernel's `sun_path` (104 bytes on macOS, 108 on Linux, with its NUL) cannot be
/// bound, and a data root under macOS's per-user temp folder is already most of that. Such a socket goes in
/// `/tmp/lucid-holder-<uid>/` instead, a folder this account owns with mode 0700 (anything else is refused).
#[cfg(unix)]
pub fn endpoint_for(dir: &Path, id: &str, _nonce: &str) -> std::io::Result<String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    const SUN_PATH_MAX: usize = 100;
    let beside = dir.join(format!("{id}.sock"));
    if beside.as_os_str().len() <= SUN_PATH_MAX {
        return Ok(beside.to_string_lossy().into_owned());
    }
    let uid = unsafe { libc::getuid() };
    let short = Path::new("/tmp").join(format!("lucid-holder-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&short) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(&short)?;
    if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o777 != 0o700 {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, format!("{} is not a 0700 folder of this account", short.display())));
    }
    Ok(short.join(format!("{id}.sock")).to_string_lossy().into_owned())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
    };
    use windows_sys::Win32::System::IO::CancelIoEx;
    use interprocess::local_socket::{ListenerOptions, Stream};
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use parking_lot::{Condvar, Mutex};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// The pipe admits its owner (the account that runs the engine and this holder) and SYSTEM, nobody else
    /// (LH-04: the default DACL lets every account open it for reading and pin an instance).
    pub fn private_endpoint(opts: ListenerOptions<'_>) -> std::io::Result<ListenerOptions<'_>> {
        let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)(A;;GA;;;SY)").map_err(std::io::Error::other)?;
        Ok(opts.security_descriptor(SecurityDescriptor::deserialize(&sddl)?))
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Phase { Armed, Fired, Done }

    /// A watchdog over one pipe. Windows pipes ignore receive timeouts (interprocess reads them with overlapped I/O)
    /// and have no shutdown, so once it fires (its time ran out, or `fire`) it cancels the pipe's pending I/O, and
    /// keeps canceling until its owner marks it Done (a read or write that had just returned and is followed by
    /// another is canceled too). It holds only the raw handle and never touches it after Done, so its owner must
    /// mark it Done (disarm or drop) before the stream closes.
    struct Watch {
        phase: Mutex<Phase>,
        wake: Condvar,
    }

    impl Watch {
        /// Fires `after` from now, or only on `fire` when `after` is None.
        fn start(stream: &Stream, after: Option<Duration>) -> Arc<Watch> {
            use std::os::windows::io::{AsHandle, AsRawHandle};
            let watch = Arc::new(Watch { phase: Mutex::new(Phase::Armed), wake: Condvar::new() });
            #[allow(unreachable_patterns)]
            let pipe = match stream {
                Stream::NamedPipe(p) => p.as_handle().as_raw_handle() as usize, // a HANDLE does not cross threads by itself
                _ => return watch,
            };
            let w = watch.clone();
            std::thread::spawn(move || {
                let until = after.map(|a| Instant::now() + a);
                {
                    let mut p = w.phase.lock();
                    while *p == Phase::Armed {
                        match until {
                            Some(t) => {
                                if w.wake.wait_until(&mut p, t).timed_out() {
                                    break;
                                }
                            }
                            None => w.wake.wait(&mut p),
                        }
                    }
                }
                loop {
                    {
                        let mut p = w.phase.lock();
                        if *p == Phase::Done {
                            break;
                        }
                        *p = Phase::Fired;
                        unsafe { CancelIoEx(pipe as HANDLE, std::ptr::null()) };
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
            watch
        }

        fn fire(&self) {
            let mut p = self.phase.lock();
            if *p == Phase::Armed {
                *p = Phase::Fired;
                self.wake.notify_all();
            }
        }

        /// Stop for good. False when it had fired first.
        fn done(&self) -> bool {
            let mut p = self.phase.lock();
            let in_time = *p == Phase::Armed;
            *p = Phase::Done;
            self.wake.notify_all();
            in_time
        }
    }

    /// A receive deadline on one connection (the watchdog above, on a timer).
    pub struct Deadline(Arc<Watch>);

    impl Deadline {
        pub fn arm(stream: &Stream, after: Duration) -> Deadline {
            Deadline(Watch::start(stream, Some(after)))
        }

        /// Stop the watchdog. False when the time ran out first (the caller must give up the connection).
        pub fn disarm(&self) -> bool {
            self.0.done()
        }
    }

    impl Drop for Deadline {
        fn drop(&mut self) {
            self.0.done();
        }
    }

    /// Ends both halves of one connection on demand (the watchdog above, fired by `cut`): every pending and later
    /// read or write on it fails, so the threads serving it let go and the client sees the pipe close. Must be
    /// dropped before the stream (it holds only the raw handle).
    pub struct Cutter(Arc<Watch>);

    impl Cutter {
        pub fn new(stream: &Stream) -> Cutter {
            Cutter(Watch::start(stream, None))
        }

        pub fn cut(&self) {
            self.0.fire();
        }
    }

    impl Drop for Cutter {
        fn drop(&mut self) {
            self.0.done();
        }
    }

    /// Start `serve` out of the engine's reach: a new process group, out of the launcher's job when the job
    /// allows it (the engine's runtime puts its children in a kill-on-close job), and with a console that is
    /// never shown, which the agent inherits (ADR-0415: the agent's own children must not flash windows).
    pub fn spawn_detached(cmd: &mut Command) -> std::io::Result<Child> {
        let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        match cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB).spawn() {
            Ok(c) => Ok(c),
            // The job refuses breakaway: the holder still leaves the engine's parent chain (its parent, the
            // launcher, exits at once), so a tree kill of the engine never walks to it.
            Err(_) => cmd.creation_flags(base).spawn(),
        }
    }

    /// The holder joins a job of its own that kills everything in it when its last handle closes: the agent
    /// and every process it starts inherit it, so the agent's tree can never outlive the holder, and ending the
    /// holder ends the tree (no pid walking).
    pub fn own_tree() -> std::io::Result<()> {
        unsafe {
            let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                let e = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(e);
            }
            // Deliberately never closed: the handle closes when the holder exits, and that ends the tree.
        }
        Ok(())
    }

    pub fn prepare_child(_cmd: &mut Command) {}

    /// The agent's exit code (-1 when it has none). Windows sends no group kill by id, so the handle may be waited on
    /// and closed as usual.
    pub fn wait_unreaped(child: &mut Child) -> i32 {
        child.wait().ok().and_then(|s| s.code()).unwrap_or(-1)
    }

    /// Nothing to do here: ending the holder ends the job, and with it the agent's whole tree.
    pub fn end_tree(_pid: u32, _gone: &dyn Fn() -> bool) {}
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::time::{Duration, Instant};

    /// A new session: the engine's process group and terminal hang-ups never reach the holder.
    pub fn spawn_detached(cmd: &mut Command) -> std::io::Result<Child> {
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
    }

    pub fn own_tree() -> std::io::Result<()> { Ok(()) }

    /// The socket already lives in a folder only this account can enter.
    pub fn private_endpoint(opts: interprocess::local_socket::ListenerOptions<'_>) -> std::io::Result<interprocess::local_socket::ListenerOptions<'_>> {
        Ok(opts)
    }

    /// Unix sockets honor the receive timeout set on the stream, so no watchdog is needed.
    pub struct Deadline;

    impl Deadline {
        pub fn arm(_stream: &interprocess::local_socket::Stream, _after: Duration) -> Deadline { Deadline }
        pub fn disarm(&self) -> bool { true }
    }

    /// Ends both halves of one connection on demand: a socket shutdown through a second descriptor of the same
    /// socket, so a blocked read sees the end of the stream, a write fails, and the client sees the close.
    pub struct Cutter(Option<std::os::unix::net::UnixStream>);

    impl Cutter {
        pub fn new(stream: &interprocess::local_socket::Stream) -> Cutter {
            use std::os::fd::AsFd;
            #[allow(unreachable_patterns)]
            let dup = match stream {
                interprocess::local_socket::Stream::UdSocket(s) => s.as_fd().try_clone_to_owned().ok().map(std::os::unix::net::UnixStream::from),
                _ => None,
            };
            Cutter(dup)
        }

        pub fn cut(&self) {
            if let Some(s) = &self.0 {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    /// The agent leads a process group of its own, so its whole tree can be signaled at once.
    pub fn prepare_child(cmd: &mut Command) {
        cmd.process_group(0);
    }

    /// LH-07: wait for the agent to exit WITHOUT reaping it (`waitid` with WNOWAIT). While it is an unreaped zombie
    /// its pid is not handed out again, so the process group id `end_tree` signals still names the agent's group and
    /// never a stranger's. The zombie is reaped by init once the holder exits. Returns the exit code, or -1 for a
    /// signal or a failed wait.
    pub fn wait_unreaped(child: &mut Child) -> i32 {
        let pid = child.id() as libc::id_t;
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let r = unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) };
            if r == 0 {
                return if info.si_code == libc::CLD_EXITED { unsafe { info.si_status() } } else { -1 };
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return -1;
            }
        }
    }

    /// SIGTERM to the agent's group, then SIGKILL to the group once the agent exited or 5 seconds passed
    /// (anything it left behind in its group goes too). `gone` reports the agent's own exit.
    pub fn end_tree(pid: u32, gone: &dyn Fn() -> bool) {
        let pgid = pid as i32;
        unsafe { libc::killpg(pgid, libc::SIGTERM) };
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until && !gone() {
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
}

pub use imp::{end_tree, own_tree, prepare_child, private_endpoint, spawn_detached, wait_unreaped, Cutter, Deadline};

#[cfg(test)]
mod cut_tests {
    use super::Cutter;
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions, Stream};
    use std::io::Read;
    use std::sync::Arc;
    use std::time::Duration;

    fn ended(r: std::io::Result<usize>) -> bool {
        r.map(|n| n == 0).unwrap_or(true)
    }

    #[test]
    fn a_cut_ends_a_blocked_read_and_the_client_sees_the_close() {
        let path = if cfg!(windows) {
            format!(r"\\.\pipe\lucid-holder-cut-test-{}", std::process::id())
        } else {
            std::env::temp_dir().join(format!("lucid-holder-cut-{}.sock", std::process::id())).to_string_lossy().into_owned()
        };
        if !cfg!(windows) {
            let _ = std::fs::remove_file(&path);
        }
        let listener = ListenerOptions::new().name(path.as_str().to_fs_name::<GenericFilePath>().unwrap()).create_sync().unwrap();
        let client = Stream::connect(path.as_str().to_fs_name::<GenericFilePath>().unwrap()).unwrap();
        let server = Arc::new(listener.accept().unwrap());
        let cut = Cutter::new(&server);
        let reader = {
            let s = server.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8];
                let mut r = &*s;
                ended(r.read(&mut buf))
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(!reader.is_finished(), "nothing was sent: the read waits");
        cut.cut();
        assert!(reader.join().unwrap(), "the cut ended the blocked read");
        drop(cut); // before the stream: the Windows watchdog holds only its raw handle
        drop(server);
        let mut buf = [0u8; 8];
        let mut c = &client;
        assert!(ended(c.read(&mut buf)), "the client sees the end of the connection");
        if !cfg!(windows) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_agent_exit_is_seen_without_freeing_its_pid() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exit 7"]);
        prepare_child(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id() as i32;
        assert_eq!(wait_unreaped(&mut child), 7);
        // Still an unreaped zombie: the pid (and the group id it leads) cannot belong to anyone else yet.
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        child.wait().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "reaped, the pid is free");
    }

    #[test]
    fn a_signalled_agent_reports_no_exit_code() {
        let mut child = Command::new("sh").args(["-c", "kill -9 $$"]).spawn().unwrap();
        assert_eq!(wait_unreaped(&mut child), -1);
        child.wait().unwrap();
    }
}
