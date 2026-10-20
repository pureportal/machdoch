use serde_json::Value;

fn ordered_clips(clips: &[(Value, Value)]) -> Result<Vec<&(Value, Value)>, String> {
    let mut ordered = clips
        .iter()
        .map(|clip| {
            let start = clip.0["start"]
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or("Use a valid measured timeline position.")?;
            Ok((start, clip))
        })
        .collect::<Result<Vec<_>, String>>()?;
    ordered.sort_by(|first, second| first.0.total_cmp(&second.0));
    Ok(ordered.into_iter().map(|(_, clip)| clip).collect())
}

pub fn transcript(clips: &[(Value, Value)]) -> Result<String, String> {
    let mut result = Vec::new();
    let mut bytes = 0usize;
    for (clip, take) in ordered_clips(clips)? {
        let from = clip["in"]
            .as_f64()
            .ok_or("The transcript trim is invalid.")?;
        let to = clip["out"]
            .as_f64()
            .ok_or("The transcript trim is invalid.")?;
        let duration = take["asset"]["duration"]
            .as_f64()
            .ok_or("Take duration is missing.")?;
        if from == 0.0 && (to - duration).abs() < 0.000001 {
            result.push(
                take["spokenText"]
                    .as_str()
                    .ok_or("The selected take's immutable spoken transcript is missing.")?
                    .to_string(),
            );
        } else {
            let alignment = take["alignment"]
                .as_array()
                .filter(|words| !words.is_empty())
                .ok_or("Align trimmed takes before exporting their transcript.")?;
            let mut words = Vec::new();
            for word in alignment {
                let start = word["start"]
                    .as_f64()
                    .ok_or("The transcript alignment is invalid.")?;
                let end = word["end"]
                    .as_f64()
                    .ok_or("The transcript alignment is invalid.")?;
                if (start < from && end > from) || (start < to && end > to) {
                    return Err(
                        "Move the trim to a word boundary or realign the edited audio.".into(),
                    );
                }
                if start >= from && end <= to {
                    words.push(word["text"].as_str().ok_or("An aligned word is missing.")?);
                }
            }
            result.push(words.join(" "));
        }
        bytes = bytes
            .checked_add(result.last().ok_or("The transcript is missing.")?.len())
            .ok_or("The transcript exceeds the local export guard.")?;
        if bytes > 32 * 1024 * 1024 {
            return Err("Export a transcript range below the local 32 MiB text guard.".into());
        }
    }
    Ok(result.join("\n\n"))
}

pub fn chapter_metadata(clips: &[(Value, Value)], duration: f64) -> Result<String, String> {
    let mut chapters: Vec<(String, String, f64)> = Vec::new();
    let mut measured_duration = 0.0f64;
    for (clip, take) in ordered_clips(clips)? {
        let start = clip["start"].as_f64().ok_or("Chapter timing is missing.")?;
        let from = clip["in"].as_f64().ok_or("Chapter trim is missing.")?;
        let to = clip["out"].as_f64().ok_or("Chapter trim is missing.")?;
        if !start.is_finite() || !from.is_finite() || !to.is_finite() || start < 0.0 || to <= from {
            return Err("Use valid measured chapter timings.".into());
        }
        measured_duration = measured_duration.max(start + to - from);
        let chapter = &take["chapter"];
        let id = chapter["id"].as_str().ok_or(
            "Assign chapters to every selected take before exporting a chaptered audiobook.",
        )?;
        let title = chapter["title"]
            .as_str()
            .ok_or("The chapter title is missing.")?;
        if chapters.last().is_none_or(|previous| previous.0 != id) {
            if chapters.last().is_some_and(|previous| previous.2 >= start) {
                return Err("Arrange chapter boundaries in increasing timeline order.".into());
            }
            chapters.push((id.to_string(), title.to_string(), start));
        }
    }
    if chapters.is_empty() {
        return Err("Choose chaptered narration before exporting an audiobook.".into());
    }
    if !duration.is_finite() || duration + 0.000001 < measured_duration || duration <= 0.0 {
        return Err("Use the measured full production duration for audiobook chapters.".into());
    }
    let escape = |value: &str| {
        value
            .replace('\\', "\\\\")
            .replace('=', "\\=")
            .replace(';', "\\;")
            .replace('#', "\\#")
            .replace('\n', "\\\n")
            .replace('\r', "")
    };
    let mut metadata = ";FFMETADATA1\n".to_string();
    for (index, (_, title, start)) in chapters.iter().enumerate() {
        let end = chapters
            .get(index + 1)
            .map_or(duration, |chapter| chapter.2);
        let from = (start * 1000.0).round() as u64;
        let to = (end * 1000.0).round() as u64;
        if to <= from {
            return Err("Chapter durations must be at least one millisecond.".into());
        }
        metadata += &format!(
            "[CHAPTER]\nTIMEBASE=1/1000\nSTART={from}\nEND={to}\ntitle={}\n",
            escape(title)
        );
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clips() -> Vec<(Value, Value)> {
        vec![
            (
                json!({"start":0.0,"in":0.0,"out":2.0}),
                json!({"spokenText":"Hello world.","chapter":{"id":"a","title":"Arrival = yes;#"},"asset":{"duration":2.0},"alignment":[{"text":"Hello","start":0.0,"end":1.0},{"text":"world.","start":1.0,"end":2.0}]}),
            ),
            (
                json!({"start":2.0,"in":0.0,"out":3.0}),
                json!({"spokenText":"Auf Wiedersehen.","chapter":{"id":"b","title":"Departure"},"asset":{"duration":3.0},"alignment":[]}),
            ),
        ]
    }

    #[test]
    fn exports_the_submitted_transcript_and_measured_chapters() {
        let clips = clips();
        assert_eq!(
            transcript(&clips).unwrap(),
            "Hello world.\n\nAuf Wiedersehen."
        );
        let metadata = chapter_metadata(&clips, 5.0).unwrap();
        assert!(metadata.contains("START=0\nEND=2000\ntitle=Arrival \\= yes\\;\\#"));
        assert!(metadata.contains("START=2000\nEND=5000\ntitle=Departure"));
    }

    #[test]
    fn trimmed_transcripts_require_current_alignment_and_whole_words() {
        let mut clips = clips();
        clips[0].0["in"] = json!(1.0);
        assert_eq!(transcript(&clips).unwrap(), "world.\n\nAuf Wiedersehen.");
        clips[0].0["in"] = json!(0.5);
        assert!(transcript(&clips).is_err());
        clips[0].0["in"] = json!(0.0);
        clips[1].0["in"] = json!(1.0);
        assert!(transcript(&clips).is_err());
        clips[1].1["chapter"] = Value::Null;
        assert!(chapter_metadata(&clips, 5.0).is_err());
    }
}
