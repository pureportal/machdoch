use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};

const DOWNLOAD_FILE: ManifestFile = ManifestFile {
    path: "model.bin",
    byte_size: 4096,
    sha256: "ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7",
};
const DOWNLOAD_BYTES: &[u8] = &[0; 4096];

enum TransportScenario {
    Headers,
    Body,
    SlowBody,
    RestartHeaders,
    RestartBody,
    Complete { offset: usize },
}

struct TransportFixture {
    download_root: &'static str,
    requests: mpsc::UnboundedReceiver<String>,
    task: JoinHandle<()>,
}

impl TransportFixture {
    async fn new(scenario: TransportScenario) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let download_root =
            Box::leak(format!("http://{}", listener.local_addr().unwrap()).into_boxed_str());
        let (requests_tx, requests) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut stream = accept_request(&listener, &requests_tx).await;
            if matches!(
                scenario,
                TransportScenario::RestartHeaders | TransportScenario::RestartBody
            ) {
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
                drop(stream);
                stream = accept_request(&listener, &requests_tx).await;
            }
            match scenario {
                TransportScenario::Headers | TransportScenario::RestartHeaders => {}
                TransportScenario::Body | TransportScenario::RestartBody => {
                    send_headers(&mut stream, 0).await;
                    stream.write_all(&DOWNLOAD_BYTES[..256]).await.unwrap();
                }
                TransportScenario::SlowBody => {
                    send_headers(&mut stream, 0).await;
                    for chunk in DOWNLOAD_BYTES.chunks(64) {
                        if stream.write_all(chunk).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
                TransportScenario::Complete { offset } => {
                    send_headers(&mut stream, offset).await;
                    stream.write_all(&DOWNLOAD_BYTES[offset..]).await.unwrap();
                    return;
                }
            }
            std::future::pending::<()>().await;
            drop(stream);
        });
        Self {
            download_root,
            requests,
            task,
        }
    }

    fn manifest(&self) -> BuiltinModelManifest {
        BuiltinModelManifest {
            download_root: self.download_root,
            files: &[DOWNLOAD_FILE],
            ..FLUX_MANIFEST
        }
    }

    async fn request(&mut self) -> String {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .expect("request reached transport")
            .expect("transport request")
    }
}

impl Drop for TransportFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn accept_request(
    listener: &TcpListener,
    requests: &mpsc::UnboundedSender<String>,
) -> TcpStream {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"\r\n\r\n") {
        request.push(stream.read_u8().await.unwrap());
        assert!(request.len() < 8192);
    }
    requests.send(String::from_utf8(request).unwrap()).unwrap();
    stream
}

