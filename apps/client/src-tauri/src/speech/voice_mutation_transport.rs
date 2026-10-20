pub async fn execute(client:&reqwest::Client,endpoint:&str,id:&str,operation:&str,changes:&serde_json::Value,key:&str)->Result<u16,()> {
    let url=format!("{endpoint}/model/{id}");
    let request=match operation{
        "delete"=>client.delete(url),
        "update"=>{
            let mut body=serde_json::Map::new();
            if let Some(name)=changes.get("name"){body.insert("title".into(),name.clone());}
            if let Some(visibility)=changes.get("visibility"){body.insert("visibility".into(),visibility.clone());}
            client.patch(url).json(&body)
        },
        _=>return Err(()),
    };
    request.bearer_auth(key).header("model","drama-3").timeout(std::time::Duration::from_secs(60)).send().await.map(|response|response.status().as_u16()).map_err(|_|())
}

#[cfg(test)]
mod tests{
    use super::*;
    use std::io::{Read,Write};

    #[tokio::test]
    async fn delete_uses_the_documented_resource_authentication_and_explicit_model_at_the_wire(){
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let endpoint=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{let (mut socket,_)=listener.accept().unwrap();let mut bytes=Vec::new();let mut buffer=[0u8;1024];while !bytes.windows(4).any(|window|window==b"\r\n\r\n"){let count=socket.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);assert!(bytes.len()<8192);}socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();String::from_utf8(bytes).unwrap()});
        assert_eq!(execute(&reqwest::Client::new(),&endpoint,"voice-id","delete",&serde_json::Value::Null,"synthetic-test-key").await.unwrap(),200);let request=server.join().unwrap().to_ascii_lowercase();assert!(request.starts_with("delete /model/voice-id http/1.1\r\n"));assert!(request.contains("authorization: bearer synthetic-test-key\r\n"));assert!(request.contains("model: drama-3\r\n"));
    }

    #[tokio::test]
    async fn lost_delete_response_is_an_error_even_after_the_request_reaches_the_peer(){
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let endpoint=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{let (mut socket,_)=listener.accept().unwrap();let mut buffer=[0u8;4096];assert!(socket.read(&mut buffer).unwrap()>0);});
        assert!(execute(&reqwest::Client::new(),&endpoint,"voice-id","delete",&serde_json::Value::Null,"synthetic-test-key").await.is_err());server.join().unwrap();
    }

    #[tokio::test]
    async fn update_sends_exact_patch_fields_and_explicit_model_at_the_wire(){
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let endpoint=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{
            let (mut socket,_)=listener.accept().unwrap();let mut bytes=Vec::new();let mut buffer=[0u8;1024];
            loop{
                let count=socket.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);assert!(bytes.len()<8192);
                if let Some(end)=bytes.windows(4).position(|window|window==b"\r\n\r\n"){
                    let header=String::from_utf8(bytes[..end].to_vec()).unwrap();let length=header.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|value|value.trim().parse::<usize>().unwrap())).unwrap();
                    if bytes.len()>=end+4+length{socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();return (header,serde_json::from_slice::<serde_json::Value>(&bytes[end+4..]).unwrap());}
                }
            }
        });
        let changes=serde_json::json!({"name":"Erzähler 世界","visibility":"unlist"});assert_eq!(execute(&reqwest::Client::new(),&endpoint,"voice-id","update",&changes,"synthetic-test-key").await.unwrap(),200);
        let (header,body)=server.join().unwrap();let header=header.to_ascii_lowercase();assert!(header.starts_with("patch /model/voice-id http/1.1\r\n"));assert!(header.contains("authorization: bearer synthetic-test-key\r\n"));assert!(header.contains("model: drama-3\r\n"));assert!(header.contains("content-type: application/json"));assert_eq!(body,serde_json::json!({"title":"Erzähler 世界","visibility":"unlist"}));
    }

    #[tokio::test]
    async fn lost_update_response_remains_unknown_after_the_patch_reaches_the_peer(){
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let endpoint=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{let (mut socket,_)=listener.accept().unwrap();let mut bytes=[0;4096];let count=socket.read(&mut bytes).unwrap();assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("PATCH /model/voice-id "));});
        assert!(execute(&reqwest::Client::new(),&endpoint,"voice-id","update",&serde_json::json!({"visibility":"private"}),"synthetic-test-key").await.is_err());server.join().unwrap();
    }
}
