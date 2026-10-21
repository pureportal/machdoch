use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use super::MediaResult;

fn optional_value<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaImageLayout {
    pub schema_version: u32,
    pub canvas: Canvas,
    pub caption: String,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    pub elements: Vec<Element>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub relations: Option<Vec<Relation>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Canvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ElementKind { Object, Text, Shape }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LayoutMethod { Native, Composition, Reference, Masked }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Element {
    pub id: String,
    pub kind: ElementKind,
    pub description: String,
    #[serde(rename = "box")]
    pub bounds: [u32; 4],
    pub z_index: i32,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub cutout: Option<bool>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default, deserialize_with = "optional_value", skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Relation {
    pub kind: String,
    pub subject_id: String,
    pub object_id: String,
}

fn valid_color(value: &str) -> bool {
    matches!(value.len(), 7 | 9) && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl MediaImageLayout {
    pub fn digest(&self) -> MediaResult<String> {
        use sha2::{Digest, Sha256};
        let value = serde_json::to_value(self).map_err(|error| error.to_string())?;
        Ok(format!("{:x}", Sha256::digest(super::canonical_json::canonical_json(&value)?.as_bytes())))
    }

    pub fn parse(value: &serde_json::Value) -> MediaResult<Self> {
        let layout: Self = serde_json::from_value(value.clone()).map_err(|error| format!("Invalid image layout: {error}"))?;
        layout.validate()?;
        Ok(layout)
    }

    pub fn validate(&self) -> MediaResult<()> {
        if self.schema_version != 1 || !(1..=8192).contains(&self.canvas.width) || !(1..=8192).contains(&self.canvas.height) {
            return Err("Canvas dimensions must be whole pixels between 1 and 8192.".into());
        }
        if self.caption.encode_utf16().count() > 16000 || self.background.as_ref().is_some_and(|color| !valid_color(color)) || self.elements.len() > 256 {
            return Err("Invalid layout caption, background or element count.".into());
        }
        let mut ids = HashSet::new();
        for element in &self.elements {
            if element.id.is_empty() || element.id.len() > 64 || !element.id.as_bytes()[0].is_ascii_alphabetic()
                || !element.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') || !ids.insert(element.id.as_str()) {
                return Err("Each element needs a unique ID starting with a letter.".into());
            }
            let [left, top, right, bottom] = element.bounds;
            if left >= right || top >= bottom || right > self.canvas.width || bottom > self.canvas.height {
                return Err(format!("Keep {} inside the canvas with positive width and height.", element.id));
            }
            if element.description.encode_utf16().count() > 4000 || !(-10000..=10000).contains(&element.z_index)
                || element.opacity.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                return Err(format!("Invalid description, layer or opacity for {}.", element.id));
            }
            if element.kind != ElementKind::Object && (element.asset_id.is_some() || element.fit.is_some() || element.cutout.is_some())
                || element.kind != ElementKind::Text && (element.text.is_some() || element.font.is_some() || element.font_size.is_some() || element.align.is_some() || element.direction.is_some())
                || element.kind != ElementKind::Shape && element.shape.is_some()
                || element.kind == ElementKind::Object && element.color.is_some() {
                return Err(format!("Invalid fields for {}.", element.id));
            }
            match element.kind {
                ElementKind::Object => {
                    if element.asset_id.as_ref().is_some_and(|value| value.trim().is_empty() || value.encode_utf16().count() > 256)
                        || element.fit.as_ref().is_some_and(|value| !matches!(value.as_str(), "contain" | "cover" | "stretch")) {
                        return Err(format!("Invalid asset settings for {}.", element.id));
                    }
                }
                ElementKind::Text => {
                    if !element.text.as_ref().is_some_and(|value| !value.is_empty() && value.encode_utf16().count() <= 8000)
                        || !element.font.as_ref().is_some_and(|value| !value.trim().is_empty() && value.encode_utf16().count() <= 256)
                        || !element.font_size.is_some_and(|value| (1..=1024).contains(&value))
                        || !matches!(element.align.as_deref(), Some("left" | "center" | "right"))
                        || !matches!(element.direction.as_deref(), Some("ltr" | "rtl")) {
                        return Err(format!("Choose text, font, size and alignment for {}.", element.id));
                    }
                }
                ElementKind::Shape => {
                    if !matches!(element.shape.as_deref(), Some("rectangle" | "ellipse" | "arrow")) {
                        return Err(format!("Choose a shape for {}.", element.id));
                    }
                }
            }
            if element.kind != ElementKind::Object && !element.color.as_ref().is_some_and(|value| valid_color(value)) {
                return Err(format!("Choose a color for {}.", element.id));
            }
        }
        if self.relations.as_ref().is_some_and(|relations| relations.len() > 1024 || relations.iter().any(|relation|
            !matches!(relation.kind.as_str(), "left-of" | "above" | "on" | "inside") || relation.subject_id == relation.object_id
                || !ids.contains(relation.subject_id.as_str()) || !ids.contains(relation.object_id.as_str()))) {
            return Err("Relations must refer to two different existing elements.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_and_invalid_geometry() {
        let scene: serde_json::Value = serde_json::from_str(include_str!("../../../../../docs/artifacts/layout-control-2026-10-18/scene.json")).unwrap();
        let mut layout = MediaImageLayout::parse(&scene).unwrap();
        assert_eq!(layout.elements[1].bounds, [160, 160, 400, 560]);
        layout.elements[1].bounds[2] = 1025;
        assert!(layout.validate().is_err());
    }
}
