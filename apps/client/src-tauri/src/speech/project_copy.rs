use super::*;

impl SpeechStore {
    pub(super) fn duplicate_project(&mut self, input: &Value) -> Result<Value,String> {
        fields(input,&["id","expectedRevisionId","title"])?;
        let id=identifier(input,"id")?;
        let revision=identifier(input,"expectedRevisionId")?;
        let title=text(input,"title",1,1024)?;
        if title.trim().is_empty() { return Err("Enter a name for the copied project.".into()); }
        let source=self.project(id)?;
        if source["revisionId"]!=revision { return Err("The source project changed. Reload it before duplicating.".into()); }
        let mut manifest=self.portable_snapshot(id,revision)?;
        let now=timestamp();
        let head=manifest["revisions"].as_array_mut().ok_or("The source project history is invalid.")?.iter_mut().find(|value|value["revisionId"]==revision).ok_or("The source project revision is missing.")?;
        head["title"]=json!(title.trim());head["archived"]=json!(false);head["updatedAt"]=json!(now);
        manifest["project"]=head.clone();
        self.commit_portable_snapshot(&manifest)
    }
}
