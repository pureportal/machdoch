use machdoch_process::SupervisedChildSpawnError;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    ops::{Deref, DerefMut},
    os::{
        fd::AsRawFd,
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};

pub struct Configuration {
    root: PathBuf,
    environment_id: String,
}
impl Configuration {
    pub fn new(environment_id: &str, root: Option<&str>) -> Result<Self, String> {
        let root = Path::new(root.ok_or("Configure a delegated cgroup v2 root")?);
        if !root.is_absolute()
            || root
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("Use an absolute delegated cgroup path".to_string());
        }
        let canonical = fs::canonicalize(root).map_err(|error| error.to_string())?;
        if root != canonical {
            return Err(
                "The cgroup root must be canonical and contain no symbolic links".to_string(),
            );
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(root)
            .map_err(|error| error.to_string())?;
        let mut status = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(directory.as_raw_fd(), status.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        if unsafe { status.assume_init() }.f_type as u64 != libc::CGROUP2_SUPER_MAGIC as u64 {
            return Err("The delegated root is not a cgroup v2 filesystem".to_string());
        }
        let controllers = fs::read_to_string(root.join("cgroup.subtree_control"))
            .map_err(|error| error.to_string())?;
        if ["cpu", "memory", "pids"].iter().any(|controller| {
            !controllers
                .split_whitespace()
                .any(|value| value == *controller)
        }) {
            return Err("Delegate and enable the cpu, memory and pids controllers before starting the runner".to_string());
        }
        if !fs::read_to_string(root.join("cgroup.procs"))
            .map_err(|error| error.to_string())?
            .trim()
            .is_empty()
        {
            return Err("Keep runner processes outside the delegated VM cgroup root".to_string());
        }
        Ok(Self {
            root: canonical,
            environment_id: environment_id.to_string(),
        })
    }
}

struct ProcessGroup {
    path: PathBuf,
    removed: bool,
}
impl ProcessGroup {
    fn create(configuration: &Configuration, memory: usize) -> io::Result<Self> {
        let path = configuration.root.join(&configuration.environment_id);
        fs::create_dir(&path)?;
        let mut group = Self {
            path,
            removed: false,
        };
        let result = (|| {
            for (file, value) in [
                ("memory.max", memory.to_string()),
                ("memory.swap.max", "0".to_string()),
                ("memory.oom.group", "1".to_string()),
                ("pids.max", "128".to_string()),
                ("cpu.max", "200000 100000".to_string()),
            ] {
                group.write(file, value.as_bytes())?;
            }
            OpenOptions::new()
                .write(true)
                .open(group.path.join("cgroup.kill"))?;
            Ok(())
        })();
        if let Err(error) = result {
            group.remove()?;
            return Err(error);
        }
        Ok(group)
    }
    fn write(&self, name: &str, value: &[u8]) -> io::Result<()> {
        OpenOptions::new()
            .write(true)
            .open(self.path.join(name))?
            .write_all(value)
    }
    fn populated(&self) -> io::Result<bool> {
        let events = fs::read_to_string(self.path.join("cgroup.events"))?;
        match events
            .lines()
            .find_map(|line| line.strip_prefix("populated "))
        {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            _ => Err(io::Error::other("Cgroup population is unavailable")),
        }
    }
    fn remove(&mut self) -> io::Result<()> {
        fs::remove_dir(&self.path)?;
        self.removed = true;
        Ok(())
    }
}

pub struct IsolatedChild {
    child: Child,
    group: ProcessGroup,
}
impl Deref for IsolatedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl DerefMut for IsolatedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for IsolatedChild {
    fn drop(&mut self) {
        if !self.group.removed {
            let _ = stop(self);
        }
    }
}

pub fn spawn(
    command: &mut Command,
    memory: usize,
    configuration: &Configuration,
) -> Result<IsolatedChild, SupervisedChildSpawnError> {
    let mut group =
        ProcessGroup::create(configuration, memory).map_err(SupervisedChildSpawnError::Spawn)?;
    let membership = OpenOptions::new()
        .write(true)
        .open(group.path.join("cgroup.procs"));
    let membership = match membership {
        Ok(file) => file,
        Err(error) => {
            group
                .remove()
                .map_err(|error| SupervisedChildSpawnError::Isolation(error.to_string()))?;
            return Err(SupervisedChildSpawnError::Spawn(error));
        }
    };
    let parent = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 || libc::getppid() != parent
            {
                return Err(io::Error::from_raw_os_error(libc::ECANCELED));
            }
            if libc::write(membership.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            let core = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    match command.spawn() {
        Ok(child) => Ok(IsolatedChild { child, group }),
        Err(error) => {
            group
                .remove()
                .map_err(|error| SupervisedChildSpawnError::Isolation(error.to_string()))?;
            Err(SupervisedChildSpawnError::Spawn(error))
        }
    }
}

pub fn stop(process: &mut IsolatedChild) -> Result<ExitStatus, String> {
    if process.group.removed {
        return process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .ok_or("A removed cgroup still has a running child".to_string());
    }
    process
        .group
        .write("cgroup.kill", b"1")
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let status = process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?;
        if !process
            .group
            .populated()
            .map_err(|error| error.to_string())?
        {
            if let Some(status) = status {
                process.group.remove().map_err(|error| error.to_string())?;
                return Ok(status);
            }
        }
        if Instant::now() >= deadline {
            return Err(
                "The VM cgroup still contains processes; termination is unconfirmed".to_string(),
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}
