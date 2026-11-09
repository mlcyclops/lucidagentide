// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1

//! What differs per OS: how the holder leaves the engine's process tree, how the agent's whole tree is owned
//! (a Windows job object that dies with the holder; a POSIX process group), where the endpoint lives.

use std::path::Path;
use std::process::{Child, Command};

/// The endpoint a client connects to: a named pipe on Windows, a Unix-domain socket in the holder's private
/// folder elsewhere. The Windows name carries a random part, so another account cannot pre-create it.
pub fn endpoint_for(dir: &Path, id: &str, nonce: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\lucid-holder-{id}-{nonce}")
    } else {
        let _ = nonce;
        dir.join(format!("{id}.sock")).to_string_lossy().into_owned()
    }
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

pub use imp::{end_tree, own_tree, prepare_child, spawn_detached};
