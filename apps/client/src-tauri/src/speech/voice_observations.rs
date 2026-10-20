use super::*;

pub(super) fn validate(value:&Value)->Result<(),String>{
    fields(value,&["id","name","author","languages","visibility","rights","evidence"])?;
    if encode(value)?.len()>65_536{return Err("Voice source metadata exceeds 64 KiB.".into());}
    let id=identifier(value,"id")?;
    text(value,"name",1,800)?;
    nullable_text(value,"author",512)?;nullable_text(value,"rights",32_768)?;
    if !matches!(value["visibility"].as_str(),Some("private"|"unlist"|"public")){return Err("The voice source visibility is invalid.".into());}
    for language in array(value,"languages",256)?{language.as_str().filter(|language|!language.is_empty()&&language.len()<=35&&!language.chars().any(char::is_control)).ok_or("The voice source language is invalid.")?;}
    let evidence=required(value,"evidence")?;
    fields(evidence,&["provider","url","observedAt","responseSha256","authorId","source","providerCreatedAt","providerUpdatedAt"])?;
    if evidence["provider"]!="fish-cloud"||evidence["url"]!=format!("https://api.fish.audio/model/{id}"){return Err("The voice source must identify the observed Fish model endpoint.".into());}
    parse_time(text(evidence,"observedAt",1,128)?)?;asset_identifier(required(evidence,"responseSha256")?)?;
    for field in ["authorId","source","providerCreatedAt","providerUpdatedAt"]{nullable_text(evidence,field,128)?;}
    Ok(())
}

pub(super) fn validate_take(take:&Value)->Result<(),String>{
    let Some(observations)=take.get("voiceObservations")else{return Ok(());};
    if take["backend"]!="fish-cloud"{return Err("Fish voice observations apply only to Fish generation.".into());}
    let values=observations.as_array().filter(|values|!values.is_empty()&&values.len()<=256).ok_or("Keep one to 256 distinct voice source observations.")?;
    let mut ids=HashSet::new();for value in values{validate(value)?;unique(&mut ids,identifier(value,"id")?)?;}
    Ok(())
}

pub(super) fn validate_binding(binding:&Value)->Result<(),String>{
    if let Some(observation)=binding.get("voiceObservation"){
        validate(observation)?;
        if binding["voiceId"]!=observation["id"]{return Err("The cast voice source differs from its voice binding.".into());}
    }
    Ok(())
}

impl SpeechStore{
    pub(crate) fn segment_voice_observations(snapshot:&Value,segment:&Value)->Result<Value,String>{
        if snapshot["profile"]["backend"]!="fish-cloud"{return Ok(Value::Null);}
        let voices=segment["voiceIds"].as_array().ok_or("The segment voices are unavailable.")?;
        let mut ids:HashSet<&str>=voices.iter().filter_map(Value::as_str).collect();
        if ids.is_empty(){if let Some(id)=snapshot["profile"]["voiceId"].as_str(){ids.insert(id);}}
        let Some(observations)=snapshot.get("voiceObservations")else{return Ok(Value::Null);};
        let values=observations.as_array().ok_or("The submitted voice source observations are damaged.")?;
        let mut selected=Vec::new();
        for value in values{validate(value)?;if ids.contains(identifier(value,"id")?){selected.push(value.clone());}}
        if selected.is_empty(){Ok(Value::Null)}else{Ok(json!(selected))}
    }

    pub(crate) fn record_voice_observation(connection:&Connection,voice:&Value)->Result<(),String>{
        let observation=json!({"id":voice["id"],"name":voice["name"],"author":voice["author"],"languages":voice["languages"],"visibility":voice["visibility"],"rights":voice["rights"],"evidence":voice["evidence"]});
        validate(&observation)?;
        connection.execute("INSERT INTO speech_voice_observations(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![identifier(&observation,"id")?,encode(&observation)?]).map_err(error)?;Ok(())
    }

    pub(crate) fn voice_observations(&self,ids:&[String])->Result<Value,String>{
        let mut statement=self.connection.prepare("SELECT data FROM speech_voice_observations WHERE id IN(SELECT value FROM json_each(?1)) ORDER BY id").map_err(error)?;
        let rows=statement.query_map([json!(ids).to_string()],|row|row.get(0)).map_err(error)?;
        let observations=collect_json(rows)?;
        for observation in observations.as_array().ok_or("The voice source cache is damaged.")?{validate(observation)?;}
        Ok(observations)
    }

    pub(super) fn pin_cast_voice_observations(&self,project:&mut Value)->Result<(),String>{
        let Some(cast)=project["cast"].as_array_mut()else{return Ok(());};
        let mut ids=HashSet::new();
        for member in cast.iter(){
            for binding in std::iter::once(member).chain(member["sceneOverrides"].as_array().into_iter().flatten()){
                if let Some(id)=binding["voiceId"].as_str(){ids.insert(id.to_string());}
            }
        }
        if ids.len()>MAX_ITEMS{return Err("Keep distinct cast voices within the local 10,000-voice limit.".into());}
        let values=self.voice_observations(&ids.into_iter().collect::<Vec<_>>())?;
        let observations=values.as_array().ok_or("The voice source cache is damaged.")?.iter().map(|value|Ok((identifier(value,"id")?.to_string(),value))).collect::<Result<std::collections::HashMap<_,_>,String>>()?;
        for member in cast{
            pin_binding(member,&observations);
            if let Some(overrides)=member.get_mut("sceneOverrides").and_then(Value::as_array_mut){for binding in overrides{pin_binding(binding,&observations);}}
        }
        Ok(())
    }
}

fn pin_binding(binding:&mut Value,observations:&std::collections::HashMap<String,&Value>){
    let Some(object)=binding.as_object_mut()else{return;};
    let id=object.get("voiceId").and_then(Value::as_str).map(str::to_string);
    if object.get("voiceObservation").is_some_and(|observation|Some(&observation["id"])!=object.get("voiceId")){object.remove("voiceObservation");}
    if !object.contains_key("voiceObservation"){
        if let Some(observation)=id.as_ref().and_then(|id|observations.get(id)){object.insert("voiceObservation".into(),(*observation).clone());}
    }
}
