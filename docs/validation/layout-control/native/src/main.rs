use std::{collections::HashMap, fs, path::PathBuf};
type MediaResult<T> = Result<T, String>;
#[path = "../../../../../apps/client/src-tauri/src/media/canonical_json.rs"]
mod canonical_json;
#[path = "../../../../../apps/client/src-tauri/src/media/image_layout.rs"]
mod image_layout;
#[path = "../../../../../apps/client/src-tauri/src/media/image_layout_compositor.rs"]
mod image_layout_compositor;

fn main() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.as_slice() == ["validate"] {
        let values: Vec<serde_json::Value> = serde_json::from_reader(std::io::stdin()).map_err(|error| error.to_string())?;
        let results = values.iter().map(|value| match image_layout::MediaImageLayout::parse(value) {
            Ok(layout) => serde_json::json!({"valid":true,"digest":layout.digest().unwrap(),"layout":layout}),
            Err(error) => serde_json::json!({"valid":false,"error":error}),
        }).collect::<Vec<_>>();
        println!("{}", serde_json::to_string(&results).map_err(|error| error.to_string())?);
        return Ok(());
    }
    if args.len() != 3 { return Err("Expected scene.json assets.json output.png".into()); }
    let layout = image_layout::MediaImageLayout::parse(&serde_json::from_slice(&fs::read(&args[0]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?)?;
    let sources: HashMap<String, PathBuf> = serde_json::from_slice(&fs::read(&args[1]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut assets = HashMap::new();
    for (id, path) in sources { assets.insert(id, image::load_from_memory(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?.into_rgba8()); }
    let started = std::time::Instant::now();
    let result = image_layout_compositor::compose(&layout, &assets)?;
    result.image.save(&args[2]).map_err(|e| e.to_string())?;
    let evidence = serde_json::json!({"layout":layout,"digest":layout.digest()?,"composition":result.evidence,"elapsedSeconds":started.elapsed().as_secs_f64()});
    fs::write(PathBuf::from(&args[2]).with_extension("json"), serde_json::to_vec_pretty(&evidence).unwrap()).map_err(|e| e.to_string())?;
    Ok(())
}
