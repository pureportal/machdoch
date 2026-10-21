use std::{collections::HashMap, sync::{Arc, OnceLock}};
use image::{imageops, GrayImage, Rgba, RgbaImage};
use resvg::{tiny_skia, usvg};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{image_layout::{Element, ElementKind, MediaImageLayout}, MediaResult};

pub(crate) const RENDERER_ID: &str = "machdoch-layout/resvg-0.47/alpha4";
const SUBJECT_ALPHA_THRESHOLD: u8 = 4;

pub(crate) struct Composition {
    pub image: RgbaImage,
    pub evidence: Value,
}

pub(crate) fn validate_fonts(layout: &MediaImageLayout) -> MediaResult<()> {
    for element in layout.elements.iter().filter(|element| element.kind == ElementKind::Text) {
        vector_layer(element, 1, 1)?;
    }
    Ok(())
}

fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut fonts = usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    }).clone()
}

fn rgba(color: &str) -> Rgba<u8> {
    let mut result = [255; 4];
    for (index, channel) in color.as_bytes()[1..].chunks(2).enumerate() {
        result[index] = u8::from_str_radix(std::str::from_utf8(channel).unwrap(), 16).unwrap();
    }
    Rgba(result)
}

fn xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn vector_layer(element: &Element, width: u32, height: u32) -> MediaResult<(RgbaImage, Value)> {
    let mut font_evidence = Value::Null;
    let fontdb = fonts();
    let body = if element.kind == ElementKind::Text {
        let font = element.font.as_ref().unwrap();
        let literal = element.text.as_ref().unwrap();
        let id = fontdb.query(&usvg::fontdb::Query { families: &[usvg::fontdb::Family::Name(font)], ..Default::default() })
            .ok_or_else(|| format!("Font {font} is unavailable. Choose an installed font."))?;
        let digest = fontdb.with_face_data(id, |data, face_index| {
            let face = ttf_parser::Face::parse(data, face_index).map_err(|error| format!("Could not read font {font}: {error}"))?;
            if let Some(character) = literal.chars().find(|character| !character.is_whitespace() && face.glyph_index(*character).is_none()) {
                return Err(format!("Font {font} cannot render {character}. Choose a font covering this text."));
            }
            Ok(format!("{:x}", Sha256::digest(data)))
        }).ok_or_else(|| format!("Could not load font {font}."))??;
        font_evidence = json!({"family":font,"sha256":digest,"text":literal,"shaping":"resvg-0.47"});
        let (x, anchor) = match element.align.as_deref().unwrap() {
            "center" => (width as f64 / 2.0, "middle"),
            "right" => (width as f64, "end"),
            _ => (0.0, "start"),
        };
        let size = element.font_size.unwrap();
        let lines = literal.split('\n').enumerate().map(|(index, line)| format!(
            "<tspan x=\"{x}\" y=\"{}\">{}</tspan>", size as f64 * (1.0 + index as f64 * 1.2), xml(line)
        )).collect::<String>();
        format!("<text font-family=\"{}\" font-size=\"{size}\" fill=\"{}\" text-anchor=\"{anchor}\" direction=\"{}\" xml:space=\"preserve\">{lines}</text>", xml(font), element.color.as_ref().unwrap(), element.direction.as_ref().unwrap())
    } else {
        let color = element.color.as_ref().unwrap();
        match element.shape.as_deref().unwrap() {
            "ellipse" => format!("<ellipse cx=\"{}\" cy=\"{}\" rx=\"{}\" ry=\"{}\" fill=\"{color}\"/>", width as f64 / 2.0, height as f64 / 2.0, width as f64 / 2.0, height as f64 / 2.0),
            "arrow" => format!("<path d=\"M0 {} H{} V0 L{} {} L{} {} V{} H0 Z\" fill=\"{color}\"/>", height as f64 * 0.35, width as f64 * 0.65, width, height as f64 / 2.0, width as f64 * 0.65, height, height as f64 * 0.65),
            _ => format!("<rect width=\"{width}\" height=\"{height}\" fill=\"{color}\"/>"),
        }
    };
    let source = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\">{body}</svg>");
    let mut options = usvg::Options { fontdb, ..Default::default() };
    options.image_href_resolver.resolve_data = Box::new(|_, _, _| None);
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    let tree = usvg::Tree::from_str(&source, &options).map_err(|error| format!("Could not shape layout text: {error}"))?;
    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or("Could not allocate layout layer")?;
    resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
    let png = pixmap.encode_png().map_err(|error| error.to_string())?;
    let image = image::load_from_memory(&png).map_err(|error| error.to_string())?.into_rgba8();
    Ok((image, font_evidence))
}

