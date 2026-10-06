use super::*;

#[test]
fn validates_typed_audio_and_ordered_scene_workflows() {
    let mut flow: MediaFlowDocument = serde_json::from_value(json!({
        "schemaVersion": 1, "id": "flow:sequence", "name": "Sequence", "description": "",
        "createdAt": "2026-10-04T00:00:00Z", "updatedAt": "2026-10-04T00:00:00Z",
        "nodes": [
            {"id":"one","type":"source.video","version":1,"label":"One","layer":"source","config":{"assetId":"asset:one"}},
            {"id":"two","type":"source.video","version":1,"label":"Two","layer":"source","config":{"assetId":"asset:two"}},
            {"id":"audio","type":"source.audio","version":1,"label":"Audio","layer":"source","config":{"assetId":"asset:audio"}},
            {"id":"join","type":"operation.video-sequence","version":1,"label":"Join","layer":"operation","config":{"audioStartSeconds":1.5}},
            {"id":"save","type":"output.video","version":1,"label":"Save","layer":"output","config":{"format":"webm","role":"opaque"}}
        ],
        "edges": [
            {"id":"one","fromNodeId":"one","fromPortId":"video","toNodeId":"join","toPortId":"scene-1"},
            {"id":"two","fromNodeId":"two","fromPortId":"video","toNodeId":"join","toPortId":"scene-2"},
            {"id":"audio","fromNodeId":"audio","fromPortId":"audio","toNodeId":"join","toPortId":"audio"},
            {"id":"save","fromNodeId":"join","fromPortId":"video","toNodeId":"save","toPortId":"video"}
        ]
    })).unwrap();
    assert!(flow.validate().is_ok());
    flow.edges[2].from_node_id = "one".into();
    flow.edges[2].from_port_id = "video".into();
    assert!(flow.validate().is_err());
    flow.edges.remove(2);
    assert!(flow.validate().is_err());
}

#[test]
fn validates_lip_sync_with_separate_vocals_and_rejects_invalid_settings() {
    let mut flow: MediaFlowDocument = serde_json::from_value(json!({
        "schemaVersion": 1, "id": "flow:lip-sync", "name": "Lip sync", "description": "",
        "createdAt": "2026-10-05T00:00:00Z", "updatedAt": "2026-10-05T00:00:00Z",
        "nodes": [
            {"id":"video","type":"source.video","version":1,"label":"Video","layer":"source","config":{"assetId":"asset:video"}},
            {"id":"audio","type":"source.audio","version":1,"label":"Song","layer":"source","config":{"assetId":"asset:audio"}},
            {"id":"voice","type":"source.audio","version":1,"label":"Vocals","layer":"source","config":{"assetId":"asset:voice"}},
            {"id":"sync","type":"operation.lip-sync","version":1,"label":"Lip sync","layer":"operation","config":{"modelPath":"D:/models/musetalk","audioStartSeconds":1.5,"cropShift":0,"batchSize":4,"seed":42}},
            {"id":"save","type":"output.video","version":1,"label":"Save","layer":"output","config":{"format":"webm","role":"opaque"}}
        ],
        "edges": [
            {"id":"video","fromNodeId":"video","fromPortId":"video","toNodeId":"sync","toPortId":"video"},
            {"id":"audio","fromNodeId":"audio","fromPortId":"audio","toNodeId":"sync","toPortId":"audio"},
            {"id":"voice","fromNodeId":"voice","fromPortId":"audio","toNodeId":"sync","toPortId":"voice"},
            {"id":"save","fromNodeId":"sync","fromPortId":"video","toNodeId":"save","toPortId":"video"}
        ]
    })).unwrap();
    assert!(flow.validate().is_ok());
    flow.edges[2].from_node_id = "video".into();
    flow.edges[2].from_port_id = "video".into();
    assert!(flow.validate().is_err());
    flow.edges.remove(2);
    flow.nodes.remove(2);
    assert!(flow.validate().is_ok());
    for (key, value) in [
        ("batchSize", json!(0)),
        ("batchSize", json!(1.5)),
        ("cropShift", json!(-65)),
        ("seed", json!(-1)),
        ("audioStartSeconds", json!(-1)),
    ] {
        let mut invalid = flow.clone();
        invalid.nodes[2].config.insert(key.into(), value);
        assert!(invalid.validate().is_err());
    }
}
