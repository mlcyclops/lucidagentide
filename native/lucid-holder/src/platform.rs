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
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::time::Duration;

    /// The pipe admits its owner (the account that runs the engine and this holder) and SYSTEM, nobody else
    /// (LH-04: the default DACL lets every account open it for reading and pin an instance).
    pub fn private_endpoint(opts: ListenerOptions<'_>) -> std::io::Result<ListenerOptions<'_>> {
        let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)(A;;GA;;;SY)").map_err(std::io::Error::other)?;
        Ok(opts.security_descriptor(SecurityDescriptor::deserialize(&sddl)?))
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Phase { Armed, Fired, Done }

    /// A receive deadline on one connection. Windows pipes ignore receive timeouts (interprocess reads them with
    /// overlapped I/O), so a watchdog cancels the pipe's pending I/O once the time is up, and keeps cancelling until
    /// the reader lets go of the deadline (a read that had just returned and is followed by another is cancelled
    /// too). The caller must disarm or drop the deadline before the stream closes: the watchdog holds only the raw
    /// handle, and never touches it after Done.
    pub struct Deadline(Arc<Mutex<Phase>>);

    impl Deadline {
        pub fn arm(stream: &Stream, after: Duration) -> Deadline {
            use std::os::windows::io::{AsHandle, AsRawHandle};
            let phase = Arc::new(Mutex::new(Phase::Armed));
            #[allow(unreachable_patterns)]
            let pipe = match stream {
                Stream::NamedPipe(p) => p.as_handle().as_raw_handle() as usize, // a HANDLE does not cross threads by itself
                _ => return Deadline(phase),
            };
            let watch = phase.clone();
            std::thread::spawn(move || {
                std::thread::sleep(after);
                loop {
                    {
                        let mut p = watch.lock();
                        if *p == Phase::Done {
                            break;
                        }
                        *p = Phase::Fired;
                        unsafe { CancelIoEx(pipe as HANDLE, std::ptr::null()) };
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            });
            Deadline(phase)
        }

        /// Stop the watchdog. False when the time ran out first (the caller must give up the connection).
        pub fn disarm(&self) -> bool {
            let mut p = self.0.lock();
            let in_time = *p == Phase::Armed;
            *p = Phase::Done;
            in_time
        }
    }

    impl Drop for Deadline {
        fn drop(&mut self) {
            *self.0.lock() = Phase::Done;
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

    /// Unix sockets honour the receive timeout set on the stream, so no watchdog is needed.
    pub struct Deadline;

    impl Deadline {
        pub fn arm(_stream: &interprocess::local_socket::Stream, _after: Duration) -> Deadline { Deadline }
        pub fn disarm(&self) -> bool { true }
    }

    /// The agent leads a process group of its own, so its whole tree can be signalled at once.
    pub fn prepare_child(cmd: &mut Command) {
        cmd.process_group(0);
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

pub use imp::{end_tree, own_tree, prepare_child, private_endpoint, spawn_detached, Deadline};
