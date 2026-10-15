use super::*;
use crate::{app_update::AppUpdateSession, cooperative_file_lock::acquire_cooperative_file_lock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::UpdaterExt as _;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use tokio_util::sync::CancellationToken;

fn fixture() -> (tauri::App<MockRuntime>, Webview<MockRuntime>) {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": "invalid-test-key",
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true,
        }),
    );
    let lock_path = std::env::temp_dir().join(format!(
        "machdoch-update-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppUpdateState(std::sync::Mutex::new(Some(
            AppUpdateSession {
                _lock: acquire_cooperative_file_lock(&lock_path).unwrap(),
                cancellation: CancellationToken::new(),
                downloading: false,
                downloaded: None,
            },
        ))))
        .build(context)
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "update-test",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .build()
    .unwrap();
    let webview: &Webview<MockRuntime> = window.as_ref();
    (app, webview.clone())
}

async fn read_request(stream: &mut tokio::net::TcpStream) {
    let mut request = Vec::new();
    while !request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
        let mut buffer = [0; 1024];
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(count > 0 && request.len() < 8192);
        request.extend_from_slice(&buffer[..count]);
    }
}

async fn update_fixture(webview: &Webview<MockRuntime>, listener: &TcpListener) -> ResourceId {
    let address = listener.local_addr().unwrap();
    let manifest = serde_json::json!({
        "version": "99.0.0",
        "platforms": { "test": { "url": format!("http://{address}/download"), "signature": "invalid-test-signature" } },
    }).to_string();
    let serve_manifest = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()).as_bytes()).await.unwrap();
    };
    let updater = webview
        .updater_builder()
        .endpoints(vec![format!("http://{address}/latest.json")
            .parse()
            .unwrap()])
        .unwrap()
        .target("test")
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let (update, _) = tokio::join!(updater.check(), serve_manifest);
    webview.resources_table().add(update.unwrap().unwrap())
}

#[tokio::test]
async fn cancellation_aborts_a_stalled_http_download_and_prevents_installation() {
    let (_app, webview) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rid = update_fixture(&webview, &listener).await;
    let (started, ready) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\npartial")
            .await
            .unwrap();
        started.send(()).unwrap();
        let mut buffer = [0; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0) | Err(_)));
    });
    let cancel = async {
        ready.await.unwrap();
        cancel_app_update_download(webview.clone()).unwrap();
    };
    let (result, _) = tokio::join!(
        download_app_update(webview.clone(), rid, Channel::new(|_| Ok(()))),
        cancel
    );
    assert!(!result.unwrap());
    assert!(webview
        .state::<AppUpdateState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .downloaded
        .is_none());
    assert_eq!(
        install_app_update(webview, rid).await.unwrap_err(),
        "The update download was canceled."
    );
    server.await.unwrap();
}

#[tokio::test]
async fn completed_downloads_still_require_a_valid_signature() {
    let (_app, webview) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let rid = update_fixture(&webview, &listener).await;
    let serve_download = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ninvalid")
            .await
            .unwrap();
    };
    let (result, _) = tokio::join!(
        download_app_update(webview.clone(), rid, Channel::new(|_| Ok(()))),
        serve_download
    );
    assert!(result.is_err());
    assert!(webview
        .state::<AppUpdateState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .downloaded
        .is_none());
    assert_eq!(
        install_app_update(webview, rid).await.unwrap_err(),
        "Download the update before installing."
    );
}
