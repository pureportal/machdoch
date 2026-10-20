use super::*;

const PROJECT_FILTER:&str="WHERE deleted=0 AND (?1 IS NULL OR archived=?1) AND (instr(lower(title),lower(?2))>0 OR instr(lower(json_extract(data,'$.source')),lower(?2))>0) AND (?3 IS NULL OR id=?3)";

fn page(input:&Value)->Result<(i64,i64),String>{
    let offset=input["offset"].as_u64().filter(|offset|*offset<=9_007_199_254_740_991).ok_or("Choose a nonnegative whole-number history offset.")?;
    let limit=input["limit"].as_u64().filter(|limit|(1..=100).contains(limit)).ok_or("Read between 1 and 100 history entries per page.")?;
    Ok((offset as i64,limit as i64))
}

fn ensure_project(connection:&Connection,id:&str)->Result<(),String>{
    let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND deleted=0)",[id],|row|row.get(0)).map_err(error)?;
    if !exists{return Err("This speech project is unavailable. Reopen the project list.".into());}Ok(())
}

pub fn projects(store:&SpeechStore,input:&Value)->Result<Value,String>{
    fields(input,&["search","archived","id","offset","limit"])?;let (offset,limit)=page(input)?;
    let search=optional_text(input,"search",1024)?.unwrap_or_default();let archived=optional_bool(input,"archived")?;
    let id=input.get("id").map(|_|identifier(input,"id")).transpose()?;
    let transaction=store.connection.unchecked_transaction().map_err(error)?;
    let total:i64=transaction.query_row(&format!("SELECT count(*) FROM projects {PROJECT_FILTER}"),params![archived,search,id],|row|row.get(0)).map_err(error)?;
    let mut statement=transaction.prepare(&format!("SELECT id,title,revision_id,updated_at,archived,profile_id,json_extract(data,'$.location') FROM projects {PROJECT_FILTER} ORDER BY updated_at DESC,id LIMIT ?4 OFFSET ?5")).map_err(error)?;
    let rows=statement.query_map(params![archived,search,id,limit,offset],|row|Ok(json!({"id":row.get::<_,String>(0)?,"title":row.get::<_,String>(1)?,"revisionId":row.get::<_,String>(2)?,"updatedAt":row.get::<_,String>(3)?,"archived":row.get::<_,bool>(4)?,"profileId":row.get::<_,Option<String>>(5)?,"location":row.get::<_,Option<String>>(6)?}))).map_err(error)?;
    let projects=rows.collect::<Result<Vec<_>,_>>().map_err(error)?;drop(statement);transaction.commit().map_err(error)?;Ok(json!({"projects":projects,"offset":offset,"limit":limit,"total":total}))
}

pub fn revisions(store:&SpeechStore,input:&Value)->Result<Value,String>{
    fields(input,&["projectId","offset","limit"])?;let (offset,limit)=page(input)?;let id=identifier(input,"projectId")?;
    let transaction=store.connection.unchecked_transaction().map_err(error)?;ensure_project(&transaction,id)?;
    let total:i64=transaction.query_row("SELECT count(*) FROM revisions WHERE project_id=?1",[id],|row|row.get(0)).map_err(error)?;
    let mut statement=transaction.prepare("SELECT id,parent_id,project_id,created_at,content_hash FROM revisions WHERE project_id=?1 ORDER BY rowid DESC LIMIT ?2 OFFSET ?3").map_err(error)?;
    let rows=statement.query_map(params![id,limit,offset],|row|Ok(json!({"id":row.get::<_,String>(0)?,"parentId":row.get::<_,Option<String>>(1)?,"projectId":row.get::<_,String>(2)?,"createdAt":row.get::<_,String>(3)?,"contentHash":row.get::<_,String>(4)?}))).map_err(error)?;
    let revisions=rows.collect::<Result<Vec<_>,_>>().map_err(error)?;drop(statement);transaction.commit().map_err(error)?;Ok(json!({"revisions":revisions,"offset":offset,"limit":limit,"total":total}))
}

pub fn revision(store:&SpeechStore,input:&Value)->Result<Value,String>{
    fields(input,&["projectId","revisionId"])?;let project=identifier(input,"projectId")?;let id=identifier(input,"revisionId")?;
    store.connection.query_row("SELECT r.id,r.parent_id,r.project_id,r.created_at,r.source,r.content_hash FROM revisions r JOIN projects p ON p.id=r.project_id AND p.deleted=0 WHERE r.project_id=?1 AND r.id=?2",params![project,id],|row|Ok(json!({"id":row.get::<_,String>(0)?,"parentId":row.get::<_,Option<String>>(1)?,"projectId":row.get::<_,String>(2)?,"createdAt":row.get::<_,String>(3)?,"source":row.get::<_,String>(4)?,"contentHash":row.get::<_,String>(5)?}))).optional().map_err(error)?.ok_or_else(||"This project revision is unavailable. Reload its history.".into())
}