fn foreground_bounds(image: &RgbaImage, minimum_alpha: u8) -> Option<[u32; 4]> {
    let mut bounds = [image.width(), image.height(), 0, 0];
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] >= minimum_alpha {
            bounds = [bounds[0].min(x), bounds[1].min(y), bounds[2].max(x + 1), bounds[3].max(y + 1)];
        }
    }
    (bounds[0] < bounds[2] && bounds[1] < bounds[3]).then_some(bounds)
}

fn resize_alpha(source: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let premultiplied = image::Rgba32FImage::from_fn(source.width(), source.height(), |x, y| {
        let pixel = source.get_pixel(x, y);
        let alpha = pixel[3] as f32 / 255.0;
        Rgba([pixel[0] as f32 / 255.0 * alpha, pixel[1] as f32 / 255.0 * alpha, pixel[2] as f32 / 255.0 * alpha, alpha])
    });
    let resized = imageops::resize(&premultiplied, width, height, imageops::FilterType::Lanczos3);
    RgbaImage::from_fn(width, height, |x, y| {
        let pixel = resized.get_pixel(x, y);
        let alpha = pixel[3].clamp(0.0, 1.0);
        if alpha <= 0.0 { return Rgba([0, 0, 0, 0]); }
        Rgba([(pixel[0] / alpha * 255.0).round().clamp(0.0, 255.0) as u8, (pixel[1] / alpha * 255.0).round().clamp(0.0, 255.0) as u8,
            (pixel[2] / alpha * 255.0).round().clamp(0.0, 255.0) as u8, (alpha * 255.0).round() as u8])
    })
}

fn object_layer(element: &Element, source: &RgbaImage, width: u32, height: u32) -> MediaResult<RgbaImage> {
    let mut source = source.clone();
    if element.cutout.unwrap_or(true) {
        if source.pixels().all(|pixel| pixel[3] == 255) {
            return Err(format!("{} needs a subject cutout with transparency.", element.id));
        }
        let [left, top, right, bottom] = foreground_bounds(&source, SUBJECT_ALPHA_THRESHOLD).ok_or_else(|| format!("The cutout for {} is empty.", element.id))?;
        source = imageops::crop_imm(&source, left, top, right - left, bottom - top).to_image();
    }
    let fit = element.fit.as_deref().unwrap_or("contain");
    if fit == "cover" {
        let ratio = width as f64 / height as f64;
        let crop_width = source.width().min((source.height() as f64 * ratio).round().max(1.0) as u32);
        let crop_height = source.height().min((source.width() as f64 / ratio).round().max(1.0) as u32);
        source = imageops::crop_imm(&source, (source.width() - crop_width) / 2, (source.height() - crop_height) / 2, crop_width, crop_height).to_image();
    }
    if fit != "contain" { return Ok(resize_alpha(&source, width, height)); }
    let scale = (width as f64 / source.width() as f64).min(height as f64 / source.height() as f64);
    let scaled_width = (source.width() as f64 * scale).round().max(1.0) as u32;
    let scaled_height = (source.height() as f64 * scale).round().max(1.0) as u32;
    let resized = resize_alpha(&source, scaled_width, scaled_height);
    let mut layer = RgbaImage::new(width, height);
    imageops::overlay(&mut layer, &resized, ((width - scaled_width) / 2) as i64, ((height - scaled_height) / 2) as i64);
    Ok(layer)
}