async fn send_headers(stream: &mut TcpStream, offset: usize) {
    let status = if offset == 0 {
        "200 OK"
    } else {
        "206 Partial Content"
    };
    let range = if offset == 0 {
        String::new()
    } else {
        format!("Content-Range: bytes {offset}-4095/4096\r\n")
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{range}Connection: close\r\n\r\n",
                DOWNLOAD_BYTES.len() - offset
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

impl Fixture {
    fn download(
        &self,
        job_id: &str,
        manifest: BuiltinModelManifest,
    ) -> JoinHandle<MediaResult<()>> {
        self.job_with_manifest(job_id, "downloading", &manifest);
        let connection = database::open(&self.paths).unwrap();
        connection
            .execute(
                "INSERT INTO media_model_install_files(job_id, path, sha256, byte_size, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![job_id, DOWNLOAD_FILE.path, DOWNLOAD_FILE.sha256, DOWNLOAD_FILE.byte_size as i64, database::now()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO media_model_installations(model_id, revision, status, manifest_digest, updated_at) VALUES (?1, ?2, 'downloading', ?3, ?4)",
                params![manifest.model_id, manifest.revision, manifest_digest(&manifest), database::now()],
            )
            .unwrap();
        self.run_download(job_id, manifest)
    }

    fn run_download(
        &self,
        job_id: &str,
        manifest: BuiltinModelManifest,
    ) -> JoinHandle<MediaResult<()>> {
        let paths = self.paths.clone();
        let job_id = job_id.to_string();
        let stage = self.root.join(&job_id);
        tokio::spawn(async move {
            let client = Client::builder().no_proxy().build().unwrap();
            let result = async {
                download_file(&client, &paths, &job_id, &stage, &manifest, DOWNLOAD_FILE).await?;
                activate(&paths, &job_id, &stage, &manifest)
            }
            .await;
            settle_execution(&paths, &job_id, result)
        })
    }

    fn partial(&self, job_id: &str) -> PathBuf {
        part_path(&self.root.join(job_id).join(DOWNLOAD_FILE.path))
    }

    async fn retained_bytes(&self, job_id: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if self
                    .partial(job_id)
                    .metadata()
                    .is_ok_and(|metadata| metadata.len() > 0)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("body bytes reached partial file");
    }

    async fn cancel_download(&self, job_id: &str, task: &mut JoinHandle<MediaResult<()>>) {
        assert_eq!(
            request_cancellation(&self.paths, job_id).unwrap().status,
            "canceling"
        );
        let accepted_at = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(1), &mut *task).await;
        if result.is_err() {
            task.abort();
            let _ = task.await;
            panic!("accepted cancellation did not settle within one second");
        }
        result.unwrap().unwrap().unwrap();
        assert_eq!(get_job(&self.paths, job_id).unwrap().status, "canceled");
        let elapsed = accepted_at.elapsed();
        eprintln!("{job_id} accepted-to-terminal={elapsed:?}");
        assert!(elapsed <= Duration::from_secs(1));
        assert_eq!(
            request_cancellation(&self.paths, job_id).unwrap().status,
            "canceled"
        );
        assert!(!self.root.join(job_id).join(DOWNLOAD_FILE.path).exists());
        assert!(!self
            .paths
            .models_root()
            .unwrap()
            .join("packages")
            .join(FLUX_MANIFEST.slug)
            .exists());
        let retained = self
            .partial(job_id)
            .metadata()
            .map_or(0, |metadata| metadata.len());
        let file_bytes: i64 = database::open(&self.paths)
            .unwrap()
            .query_row(
                "SELECT bytes_downloaded FROM media_model_install_files WHERE job_id = ?1 AND path = ?2",
                params![job_id, DOWNLOAD_FILE.path],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(file_bytes, retained as i64);
        assert_eq!(
            get_job(&self.paths, job_id).unwrap().bytes_downloaded,
            retained
        );
        let readiness: String = database::open(&self.paths)
            .unwrap()
            .query_row(
                "SELECT status FROM media_model_installations WHERE model_id = ?1",
                params![FLUX_MODEL_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(readiness, "not-installed");
    }
}

#[tokio::test]
async fn stalled_initial_and_resumed_headers_cancel_within_one_second() {
    for offset in [0, 256] {
        let fixture = Fixture::new();
        let mut transport = TransportFixture::new(TransportScenario::Headers).await;
        let job_id = "stalled-headers";
        if offset > 0 {
            fs::create_dir_all(fixture.root.join(job_id)).unwrap();
            fs::write(fixture.partial(job_id), &DOWNLOAD_BYTES[..offset]).unwrap();
        }
        let mut task = fixture.download(job_id, transport.manifest());
        let request = transport.request().await;
        assert_eq!(
            request.to_lowercase().contains("range: bytes=256-"),
            offset > 0
        );
        fixture.cancel_download(job_id, &mut task).await;
    }
}

#[tokio::test]
async fn stalled_body_cancels_and_explicit_resume_verifies_retained_bytes() {
    let fixture = Fixture::new();
    let mut transport = TransportFixture::new(TransportScenario::Body).await;
    let mut task = fixture.download("stalled-body", transport.manifest());
    transport.request().await;
    fixture.retained_bytes("stalled-body").await;
    fixture.cancel_download("stalled-body", &mut task).await;
    let retained = fs::read(fixture.partial("stalled-body")).unwrap();
    assert_eq!(retained, DOWNLOAD_BYTES[..retained.len()]);
    assert_eq!(retained.len(), 256);

    let mut resumed = TransportFixture::new(TransportScenario::Complete {
        offset: retained.len(),
    })
    .await;
    database::open(&fixture.paths)
        .unwrap()
        .execute(
            "UPDATE media_model_install_jobs SET status = 'queued', cancel_requested = 0, completed_at = NULL WHERE id = ?1",
            params!["stalled-body"],
        )
        .unwrap();
    let task = fixture.run_download("stalled-body", resumed.manifest());
    assert!(resumed
        .request()
        .await
        .to_lowercase()
        .contains("range: bytes=256-"));
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let installed_file = fixture
        .paths
        .models_root()
        .unwrap()
        .join("packages")
        .join(FLUX_MANIFEST.slug)
        .join("revisions")
        .join(FLUX_MANIFEST.revision)
        .join(DOWNLOAD_FILE.path);
    assert_eq!(fs::read(installed_file).unwrap(), DOWNLOAD_BYTES);
    assert!(!fixture.partial("stalled-body").exists());
    assert_eq!(
        get_job(&fixture.paths, "stalled-body")
            .unwrap()
            .files_completed,
        1
    );
    assert!(!cancellation_requested(&fixture.paths, "stalled-body").unwrap());
    assert_eq!(
        get_job(&fixture.paths, "stalled-body").unwrap().status,
        "installed"
    );
}

#[tokio::test]
async fn restarted_headers_and_body_cancel_with_consistent_progress() {
    for scenario in [
        TransportScenario::RestartHeaders,
        TransportScenario::RestartBody,
    ] {
        let restarted_body = matches!(scenario, TransportScenario::RestartBody);
        let fixture = Fixture::new();
        let mut transport = TransportFixture::new(scenario).await;
        let job_id = "restarted-request";
        fs::create_dir_all(fixture.root.join(job_id)).unwrap();
        fs::write(fixture.partial(job_id), &DOWNLOAD_BYTES[..512]).unwrap();
        let mut task = fixture.download(job_id, transport.manifest());
        assert!(transport
            .request()
            .await
            .to_lowercase()
            .contains("range: bytes=512-"));
        assert!(!transport.request().await.to_lowercase().contains("range:"));
        if restarted_body {
            tokio::time::timeout(Duration::from_secs(5), async {
                while fixture.partial(job_id).metadata().unwrap().len() != 256 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("restarted body replaced retained bytes");
        }
        fixture.cancel_download(job_id, &mut task).await;
        assert_eq!(
            fixture.partial(job_id).metadata().unwrap().len(),
            if restarted_body { 256 } else { 512 }
        );
    }
}

#[tokio::test]
async fn slow_subthreshold_body_cancels_without_affecting_successful_download() {
    let fixture = Fixture::new();
    let mut slow = TransportFixture::new(TransportScenario::SlowBody).await;
    let mut task = fixture.download("slow-body", slow.manifest());
    slow.request().await;
    fixture.retained_bytes("slow-body").await;
    let mut success = TransportFixture::new(TransportScenario::Complete { offset: 0 }).await;
    let success_manifest = BuiltinModelManifest {
        model_id: BIREFNET_MANIFEST.model_id,
        slug: BIREFNET_MANIFEST.slug,
        ..success.manifest()
    };
    let success_task = fixture.download("successful", success_manifest);
    success.request().await;
    fixture.cancel_download("slow-body", &mut task).await;
    tokio::time::timeout(Duration::from_secs(5), success_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let job = get_job(&fixture.paths, "successful").unwrap();
    assert_eq!(job.status, "installed");
    assert_eq!(job.files_completed, 1);
    assert_eq!(job.bytes_downloaded, DOWNLOAD_FILE.byte_size);
    assert!(!cancellation_requested(&fixture.paths, "successful").unwrap());
    assert_eq!(
        request_cancellation(&fixture.paths, "successful")
            .unwrap()
            .status,
        "installed"
    );
    assert_eq!(
        fs::read(
            fixture
                .paths
                .models_root()
                .unwrap()
                .join("packages")
                .join(BIREFNET_MANIFEST.slug)
                .join("revisions")
                .join(FLUX_MANIFEST.revision)
                .join(DOWNLOAD_FILE.path)
        )
        .unwrap(),
        DOWNLOAD_BYTES
    );
    assert!(fs::metadata(fixture.partial("slow-body")).unwrap().len() < PROGRESS_WRITE_BYTES);
}
