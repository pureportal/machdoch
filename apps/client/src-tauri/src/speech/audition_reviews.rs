use super::*;

pub fn list(store:&SpeechStore,input:&Value)->Result<Value,String>{
    fields(input,&["voiceId","language","verdict","offset","limit"])?;
    let voice=optional_text(input,"voiceId",256)?.unwrap_or_default();let language=optional_text(input,"language",64)?.unwrap_or_default();
    if !language.bytes().all(|byte|byte.is_ascii_alphanumeric()||byte==b'-'){return Err("Search by a spoken language tag such as de or de-DE.".into());}
    let verdict=optional_text(input,"verdict",16)?.unwrap_or_default();if !matches!(verdict,""|"approved"|"rejected"){return Err("Choose approved, needs work, or all listening reviews.".into());}
    let offset=unsigned(input,"offset",i64::MAX as u64)?;let limit=unsigned(input,"limit",100)?;if limit==0{return Err("Read 1 to 100 listening reviews per page.".into());}
    let filter="FROM projects p,json_each(p.data,'$.voiceAuditions') r WHERE p.deleted=0 AND (?1='' OR json_extract(r.value,'$.voiceId')=?1) AND (?2='' OR lower(json_extract(r.value,'$.language'))=lower(?2) OR instr(lower(json_extract(r.value,'$.language')),lower(?2)||'-')=1) AND (?3='' OR json_extract(r.value,'$.verdict')=?3)";
    let total:i64=store.connection.query_row(&format!("SELECT count(*) {filter}"),params![voice,language,verdict],|row|row.get(0)).map_err(error)?;
    let mut statement=store.connection.prepare(&format!("SELECT p.id,p.title,r.value {filter} ORDER BY json_extract(r.value,'$.reviewedAt') DESC,p.id,r.key LIMIT ?4 OFFSET ?5")).map_err(error)?;
    let rows=statement.query_map(params![voice,language,verdict,limit as i64,offset as i64],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(error)?;
    let mut output=Vec::new();
    for row in rows{
        let (project_id,title,data)=row.map_err(error)?;let review=parse_json(data)?;validate_records(&json!({"voiceAuditions":[review]}))?;
        let proof:Option<(String,String)>=store.connection.query_row("SELECT json_object('id',t.id,'asset',json_object('id',t.asset_id,'sha256',json_extract(t.data,'$.asset.sha256'),'duration',json_extract(t.data,'$.asset.duration')),'requestHash',json_extract(t.data,'$.requestHash'),'backend',json_extract(t.data,'$.backend'),'model',json_extract(t.data,'$.model'),'generatedAt',json_extract(t.data,'$.generatedAt')),json_object('segment',json_object('voiceIds',json_extract(q.data,'$.segment.voiceIds'))) FROM takes t JOIN take_requests q ON q.take_id=t.id WHERE t.id=?1 AND t.project_id=?2",params![identifier(&review,"takeId")?,project_id],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(error)?;
        let (take,request)=proof.ok_or("A listening review has no matching source take or generation request. Open its project to review the stored evidence.")?;validate_evidence(&review,&parse_json(take)?,&parse_json(request)?)?;
        output.push(json!({"projectId":project_id,"projectTitle":title,"review":review}));
    }
    Ok(json!({"reviews":output,"total":total}))
}

pub fn validate_records(project:&Value)->Result<(),String>{
    let Some(reviews)=project.get("voiceAuditions")else{return Ok(())};
    let reviews=reviews.as_array().filter(|reviews|reviews.len()<=MAX_ITEMS).ok_or("Keep listening reviews within the project record limit.")?;
    let mut ids=HashSet::new();
    for review in reviews{
        fields(review,&["id","takeId","voiceId","language","reviewer","reviewedAt","listened","verdict","note","assetId","audioSha256","requestHash","backend","model","generatedAt"])?;
        if !ids.insert(identifier(review,"id")?){return Err("Use distinct listening review IDs.".into());}
        identifier(review,"takeId")?;
        asset_identifier(required(review,"assetId")?)?;
        for field in ["audioSha256","requestHash"]{asset_identifier(required(review,field)?)?;}
        text(review,"voiceId",1,256)?;text(review,"model",1,512)?;backend(review)?;
        text(review,"reviewer",1,256)?;text(review,"note",0,4096)?;
        let language=text(review,"language",2,64)?;
        let mut parts=language.split('-');
        let primary=parts.next().ok_or("Enter a spoken language tag.")?;
        if !(2..=8).contains(&primary.len())||!primary.bytes().all(|byte|byte.is_ascii_alphabetic())||matches!(primary.to_ascii_lowercase().as_str(),"und"|"mul"|"zxx")||parts.any(|part|part.is_empty()||part.len()>8||!part.bytes().all(|byte|byte.is_ascii_alphanumeric())){return Err("Enter the specific spoken language tag you reviewed.".into());}
        if review["listened"]!=true||!matches!(review["verdict"].as_str(),Some("approved"|"rejected")){return Err("Confirm listening and record a review verdict.".into());}
        if parse_time(text(review,"reviewedAt",1,128)?)?<parse_time(text(review,"generatedAt",1,128)?)?{return Err("A listening review cannot precede generation.".into());}
    }
    Ok(())
}

pub fn validate_evidence(review:&Value,take:&Value,request:&Value)->Result<(),String>{
    for (field,value) in [("takeId",&take["id"]),("assetId",&take["asset"]["id"]),("audioSha256",&take["asset"]["sha256"]),("requestHash",&take["requestHash"]),("backend",&take["backend"]),("model",&take["model"]),("generatedAt",&take["generatedAt"]) ]{
        if &review[field]!=value{return Err("A listening review differs from its immutable take evidence.".into());}
    }
    if request["segment"]["voiceIds"].as_array().is_none_or(|voices|voices.len()!=1||voices[0]!=review["voiceId"])||take["asset"]["duration"].as_f64().is_none_or(|duration|duration<=0.0){return Err("Review a completed take with exactly one provider voice.".into());}
    Ok(())
}