pub(crate) fn compose(layout: &MediaImageLayout, assets: &HashMap<String, RgbaImage>) -> MediaResult<Composition> {
    layout.validate()?;
    let background = layout.background.as_deref().map(rgba).unwrap_or(Rgba([0, 0, 0, 0]));
    let mut output = RgbaImage::from_pixel(layout.canvas.width, layout.canvas.height, background);
    let mut elements = layout.elements.iter().collect::<Vec<_>>();
    elements.sort_by_key(|element| element.z_index);
    let mut evidence = Vec::new();
    for element in elements {
        let [left, top, right, bottom] = element.bounds;
        let (width, height) = (right - left, bottom - top);
        let (mut layer, font) = if element.kind == ElementKind::Object {
            let source = assets.get(&element.id).ok_or_else(|| format!("Choose or generate an asset for {}.", element.id))?;
            (object_layer(element, source, width, height)?, Value::Null)
        } else { vector_layer(element, width, height)? };
        for pixel in layer.pixels_mut() {
            pixel[3] = (pixel[3] as f64 * element.opacity.unwrap_or(1.0)).round() as u8;
        }
        let visible = foreground_bounds(&layer, 1).map(|bounds| [bounds[0] + left, bounds[1] + top, bounds[2] + left, bounds[3] + top]);
        evidence.push(json!({"id":element.id,"box":element.bounds,"visibleBox":visible,"font":font}));
        imageops::overlay(&mut output, &layer, left as i64, top as i64);
    }
    Ok(Composition { image: output, evidence: json!({"renderer":RENDERER_ID,"cutoutAlphaThreshold":SUBJECT_ALPHA_THRESHOLD,"elements":evidence}) })
}

