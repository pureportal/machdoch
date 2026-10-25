use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub struct StopReceipt {
    path: PathBuf,
    pending: PathBuf,
    file: File,
    environment_id: String,
}

impl StopReceipt {
    pub fn prepare(path: &str, environment_id: &str) -> Result<Self, String> {
        if !Path::new(path).is_absolute()
            || environment_id.len() != 36
            || !environment_id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
        {
            return Err("Invalid environment receipt configuration".to_string());
        }
        let path = PathBuf::from(path);
        if path.exists() {
            return Err("An environment receipt already exists".to_string());
        }
        let pending = path.with_extension("pending");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            path,
            pending,
            file,
            environment_id: environment_id.to_string(),
        })
    }

    pub fn stopped(
        mut self,
        reason: &str,
        child_pid: Option<u32>,
        exit_code: Option<i32>,
    ) -> Result<(), String> {
        let value = json!({
            "version":1, "environmentId":self.environment_id, "supervisorPid":std::process::id(),
            "childPid":child_pid, "reason":reason, "exitCode":exit_code, "processTreeStopped":true,
        });
        serde_json::to_writer(&mut self.file, &value).map_err(|error| error.to_string())?;
        self.file
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.file.sync_all().map_err(|error| error.to_string())?;
        fs::hard_link(&self.pending, &self.path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        File::open(self.path.parent().ok_or("Missing receipt directory")?)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        drop(self.file);
        fs::remove_file(&self.pending).map_err(|error| error.to_string())?;
        Ok(())
    }
}
