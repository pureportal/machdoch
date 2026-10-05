use serde::{de::Error, ser::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

enum Shape {
    Bool,
    Integer,
    Number(f64, f64),
    String(usize, bool),
    Enum(&'static [&'static str]),
    Array(Box<Shape>, usize, usize),
    Object(Vec<Field>),
    Nullable(Box<Shape>),
    Version,
    ImageDataUrl,
    Union(Vec<Shape>),
    Uuid,
    ProjectName,
    PositiveInteger,
    ProjectListItem,
    BoundedInteger(u64, u64),
    HostTelemetry,
}

struct Field {
    name: &'static str,
    shape: Shape,
    optional: bool,
}

fn required(name: &'static str, shape: Shape) -> Field {
    Field {
        name,
        shape,
        optional: false,
    }
}

fn optional(name: &'static str, shape: Shape) -> Field {
    Field {
        name,
        shape,
        optional: true,
    }
}

fn object(fields: Vec<Field>) -> Shape {
    Shape::Object(fields)
}
fn array(shape: Shape, maximum: usize) -> Shape {
    Shape::Array(Box::new(shape), 0, maximum)
}
fn bounded_array(shape: Shape, minimum: usize, maximum: usize) -> Shape {
    Shape::Array(Box::new(shape), minimum, maximum)
}
fn string(maximum: usize) -> Shape {
    Shape::String(maximum, false)
}
fn identifier() -> Shape {
    Shape::String(240, true)
}
fn short_text() -> Shape {
    Shape::String(240, true)
}
fn workspace() -> Shape {
    Shape::String(12_000, true)
}
fn text() -> Shape {
    string(12_000)
}
fn enumeration(values: &'static [&'static str]) -> Shape {
    Shape::Enum(values)
}

impl Shape {
    fn accepts(&self, value: &Value) -> bool {
        match self {
            Self::Bool => value.is_boolean(),
            Self::HostTelemetry => {
                let shape = object(vec![
                    required("capturedAt", Shape::Integer),
                    required("platform", Shape::String(64, true)),
                    required("architecture", Shape::String(64, true)),
                    required("cpuCount", Shape::PositiveInteger),
                    required(
                        "cpuUsagePercent",
                        Shape::Nullable(Box::new(Shape::Number(0.0, 100.0))),
                    ),
                    required("memoryTotalBytes", Shape::Integer),
                    required("memoryUsedBytes", Shape::Integer),
                    required("uptimeSeconds", Shape::Integer),
                ]);
                shape.accepts(value)
                    && value["memoryUsedBytes"].as_f64() <= value["memoryTotalBytes"].as_f64()
            }
            Self::Integer => value.as_f64().is_some_and(|number| {
                (0.0..=9_007_199_254_740_991.0).contains(&number) && number.fract() == 0.0
            }),
            Self::Number(minimum, maximum) => value
                .as_f64()
                .is_some_and(|number| (*minimum..=*maximum).contains(&number)),
            Self::String(maximum, nonempty) => value.as_str().is_some_and(|value| {
                let value = if *nonempty {
                    crate::ecmascript_trim(value)
                } else {
                    value
                };
                (!*nonempty || !value.is_empty()) && value.encode_utf16().count() <= *maximum
            }),
            Self::Enum(values) => value.as_str().is_some_and(|value| values.contains(&value)),
            Self::Array(item, minimum, maximum) => value.as_array().is_some_and(|values| {
                (*minimum..=*maximum).contains(&values.len())
                    && values.iter().all(|value| item.accepts(value))
            }),
            Self::Object(fields) => value.as_object().is_some_and(|object| {
                object
                    .keys()
                    .all(|key| fields.iter().any(|field| field.name == key))
                    && fields.iter().all(|field| match object.get(field.name) {
                        Some(value) => field.shape.accepts(value),
                        None => field.optional,
                    })
            }),
            Self::Nullable(shape) => value.is_null() || shape.accepts(value),
            Self::Version => value.as_f64() == Some(5.0),
            Self::ImageDataUrl => value.as_str().is_some_and(|value| {
                value.encode_utf16().count() <= 120_000 && value.starts_with("data:image/")
            }),
            Self::Union(shapes) => shapes.iter().any(|shape| shape.accepts(value)),
            Self::Uuid => value.as_str().is_some_and(|value| {
                let parts: Vec<_> = value.split('-').collect();
                parts.len() == 5
                    && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, size)| {
                        part.len() == size && part.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    && (value == "00000000-0000-0000-0000-000000000000"
                        || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
                        || ((b'1'..=b'8').contains(&parts[2].as_bytes()[0])
                            && matches!(
                                parts[3].as_bytes()[0].to_ascii_lowercase(),
                                b'8' | b'9' | b'a' | b'b'
                            )))
            }),
            Self::ProjectName => value.as_str().is_some_and(|value| {
                let name = crate::ecmascript_trim(value);
                let base = name.split('.').next().unwrap_or("").to_ascii_lowercase();
                let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
                    || (base.len() == 4
                        && (base.starts_with("com") || base.starts_with("lpt"))
                        && base.as_bytes()[3].is_ascii_digit());
                (1..=80).contains(&name.len())
                    && !reserved
                    && !name.ends_with('.')
                    && name
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    && name.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            }),
            Self::PositiveInteger => {
                Self::Integer.accepts(value) && value.as_f64().is_some_and(|number| number > 0.0)
            }
            Self::ProjectListItem => shell::project_list_item().accepts(value),
            Self::BoundedInteger(minimum, maximum) => {
                Self::Integer.accepts(value)
                    && value
                        .as_f64()
                        .is_some_and(|number| (*minimum as f64..=*maximum as f64).contains(&number))
            }
        }
    }
}