pub(crate) fn restore_outside_mask(source: &RgbaImage, edited: &RgbaImage, mask: &GrayImage) -> MediaResult<RgbaImage> {
    if source.dimensions() != edited.dimensions() || source.dimensions() != mask.dimensions() {
        return Err("Source, edit and hard mask dimensions must match.".into());
    }
    let mut result = edited.clone();
    for (x, y, pixel) in mask.enumerate_pixels() {
        match pixel[0] {
            0 => result.put_pixel(x, y, *source.get_pixel(x, y)),
            255 => {},
            _ => return Err("Pixel preservation requires a binary hard mask.".into()),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutout_bounds_ignore_trace_alpha_without_removing_translucency() {
        let layout = MediaImageLayout::parse(&json!({"schemaVersion":1,"canvas":{"width":32,"height":32},"caption":"","elements":[
            {"id":"subject","kind":"object","description":"","box":[4,6,28,22],"zIndex":0,"fit":"stretch"}
        ]})).unwrap();
        let mut source = RgbaImage::from_pixel(8, 8, Rgba([240,240,240,2]));
        for y in 2..6 { for x in 2..6 { source.put_pixel(x,y,Rgba([240,240,240,128])); } }
        let mut assets = HashMap::from([("subject".to_string(), source)]);
        let result = compose(&layout, &assets).unwrap();
        assert_eq!(result.evidence["cutoutAlphaThreshold"], 4);
        for (x,y,pixel) in result.image.enumerate_pixels() {
            assert_eq!(pixel[3], if (4..28).contains(&x) && (6..22).contains(&y) {128} else {0});
        }
        assets.insert("subject".into(), RgbaImage::from_pixel(8,8,Rgba([240,240,240,2])));
        assert!(compose(&layout, &assets).is_err());
        let mut uncut = layout;
        uncut.elements[0].cutout = Some(false);
        assert_eq!(compose(&uncut, &assets).unwrap().image.get_pixel(4,6)[3], 2);
    }

    #[test]
    fn text_is_shaped_clipped_and_literal() {
        let literal = "{{title}}\nGrüße — مرحبا";
        let layout = MediaImageLayout::parse(&json!({"schemaVersion":1,"canvas":{"width":320,"height":160},"caption":"","background":"#ffffff","elements":[
            {"id":"label","kind":"text","description":"","box":[16,16,150,80],"zIndex":0,"text":literal,"font":"Arial","fontSize":28,"color":"#000000","align":"left","direction":"ltr"}
        ]})).unwrap();
        let result = compose(&layout, &HashMap::new()).unwrap();
        assert_eq!(result.evidence["elements"][0]["font"]["text"], literal);
        assert!(result.image.enumerate_pixels().filter(|(x,y,_)| (16..150).contains(x) && (16..80).contains(y)).any(|(_,_,pixel)| pixel[0] < 128));
        for (x,y,pixel) in result.image.enumerate_pixels() {
            if !(16..150).contains(&x) || !(16..80).contains(&y) { assert_eq!(*pixel, Rgba([255,255,255,255])); }
        }
        let mut missing = layout;
        missing.elements[0].font = Some("MachdochMissingFont".into());
        assert!(compose(&missing, &HashMap::new()).is_err());
    }

    #[test]
    fn exact_text_respects_upper_layers() {
        let layout = MediaImageLayout::parse(&json!({"schemaVersion":1,"canvas":{"width":160,"height":80},"caption":"","elements":[
            {"id":"label","kind":"text","description":"","box":[0,0,160,80],"zIndex":0,"text":"MMMMMMMM","font":"Arial","fontSize":32,"color":"#000000","align":"left","direction":"ltr"},
            {"id":"cover","kind":"shape","shape":"rectangle","color":"#ff0000","description":"","box":[80,0,160,80],"zIndex":1}
        ]})).unwrap();
        let result = compose(&layout, &HashMap::new()).unwrap();
        assert!(result.image.enumerate_pixels().any(|(x,_,pixel)| x < 80 && pixel[3] > 0));
        assert!(result.image.enumerate_pixels().all(|(x,_,pixel)| x < 80 || *pixel == Rgba([255,0,0,255])));
    }

    #[test]
    fn transparent_colors_do_not_bleed_when_scaled() {
        let source = RgbaImage::from_fn(2, 1, |x,_| if x == 0 { Rgba([255,0,0,0]) } else { Rgba([0,0,255,255]) });
        let scaled = resize_alpha(&source, 32, 16);
        assert!(scaled.pixels().all(|pixel| pixel[3] == 0 || pixel[0] == 0));
    }

    #[test]
    fn layers_clip_and_removing_an_object_restores_background() {
        let mut layout = MediaImageLayout::parse(&json!({"schemaVersion":1,"canvas":{"width":64,"height":48},"caption":"","background":"#ffffff","elements":[
            {"id":"card","kind":"shape","shape":"rectangle","color":"#ff0000","description":"","box":[8,8,48,40],"zIndex":0},
            {"id":"asset","kind":"object","cutout":false,"fit":"cover","description":"","box":[24,16,56,32],"zIndex":1}
        ]})).unwrap();
        let assets = HashMap::from([("asset".into(), RgbaImage::from_pixel(100, 20, Rgba([0,0,255,255])))]);
        let first = compose(&layout, &assets).unwrap();
        assert_eq!(*first.image.get_pixel(24, 16), Rgba([0,0,255,255]));
        assert_eq!(*first.image.get_pixel(24, 32), Rgba([255,0,0,255]));
        assert_eq!(*first.image.get_pixel(56, 16), Rgba([255,255,255,255]));
        layout.elements.pop();
        let removed = compose(&layout, &assets).unwrap();
        assert_eq!(*removed.image.get_pixel(24, 16), Rgba([255,0,0,255]));
    }

    #[test]
    fn hard_mask_preserves_decoded_pixels_and_rejects_soft_masks() {
        let source = RgbaImage::from_fn(32, 24, |x,y| Rgba([x as u8, y as u8, 17, 255]));
        let edited = RgbaImage::from_pixel(32,24,Rgba([255,0,0,255]));
        let mut mask = GrayImage::from_fn(32,24,|x,y| image::Luma([if (8..16).contains(&x) && (4..12).contains(&y) {255} else {0}]));
        let result = restore_outside_mask(&source, &edited, &mask).unwrap();
        for (x,y,pixel) in result.enumerate_pixels() {
            assert_eq!(pixel, if mask.get_pixel(x,y)[0] == 0 { source.get_pixel(x,y) } else { edited.get_pixel(x,y) });
        }
        mask.put_pixel(0,0,image::Luma([128]));
        assert!(restore_outside_mask(&source,&edited,&mask).is_err());
    }
}
