use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Invoke {
        id: String,
        command: String,
        args: Value,
    },
    Read {
        id: String,
        offset: f64,
    },
    Release {
        id: String,
    },
    Events {
        after: f64,
    },
}

fn valid_id(id: &str) -> bool {
    if id == "00000000-0000-0000-0000-000000000000"
        || id.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

pub(super) fn valid_request(value: &Value, validate: impl FnOnce(&str, &Value) -> bool) -> bool {
    let Ok(request) = serde_json::from_value::<Request>(value.clone()) else {
        return false;
    };
    match request {
        Request::Invoke { id, command, args } => valid_id(&id) && validate(&command, &args),
        Request::Read { id, offset } => {
            valid_id(&id)
                && offset >= 0.0
                && offset.fract() == 0.0
                && offset <= (64 * 1024 * 1024) as f64
        }
        Request::Release { id } => valid_id(&id),
        Request::Events { after } => {
            after >= 0.0 && after.fract() == 0.0 && after <= 9_007_199_254_740_991.0
        }
    }
}