fn log() -> Shape {
    object(vec![
        required("createdAt", Shape::Integer),
        required("stream", string(64)),
        optional("toolName", string(240)),
        required("chunk", text()),
    ])
}

fn timeline() -> Shape {
    object(vec![
        required("createdAt", Shape::Integer),
        required("kind", string(64)),
        required("phase", string(64)),
        required("label", text()),
        optional("detail", text()),
        optional("tone", string(64)),
        optional("toolName", string(240)),
    ])
}

fn session() -> Shape {
    object(vec![
        required("taskId", identifier()),
        required("task", text()),
        required("mode", string(64)),
        required("state", string(64)),
        required("message", text()),
        required("cancellable", Shape::Bool),
        required("startedAt", Shape::Integer),
        required("updatedAt", Shape::Integer),
        required("progressCount", Shape::Integer),
        required("logs", array(log(), usize::MAX)),
        required("timeline", array(timeline(), usize::MAX)),
    ])
}

fn command() -> Shape {
    object(vec![
        required("commandId", identifier()),
        required("kind", string(64)),
        optional("taskId", identifier()),
        optional("sessionId", identifier()),
        optional("promptPreview", text()),
        optional("title", text()),
        optional("targetPreview", text()),
        required("createdAt", Shape::Integer),
    ])
}

pub(crate) fn deserialize_product_snapshot<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let snapshot = Value::deserialize(deserializer)?;
    if product_snapshot_shape().accepts(&snapshot) {
        Ok(snapshot)
    } else {
        Err(D::Error::custom("Invalid product snapshot."))
    }
}

pub(crate) fn serialize_product_snapshot<S>(
    snapshot: &Value,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if !product_snapshot_shape().accepts(snapshot) {
        return Err(S::Error::custom("Invalid product snapshot."));
    }
    snapshot.serialize(serializer)
}

fn product_snapshot_shape() -> Shape {
    object(vec![
        optional("telemetry", Shape::HostTelemetry),
        required("enabled", Shape::Bool),
        required("serverTime", Shape::Integer),
        required("eventId", Shape::Integer),
        required("sessions", array(session(), 128)),
        required("commands", array(command(), 100)),
        optional("shell", shell::shape()),
    ])
}

mod shell;
